// pipe-exerciser — drives exactly one GPU hardware pipe per invocation, so that
// a metric's rise during the run window is attributable to that pipe alone.
//
// Every CUDA and cuBLAS call is checked. On unexpected failure the program
// prints "mode=<mode> FAILED <api> <error>" and exits non-zero, so that a phase
// which could not run is never mistaken for a metric that did not appear.
//
// Runs unmodified on a whole card and on a MIG instance: nothing here assumes
// device count, VRAM size or a specific SM count, except the peer modes, which
// fail loudly when peer access is unavailable (that is a finding, not a no-op).

#include <cublas_v2.h>
#include <cuda_fp16.h>
#include <cuda_runtime.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

static const char* g_mode = "?";

static void fail(const char* api, const char* err) {
    printf("mode=%s FAILED %s %s\n", g_mode, api, err);
    fflush(stdout);
    exit(1);
}

#define CUDA_CHECK(call)                                                   \
    do {                                                                   \
        cudaError_t _e = (call);                                           \
        if (_e != cudaSuccess) fail(#call, cudaGetErrorString(_e));        \
    } while (0)

static const char* cublas_err(cublasStatus_t s) {
    switch (s) {
        case CUBLAS_STATUS_SUCCESS: return "SUCCESS";
        case CUBLAS_STATUS_NOT_INITIALIZED: return "NOT_INITIALIZED";
        case CUBLAS_STATUS_ALLOC_FAILED: return "ALLOC_FAILED";
        case CUBLAS_STATUS_INVALID_VALUE: return "INVALID_VALUE";
        case CUBLAS_STATUS_ARCH_MISMATCH: return "ARCH_MISMATCH";
        case CUBLAS_STATUS_MAPPING_ERROR: return "MAPPING_ERROR";
        case CUBLAS_STATUS_EXECUTION_FAILED: return "EXECUTION_FAILED";
        case CUBLAS_STATUS_INTERNAL_ERROR: return "INTERNAL_ERROR";
        case CUBLAS_STATUS_NOT_SUPPORTED: return "NOT_SUPPORTED";
        case CUBLAS_STATUS_LICENSE_ERROR: return "LICENSE_ERROR";
        default: return "UNKNOWN";
    }
}

#define CUBLAS_CHECK(call)                                                 \
    do {                                                                   \
        cublasStatus_t _s = (call);                                        \
        if (_s != CUBLAS_STATUS_SUCCESS) fail(#call, cublas_err(_s));      \
    } while (0)

// ---------------------------------------------------------------- timing loop

// Wall clock via CUDA events would measure GPU time only; the duration is a
// wall-clock budget, so use the host clock.
#include <chrono>
static std::chrono::steady_clock::time_point g_start;
static double g_budget = 90.0;

static void begin_timing(double seconds) {
    g_budget = seconds;
    g_start = std::chrono::steady_clock::now();
}

static bool time_left() {
    std::chrono::duration<double> d = std::chrono::steady_clock::now() - g_start;
    return d.count() < g_budget;
}

static double elapsed() {
    std::chrono::duration<double> d = std::chrono::steady_clock::now() - g_start;
    return d.count();
}

// -------------------------------------------------------------------- kernels

// A long dependent chain of integer multiply-adds. Dependent so the compiler
// cannot vectorize it away and the integer pipe stays busy rather than the
// memory pipe.
__global__ void int_chain_kernel(int* out, int n, int iters) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    int a = out[idx] | 1;
    int b = idx * 2654435761u + 1;
    for (int i = 0; i < iters; ++i) {
        a = a * 1103515245 + 12345;
        b = b * 22695477 + a;
        a ^= b >> 3;
    }
    out[idx] = a + b;
}

// Strided float4 read-modify-write, to saturate DRAM rather than L2.
__global__ void dram_rmw_kernel(float4* buf, size_t n4) {
    size_t stride = (size_t)gridDim.x * blockDim.x;
    for (size_t i = (size_t)blockIdx.x * blockDim.x + threadIdx.x; i < n4; i += stride) {
        float4 v = buf[i];
        v.x += 1.0f; v.y += 1.0f; v.z += 1.0f; v.w += 1.0f;
        buf[i] = v;
    }
}

// A long dependent chain of double-precision FMAs.
//
// MEASURED, not assumed: `cublasDgemm` under `CUBLAS_PEDANTIC_MATH` — what the
// plan specified for this mode — still runs on the A30's FP64 tensor cores.
// A 60s run gave DCGM_FI_PROF_PIPE_TENSOR_ACTIVE 0.99 and
// DCGM_FI_PROF_PIPE_FP64_ACTIVE 0.00025, at ~10.2 TFLOP/s, which is the DMMA
// rate and twice the A30's 5.2 TFLOP/s vector-FP64 rate. Pedantic math does not
// take Dgemm off the tensor cores here, so the FP64 pipe needs a kernel that
// has no tensor-core form at all. That is this. `tensor-dfma` keeps the
// cublasDgemm path, which is exactly the DMMA behaviour observed above.
__global__ void fp64_chain_kernel(double* out, int n, int iters) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    double a = out[idx] + 1.0;
    double b = 1.0000001;
    for (int i = 0; i < iters; ++i) {
        a = fma(a, 0.9999999, 1.0000001);
        b = fma(b, 0.9999998, 1.0000002);
    }
    out[idx] = a + b;
}

