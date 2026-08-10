# eBPF CUDA-tracing exporter

Built from two repositories, tracked as nested submodules:

    exporters/ebpf/eBPF-Lens          -> github.com/loiht2/eBPF-Lens
      └─ .obi-src                     -> github.com/loiht2/eBPF-Lens-core

The submodule pointers ARE the version pins. Do not record refs anywhere else.

## Making a change

A change is a three-step promotion, and skipping a hop loses it:

1. Edit the core (`.obi-src`), commit there.
2. Bump the agent's `.obi-src` pointer, commit there.
3. Bump this repository's `eBPF-Lens` pointer, commit here.

A change made only in the agent's vendored copy is lost at the next sync; a
change made only in the core never reaches a built image.

## Build

    git submodule update --init --recursive
    cd eBPF-Lens && make docker-build   # see the upstream Makefile for targets

CI checks out with `--recurse-submodules`; the image's provenance is the
submodule pointer pair.
