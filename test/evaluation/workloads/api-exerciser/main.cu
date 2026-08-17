// api-exerciser — drives exactly one CUDA API family per invocation, so that an
// eBPF metric family's appearance is attributable to that family alone.
//
// Raw CUDA only. No framework, and NO ALLOCATOR CACHING OF ANY KIND: the reason
// most eBPF families have never fired on this cluster is that PyTorch's caching
// allocator stops calling cudaMalloc after warm-up. An exerciser that pooled
// allocations would reproduce the exact blind spot it exists to eliminate.
//
// Every call is checked; on unexpected failure the program prints
// "mode=<mode> FAILED <api> <error>" and exits non-zero, so that a phase which
// could not run is never mistaken for a metric that did not appear. The sole
// exception is `errors`, whose job is to produce CUDA errors and which must
// therefore exit 0.
//
// Runs unmodified on a whole card and on a MIG instance: buffer sizes are
// clamped against free VRAM, and the peer mode fails loudly when peer access is
// unavailable rather than silently doing nothing.

#include <cuda_runtime.h>

#include <chrono>
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

static std::chrono::steady_clock::time_point g_start;
static double g_budget = 90.0;

static void begin_timing(double s) {
    g_budget = s;
    g_start = std::chrono::steady_clock::now();
}
static double elapsed() {
    std::chrono::duration<double> d = std::chrono::steady_clock::now() - g_start;
    return d.count();
}
static bool time_left() { return elapsed() < g_budget; }

// Cheap busy kernel: the point of the sync modes is the synchronization call,
// not the arithmetic, but there must be real work outstanding to wait on.
__global__ void busy_kernel(float* buf, size_t n, int iters) {
    size_t stride = (size_t)gridDim.x * blockDim.x;
    for (size_t i = (size_t)blockIdx.x * blockDim.x + threadIdx.x; i < n; i += stride) {
        float v = buf[i];
        for (int k = 0; k < iters; ++k) v = v * 1.000001f + 1.0f;
        buf[i] = v;
    }
}

static size_t clamp_to_free(size_t want) {
    size_t freeb = 0, totalb = 0;
    if (cudaMemGetInfo(&freeb, &totalb) != cudaSuccess) return want;
    size_t cap = freeb / 4;
    return want > cap ? cap : want;
}

// ------------------------------------------------------------------- the modes

// cudaMalloc then cudaFree, varying sizes 1 MiB - 256 MiB. Each iteration
// allocates fresh and frees immediately: no reuse, so every iteration is a real
// driver allocation the eBPF probe can see.
static long long run_malloc_free() {
    size_t sizes[9];
    size_t top = clamp_to_free(256u << 20);
    for (int i = 0; i < 9; ++i) {
        size_t s = (size_t)(1u << 20) << i;  // 1 MiB .. 256 MiB
        sizes[i] = s > top ? top : s;
    }
    long long iters = 0;
    int i = 0;
    while (time_left()) {
        void* p = nullptr;
        CUDA_CHECK(cudaMalloc(&p, sizes[i % 9]));
        CUDA_CHECK(cudaFree(p));
        ++i;
        ++iters;
    }
    return iters;
}

static long long run_memcpy(cudaMemcpyKind kind) {
    size_t bytes = clamp_to_free(64u << 20);
    void* host = nullptr;
    void* d1 = nullptr;
    void* d2 = nullptr;
    CUDA_CHECK(cudaHostAlloc(&host, bytes, cudaHostAllocDefault));
    memset(host, 1, bytes);
    CUDA_CHECK(cudaMalloc(&d1, bytes));
    if (kind == cudaMemcpyDeviceToDevice) CUDA_CHECK(cudaMalloc(&d2, bytes));
    long long iters = 0;
    while (time_left()) {
        switch (kind) {
            case cudaMemcpyHostToDevice:
                CUDA_CHECK(cudaMemcpy(d1, host, bytes, kind)); break;
            case cudaMemcpyDeviceToHost:
                CUDA_CHECK(cudaMemcpy(host, d1, bytes, kind)); break;
            default:
                CUDA_CHECK(cudaMemcpy(d2, d1, bytes, kind)); break;
        }
        ++iters;
    }
    CUDA_CHECK(cudaFree(d1));
    if (d2) CUDA_CHECK(cudaFree(d2));
    CUDA_CHECK(cudaFreeHost(host));
    return iters;
}