// Reads a buffer through a pointer that may be host-mapped or peer-resident;
// the point is where the pointer lives, not what the arithmetic is.
__global__ void remote_read_kernel(const float* src, size_t n, float* sink) {
    size_t stride = (size_t)gridDim.x * blockDim.x;
    float acc = 0.0f;
    for (size_t i = (size_t)blockIdx.x * blockDim.x + threadIdx.x; i < n; i += stride) {
        acc += src[i];
    }
    if (acc == 12345.6789f) *sink = acc;  // never true; keeps the loads live
}

// ---------------------------------------------------------------------- GEMMs

static const int N = 8192;

struct GemmBufs {
    void *a = nullptr, *b = nullptr, *c = nullptr;
};

static void alloc_gemm(GemmBufs& g, size_t elem) {
    size_t bytes = (size_t)N * N * elem;
    CUDA_CHECK(cudaMalloc(&g.a, bytes));
    CUDA_CHECK(cudaMalloc(&g.b, bytes));
    CUDA_CHECK(cudaMalloc(&g.c, bytes));
    CUDA_CHECK(cudaMemset(g.a, 1, bytes));
    CUDA_CHECK(cudaMemset(g.b, 1, bytes));
    CUDA_CHECK(cudaMemset(g.c, 0, bytes));
}

static void free_gemm(GemmBufs& g) {
    if (g.a) cudaFree(g.a);
    if (g.b) cudaFree(g.b);
    if (g.c) cudaFree(g.c);
}

