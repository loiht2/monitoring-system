FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS build
WORKDIR /src
COPY main.cu .
# sm_80 is the A30's compute capability.
RUN nvcc -O3 -arch=sm_80 -o /pipe-exerciser main.cu -lcublas

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
COPY --from=build /pipe-exerciser /usr/local/bin/pipe-exerciser
ENTRYPOINT ["/usr/local/bin/pipe-exerciser"]