static long long run_memcpy_peer(int local, int remote) {
    int count = 0;
    CUDA_CHECK(cudaGetDeviceCount(&count));
    if (count < 2) {
        printf("mode=%s FAILED peer-precondition only %d device(s) visible; "
               "cudaMemcpyPeer needs two\n", g_mode, count);
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
    size_t bytes = clamp_to_free(64u << 20);
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

static long long run_memset(bool async) {
    size_t bytes = clamp_to_free(64u << 20);
    void* d = nullptr;
    CUDA_CHECK(cudaMalloc(&d, bytes));
    cudaStream_t stream = nullptr;
    if (async) CUDA_CHECK(cudaStreamCreate(&stream));  // non-default stream
    long long iters = 0;
    int v = 0;
    while (time_left()) {
        if (async) {
            CUDA_CHECK(cudaMemsetAsync(d, v & 0xff, bytes, stream));
            CUDA_CHECK(cudaStreamSynchronize(stream));
        } else {
            CUDA_CHECK(cudaMemset(d, v & 0xff, bytes));
        }
        ++v;
        ++iters;
    }
    if (stream) CUDA_CHECK(cudaStreamDestroy(stream));
    CUDA_CHECK(cudaFree(d));
    return iters;
}

// stream-sync / device-sync / event-sync / event-elapsed all launch the same
// kernel; the mode is which synchronization API waits for it.
enum SyncKind { SYNC_STREAM, SYNC_DEVICE, SYNC_EVENT, SYNC_ELAPSED };

static long long run_sync(SyncKind kind) {
    size_t n = clamp_to_free(16u << 20) / sizeof(float);
    float* d = nullptr;
    CUDA_CHECK(cudaMalloc((void**)&d, n * sizeof(float)));
    CUDA_CHECK(cudaMemset(d, 0, n * sizeof(float)));
    cudaStream_t stream;
    CUDA_CHECK(cudaStreamCreate(&stream));
    cudaEvent_t e0, e1;
    CUDA_CHECK(cudaEventCreate(&e0));
    CUDA_CHECK(cudaEventCreate(&e1));
    long long iters = 0;
    float total_ms = 0.0f;
    while (time_left()) {
        if (kind == SYNC_ELAPSED) CUDA_CHECK(cudaEventRecord(e0, stream));
        busy_kernel<<<256, 256, 0, stream>>>(d, n, 64);
        CUDA_CHECK(cudaGetLastError());
        switch (kind) {
            case SYNC_STREAM:
                CUDA_CHECK(cudaStreamSynchronize(stream));
                break;
            case SYNC_DEVICE:
                CUDA_CHECK(cudaDeviceSynchronize());
                break;
            case SYNC_EVENT:
                CUDA_CHECK(cudaEventRecord(e1, stream));
                CUDA_CHECK(cudaEventSynchronize(e1));
                break;
            case SYNC_ELAPSED: {
                CUDA_CHECK(cudaEventRecord(e1, stream));
                CUDA_CHECK(cudaEventSynchronize(e1));
                float ms = 0.0f;
                CUDA_CHECK(cudaEventElapsedTime(&ms, e0, e1));
                total_ms += ms;
                break;
            }
        }
        ++iters;
    }
    if (kind == SYNC_ELAPSED)
        printf("mode=%s measured=%.1fms total\n", g_mode, total_ms);
    CUDA_CHECK(cudaEventDestroy(e0));
    CUDA_CHECK(cudaEventDestroy(e1));
    CUDA_CHECK(cudaStreamDestroy(stream));
    CUDA_CHECK(cudaFree(d));
    return iters;
}

// Capture once, instantiate once, then launch the graph repeatedly — the metric
// of interest counts graph launches, not graph construction.
static long long run_graph_launch() {
    size_t n = clamp_to_free(16u << 20) / sizeof(float);
    float* d = nullptr;
    CUDA_CHECK(cudaMalloc((void**)&d, n * sizeof(float)));
    CUDA_CHECK(cudaMemset(d, 0, n * sizeof(float)));
    cudaStream_t stream;
    CUDA_CHECK(cudaStreamCreate(&stream));

    CUDA_CHECK(cudaStreamBeginCapture(stream, cudaStreamCaptureModeGlobal));
    for (int i = 0; i < 4; ++i) busy_kernel<<<256, 256, 0, stream>>>(d, n, 32);
    cudaGraph_t graph;
    CUDA_CHECK(cudaStreamEndCapture(stream, &graph));
    cudaGraphExec_t exec;
    CUDA_CHECK(cudaGraphInstantiate(&exec, graph, nullptr, nullptr, 0));

    long long iters = 0;
    while (time_left()) {
        CUDA_CHECK(cudaGraphLaunch(exec, stream));
        CUDA_CHECK(cudaStreamSynchronize(stream));
        ++iters;
    }
    CUDA_CHECK(cudaGraphExecDestroy(exec));
    CUDA_CHECK(cudaGraphDestroy(graph));
    CUDA_CHECK(cudaStreamDestroy(stream));
    CUDA_CHECK(cudaFree(d));
    return iters;
}

// Cycle grid, block and dynamic shared-memory sizes across a wide range, to
// fill the launch-dimension histogram buckets rather than pile into one.
static long long run_kernel_dims(int device) {
    cudaDeviceProp prop;
    CUDA_CHECK(cudaGetDeviceProperties(&prop, device));
    const int blocks[] = {1, 8, 64, 512, 4096, 32768};
    const int threads[] = {32, 64, 128, 256, 512, 1024};
    int shared[] = {0, 1024, 4096, 16384, 32768};
    int max_shared = (int)prop.sharedMemPerBlock;
    for (int i = 0; i < 5; ++i)
        if (shared[i] > max_shared) shared[i] = max_shared;

    size_t n = clamp_to_free(16u << 20) / sizeof(float);
    float* d = nullptr;
    CUDA_CHECK(cudaMalloc((void**)&d, n * sizeof(float)));
    CUDA_CHECK(cudaMemset(d, 0, n * sizeof(float)));
    long long iters = 0;
    int i = 0;
    while (time_left()) {
        int b = blocks[i % 6];
        int t = threads[(i / 6) % 6];
        int s = shared[(i / 36) % 5];
        busy_kernel<<<b, t, s>>>(d, n, 1);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
        ++i;
        ++iters;
    }
    CUDA_CHECK(cudaFree(d));
    return iters;
}

// The one mode that fails calls on purpose: an invalid launch (block size above
// the 1024 hardware limit) and an allocation far larger than VRAM, clearing the
// sticky error each time. It exits 0 — producing errors IS its job — so a
// non-zero exit here would mean the harness itself broke.
static long long run_errors() {
    size_t total = 0, freeb = 0;
    CUDA_CHECK(cudaMemGetInfo(&freeb, &total));
    size_t absurd = total * 64 + (1ull << 34);
    long long invalid_launches = 0, failed_allocs = 0;
    float* d = nullptr;
    CUDA_CHECK(cudaMalloc((void**)&d, 4096));

    while (time_left()) {
        // 2048 threads per block exceeds the 1024 limit on every current GPU.
        busy_kernel<<<1, 2048>>>(d, 1024, 1);
        cudaError_t e = cudaGetLastError();
        if (e == cudaSuccess) {
            printf("mode=%s FAILED invalid-launch expected a launch error for "
                   "2048 threads/block, got success\n", g_mode);
            exit(1);
        }
        ++invalid_launches;

        void* p = nullptr;
        e = cudaMalloc(&p, absurd);
        if (e == cudaSuccess) {
            printf("mode=%s FAILED oversized-alloc expected failure for %zu "
                   "bytes, got success\n", g_mode, absurd);
            cudaFree(p);
            exit(1);
        }
        ++failed_allocs;
        cudaGetLastError();  // clear

        // A working call between the failures, to prove the context survives.
        e = cudaMemset(d, 0, 4096);
        if (e != cudaSuccess) fail("cudaMemset-after-error", cudaGetErrorString(e));
    }
    cudaFree(d);
    printf("mode=%s invalid_launches=%lld failed_allocs=%lld\n", g_mode,
           invalid_launches, failed_allocs);
    return invalid_launches + failed_allocs;
}

// ----------------------------------------------------------------------- main

static const char* kModes =
    "malloc-free memcpy-h2d memcpy-d2h memcpy-d2d memcpy-peer memset-sync "
    "memset-async stream-sync device-sync event-sync event-elapsed "
    "graph-launch kernel-dims errors";

static void usage() {
    printf("usage: api-exerciser --mode <mode> [--duration secs] [--device n] "
           "[--peer-device n]\nmodes: %s\n", kModes);
}

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
        else { usage(); return 2; }
    }
    if (mode.empty()) { usage(); return 2; }
    g_mode = mode.c_str();

    CUDA_CHECK(cudaSetDevice(device));
    cudaDeviceProp prop;
    CUDA_CHECK(cudaGetDeviceProperties(&prop, device));
    printf("mode=%s device=%d name=%s sm=%d.%d duration=%.0fs\n", g_mode, device,
           prop.name, prop.major, prop.minor, duration);
    fflush(stdout);

    begin_timing(duration);
    long long iters = 0;

    if (mode == "malloc-free")        iters = run_malloc_free();
    else if (mode == "memcpy-h2d")    iters = run_memcpy(cudaMemcpyHostToDevice);
    else if (mode == "memcpy-d2h")    iters = run_memcpy(cudaMemcpyDeviceToHost);
    else if (mode == "memcpy-d2d")    iters = run_memcpy(cudaMemcpyDeviceToDevice);
    else if (mode == "memcpy-peer")   iters = run_memcpy_peer(device, peer);
    else if (mode == "memset-sync")   iters = run_memset(false);
    else if (mode == "memset-async")  iters = run_memset(true);
    else if (mode == "stream-sync")   iters = run_sync(SYNC_STREAM);
    else if (mode == "device-sync")   iters = run_sync(SYNC_DEVICE);
    else if (mode == "event-sync")    iters = run_sync(SYNC_EVENT);
    else if (mode == "event-elapsed") iters = run_sync(SYNC_ELAPSED);
    else if (mode == "graph-launch")  iters = run_graph_launch();
    else if (mode == "kernel-dims")   iters = run_kernel_dims(device);
    else if (mode == "errors")        iters = run_errors();
    else {
        printf("mode=%s FAILED argument-parsing unknown mode; modes: %s\n",
               g_mode, kModes);
        return 2;
    }

    printf("mode=%s OK iterations=%lld elapsed=%.1fs\n", g_mode, iters, elapsed());
    return 0;
}