static long long run_gemm(const std::string& mode) {
    cublasHandle_t h;
    CUBLAS_CHECK(cublasCreate(&h));

    GemmBufs g;
    long long iters = 0;

    if (mode == "tensor-dfma") {
        // DEFAULT math lets DMMA engage on the FP64 tensor cores. Measured: this
        // is what the card does with Dgemm regardless of math mode — see the
        // comment on fp64_chain_kernel.
        CUBLAS_CHECK(cublasSetMathMode(h, CUBLAS_DEFAULT_MATH));
        alloc_gemm(g, sizeof(double));
        double alpha = 1.0, beta = 0.0;
        while (time_left()) {
            CUBLAS_CHECK(cublasDgemm(h, CUBLAS_OP_N, CUBLAS_OP_N, N, N, N, &alpha,
                                     (const double*)g.a, N, (const double*)g.b, N,
                                     &beta, (double*)g.c, N));
            CUDA_CHECK(cudaDeviceSynchronize());
            ++iters;
        }
    } else if (mode == "fp32" || mode == "sustained") {
        CUBLAS_CHECK(cublasSetMathMode(h, CUBLAS_PEDANTIC_MATH));
        alloc_gemm(g, sizeof(float));
        float alpha = 1.0f, beta = 0.0f;
        while (time_left()) {
            CUBLAS_CHECK(cublasSgemm(h, CUBLAS_OP_N, CUBLAS_OP_N, N, N, N, &alpha,
                                     (const float*)g.a, N, (const float*)g.b, N,
                                     &beta, (float*)g.c, N));
            CUDA_CHECK(cudaDeviceSynchronize());
            ++iters;
        }
    } else if (mode == "fp16") {
        CUBLAS_CHECK(cublasSetMathMode(h, CUBLAS_PEDANTIC_MATH));
        alloc_gemm(g, sizeof(__half));
        __half alpha = __float2half(1.0f), beta = __float2half(0.0f);
        while (time_left()) {
            CUBLAS_CHECK(cublasHgemm(h, CUBLAS_OP_N, CUBLAS_OP_N, N, N, N, &alpha,
                                     (const __half*)g.a, N, (const __half*)g.b, N,
                                     &beta, (__half*)g.c, N));
            CUDA_CHECK(cudaDeviceSynchronize());
            ++iters;
        }
    } else if (mode == "tensor-hmma") {
        alloc_gemm(g, sizeof(__half));
        // alpha/beta must match the COMPUTE type, not the data type. Passing
        // float here compiles and returns SUCCESS but does not do the GEMM:
        // measured 25854 "iterations" in 4s, i.e. ~7000 TFLOP/s, which is not a
        // thing. With __half it settles at a believable rate.
        __half alpha = __float2half(1.0f), beta = __float2half(0.0f);
        while (time_left()) {
            CUBLAS_CHECK(cublasGemmEx(h, CUBLAS_OP_N, CUBLAS_OP_N, N, N, N, &alpha,
                                      g.a, CUDA_R_16F, N, g.b, CUDA_R_16F, N, &beta,
                                      g.c, CUDA_R_16F, N, CUBLAS_COMPUTE_16F,
                                      CUBLAS_GEMM_DEFAULT_TENSOR_OP));
            CUDA_CHECK(cudaDeviceSynchronize());
            ++iters;
        }
    } else if (mode == "tensor-imma") {
        // INT8 GEMM accumulating in INT32. cuBLAS requires the int8 operands be
        // column-major with lda a multiple of 4; N=8192 satisfies that.
        size_t bytes_in = (size_t)N * N;
        CUDA_CHECK(cudaMalloc(&g.a, bytes_in));
        CUDA_CHECK(cudaMalloc(&g.b, bytes_in));
        CUDA_CHECK(cudaMalloc(&g.c, bytes_in * sizeof(int)));
        CUDA_CHECK(cudaMemset(g.a, 1, bytes_in));
        CUDA_CHECK(cudaMemset(g.b, 1, bytes_in));
        CUDA_CHECK(cudaMemset(g.c, 0, bytes_in * sizeof(int)));
        int alpha = 1, beta = 0;
        while (time_left()) {
            CUBLAS_CHECK(cublasGemmEx(h, CUBLAS_OP_N, CUBLAS_OP_N, N, N, N, &alpha,
                                      g.a, CUDA_R_8I, N, g.b, CUDA_R_8I, N, &beta,
                                      g.c, CUDA_R_32I, N, CUBLAS_COMPUTE_32I,
                                      CUBLAS_GEMM_DEFAULT_TENSOR_OP));
            CUDA_CHECK(cudaDeviceSynchronize());
            ++iters;
        }
    } else {
        fail("run_gemm", "internal: unhandled gemm mode");
    }

    free_gemm(g);
    CUBLAS_CHECK(cublasDestroy(h));
    return iters;
}

// ------------------------------------------------------------- non-GEMM modes

static long long run_fp64() {
    const int n = 1 << 20;
    double* buf = nullptr;
    CUDA_CHECK(cudaMalloc((void**)&buf, (size_t)n * sizeof(double)));
    CUDA_CHECK(cudaMemset(buf, 0, (size_t)n * sizeof(double)));
    long long iters = 0;
    while (time_left()) {
        fp64_chain_kernel<<<n / 256, 256>>>(buf, n, 4096);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
        ++iters;
    }
    CUDA_CHECK(cudaFree(buf));
    return iters;
}

static long long run_int() {
    const int n = 1 << 22;
    int* buf = nullptr;
    CUDA_CHECK(cudaMalloc(&buf, (size_t)n * sizeof(int)));
    CUDA_CHECK(cudaMemset(buf, 1, (size_t)n * sizeof(int)));
    long long iters = 0;
    while (time_left()) {
        int_chain_kernel<<<n / 256, 256>>>(buf, n, 4096);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
        ++iters;
    }
    CUDA_CHECK(cudaFree(buf));
    return iters;
}

static long long run_dram(int device) {
    // Size the buffer at >= 2x L2 so the traffic reaches DRAM. Clamp to a
    // fraction of free VRAM so this also runs inside a 6 GiB MIG instance.
    cudaDeviceProp prop;
    CUDA_CHECK(cudaGetDeviceProperties(&prop, device));
    size_t want = (size_t)prop.l2CacheSize * 8;
    if (want < (64u << 20)) want = (64u << 20);
    size_t freeb = 0, totalb = 0;
    CUDA_CHECK(cudaMemGetInfo(&freeb, &totalb));
    size_t cap = freeb / 2;
    if (want > cap) want = cap;
    size_t n4 = want / sizeof(float4);
    if (n4 == 0) fail("run_dram", "no free VRAM for a DRAM buffer");

    float4* buf = nullptr;
    CUDA_CHECK(cudaMalloc(&buf, n4 * sizeof(float4)));
    CUDA_CHECK(cudaMemset(buf, 0, n4 * sizeof(float4)));
    printf("mode=%s dram buffer=%zu MiB (l2=%d KiB)\n", g_mode,
           (n4 * sizeof(float4)) >> 20, prop.l2CacheSize >> 10);

    int blocks = prop.multiProcessorCount * 32;
    long long iters = 0;
    while (time_left()) {
        dram_rmw_kernel<<<blocks, 256>>>(buf, n4);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
        ++iters;
    }
    CUDA_CHECK(cudaFree(buf));
    return iters;
}

