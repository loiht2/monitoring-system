FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO is required: go-nvml loads the driver library at runtime through cgo.
# The image therefore carries no CUDA or driver payload — the container runtime
# provides the driver.
RUN CGO_ENABLED=1 go build -trimpath -o /out/exporter ./cmd/exporter

FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=build /out/exporter /exporter
ENV LISTEN_PORT=9401
USER 65532:65532
ENTRYPOINT ["/exporter"]
