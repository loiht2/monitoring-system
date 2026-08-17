FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS build
WORKDIR /src
COPY main.cu .
# sm_80 is the A30's compute capability.
RUN nvcc -O3 -arch=sm_80 -o /api-exerciser main.cu

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
COPY --from=build /api-exerciser /usr/local/bin/api-exerciser
ENTRYPOINT ["/usr/local/bin/api-exerciser"]