static long long run_pcie(bool h2d) {
    size_t bytes = 512u << 20;
    size_t freeb = 0, totalb = 0;
    CUDA_CHECK(cudaMemGetInfo(&freeb, &totalb));
    if (bytes > freeb / 2) bytes = freeb / 2;  // fits a MIG instance too
    void* host = nullptr;
    void* dev = nullptr;
    CUDA_CHECK(cudaHostAlloc(&host, bytes, cudaHostAllocDefault));
    CUDA_CHECK(cudaMalloc(&dev, bytes));
    memset(host, 1, bytes);
    long long iters = 0;
    while (time_left()) {
        if (h2d) {
            CUDA_CHECK(cudaMemcpy(dev, host, bytes, cudaMemcpyHostToDevice));
        } else {
            CUDA_CHECK(cudaMemcpy(host, dev, bytes, cudaMemcpyDeviceToHost));
        }
        CUDA_CHECK(cudaDeviceSynchronize());
        ++iters;
    }
    CUDA_CHECK(cudaFree(dev));
    CUDA_CHECK(cudaFreeHost(host));
    printf("mode=%s buffer=%zu MiB\n", g_mode, bytes >> 20);
    return iters;
}

static long long run_hostmem(int device) {
    cudaDeviceProp prop;
    CUDA_CHECK(cudaGetDeviceProperties(&prop, device));
    size_t bytes = 256u << 20;
    float* host = nullptr;
    CUDA_CHECK(cudaHostAlloc((void**)&host, bytes, cudaHostAllocMapped));
    float* devptr = nullptr;
    CUDA_CHECK(cudaHostGetDevicePointer((void**)&devptr, host, 0));
    memset(host, 0, bytes);
    float* sink = nullptr;
    CUDA_CHECK(cudaMalloc(&sink, sizeof(float)));
    size_t n = bytes / sizeof(float);
    int blocks = prop.multiProcessorCount * 8;
    long long iters = 0;
    while (time_left()) {
        remote_read_kernel<<<blocks, 256>>>(devptr, n, sink);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
        ++iters;
    }
    CUDA_CHECK(cudaFree(sink));
    CUDA_CHECK(cudaFreeHost(host));
    return iters;
}

// Both peer modes share this precondition. Failing loudly here is deliberate:
// a silent no-op would be reported as "the metric did not appear".
static void require_peer(int local, int remote) {
    int count = 0;
    CUDA_CHECK(cudaGetDeviceCount(&count));
    if (count < 2) {
        printf("mode=%s FAILED peer-precondition only %d device(s) visible; "
               "peer access needs two\n", g_mode, count);
        exit(1);
    }
    int can = 0;
    CUDA_CHECK(cudaDeviceCanAccessPeer(&can, local, remote));
    if (!can) {
        printf("mode=%s FAILED cudaDeviceCanAccessPeer device %d cannot access "
               "device %d; peer access unavailable on this host\n",
               g_mode, local, remote);
        exit(1);
    }
}

static long long run_peer_copy(int local, int remote) {
    require_peer(local, remote);
    size_t bytes = 256u << 20;
    void* src = nullptr;
    void* dst = nullptr;
    CUDA_CHECK(cudaSetDevice(local));
    CUDA_CHECK(cudaMalloc(&src, bytes));
    CUDA_CHECK(cudaMemset(src, 1, bytes));
    cudaError_t e = cudaDeviceEnablePeerAccess(remote, 0);
    if (e != cudaSuccess && e != cudaErrorPeerAccessAlreadyEnabled)
        fail("cudaDeviceEnablePeerAccess", cudaGetErrorString(e));
    CUDA_CHECK(cudaSetDevice(remote));
    CUDA_CHECK(cudaMalloc(&dst, bytes));
    CUDA_CHECK(cudaSetDevice(local));
    long long iters = 0;
    while (time_left()) {
        CUDA_CHECK(cudaMemcpyPeer(dst, remote, src, local, bytes));
        CUDA_CHECK(cudaDeviceSynchronize());
        ++iters;
    }
    CUDA_CHECK(cudaFree(src));
    CUDA_CHECK(cudaSetDevice(remote));
    CUDA_CHECK(cudaFree(dst));
    CUDA_CHECK(cudaSetDevice(local));
    return iters;
}

static long long run_peermem(int local, int remote) {
    require_peer(local, remote);
    size_t bytes = 256u << 20;
    // The buffer is resident on the remote device; the kernel runs on the local
    // one and reads it over peer access.
    CUDA_CHECK(cudaSetDevice(remote));
    float* remote_buf = nullptr;
    CUDA_CHECK(cudaMalloc((void**)&remote_buf, bytes));
    CUDA_CHECK(cudaMemset(remote_buf, 0, bytes));
    CUDA_CHECK(cudaSetDevice(local));
    cudaError_t e = cudaDeviceEnablePeerAccess(remote, 0);
    if (e != cudaSuccess && e != cudaErrorPeerAccessAlreadyEnabled)
        fail("cudaDeviceEnablePeerAccess", cudaGetErrorString(e));
    float* sink = nullptr;
    CUDA_CHECK(cudaMalloc(&sink, sizeof(float)));
    cudaDeviceProp prop;
    CUDA_CHECK(cudaGetDeviceProperties(&prop, local));
    size_t n = bytes / sizeof(float);
    int blocks = prop.multiProcessorCount * 8;
    long long iters = 0;
    while (time_left()) {
        remote_read_kernel<<<blocks, 256>>>(remote_buf, n, sink);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
        ++iters;
    }
    CUDA_CHECK(cudaFree(sink));
    CUDA_CHECK(cudaSetDevice(remote));
    CUDA_CHECK(cudaFree(remote_buf));
    CUDA_CHECK(cudaSetDevice(local));
    return iters;
}

// ----------------------------------------------------------------------- main

static const char* kModes =
    "fp64 fp32 fp16 tensor-hmma tensor-imma tensor-dfma int dram-bandwidth "
    "pcie-h2d pcie-d2h peer-copy hostmem peermem sustained";

int main(int argc, char** argv) {
    std::string mode;
    double duration = 90.0;
    int device = 0;
    int peer = 1;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        const char* v = (i + 1 < argc) ? argv[i + 1] : nullptr;
        if (a == "--mode" && v) { mode = v; ++i; }
        else if (a == "--duration" && v) { duration = atof(v); ++i; }
        else if (a == "--device" && v) { device = atoi(v); ++i; }
        else if (a == "--peer-device" && v) { peer = atoi(v); ++i; }
        else {
            printf("usage: pipe-exerciser --mode <mode> [--duration secs] "
                   "[--device n] [--peer-device n]\nmodes: %s\n", kModes);
            return 2;
        }
    }
    if (mode.empty()) {
        printf("usage: pipe-exerciser --mode <mode> [--duration secs] "
               "[--device n] [--peer-device n]\nmodes: %s\n", kModes);
        return 2;
    }
    g_mode = mode.c_str();

    // Mapped host memory must be permitted before the context is created.
    CUDA_CHECK(cudaSetDeviceFlags(cudaDeviceMapHost));
    CUDA_CHECK(cudaSetDevice(device));

    cudaDeviceProp prop;
    CUDA_CHECK(cudaGetDeviceProperties(&prop, device));
    printf("mode=%s device=%d name=%s sm=%d.%d duration=%.0fs\n", g_mode, device,
           prop.name, prop.major, prop.minor, duration);
    fflush(stdout);

    begin_timing(duration);
    long long iters = 0;

    if (mode == "fp64") {
        iters = run_fp64();
    } else if (mode == "fp32" || mode == "fp16" || mode == "tensor-hmma" ||
               mode == "tensor-imma" || mode == "tensor-dfma" ||
               mode == "sustained") {
        iters = run_gemm(mode);
    } else if (mode == "int") {
        iters = run_int();
    } else if (mode == "dram-bandwidth") {
        iters = run_dram(device);
    } else if (mode == "pcie-h2d") {
        iters = run_pcie(true);
    } else if (mode == "pcie-d2h") {
        iters = run_pcie(false);
    } else if (mode == "peer-copy") {
        iters = run_peer_copy(device, peer);
    } else if (mode == "hostmem") {
        iters = run_hostmem(device);
    } else if (mode == "peermem") {
        iters = run_peermem(device, peer);
    } else {
        printf("mode=%s FAILED argument-parsing unknown mode; modes: %s\n",
               g_mode, kModes);
        return 2;
    }

    printf("mode=%s OK iterations=%lld elapsed=%.1fs\n", g_mode, iters, elapsed());
    return 0;
}
