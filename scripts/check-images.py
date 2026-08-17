#!/usr/bin/env python3
"""Enforce the published-image contract on deployment manifests.
Usage: check-images.py <file>..."""
import re, sys, pathlib, yaml

# The images this repository builds and publishes (15 §1). The pin rule applies
# only to these: pinning an upstream image like grafana:11.6.1 is not this
# contract's business, and the evaluation exercisers are deliberately excluded.
PUBLISHED = ("nvml-exporter", "ebpf-gpu-exporter",
             "advanced-monitoring-api", "advanced-monitoring-ui")

# A digest, a vX.Y.Z release tag, or a 40-hex commit sha. Anything else can move
# underneath a running cluster.
PINNED = re.compile(r"^[^:@\s]+(?::(?:v\d+\.\d+\.\d+|[0-9a-f]{40})|@sha256:[0-9a-f]{64})$")

WORKFLOWS = pathlib.Path(__file__).resolve().parent.parent / ".github/workflows"


def _walk(node, key):
    """Every value stored under `key` at any depth. Manifests nest images under
    containers and initContainers alike, so a fixed path would miss some."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            else:
                yield from _walk(v, key)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item, key)


def is_published(image):
    return any(f"/{name}:" in image or f"/{name}@" in image or image.endswith(f"/{name}")
               for name in PUBLISHED)


def check(paths):
    fail = []
    for path in paths:
        for doc in yaml.safe_load_all(pathlib.Path(path).read_text()):
            if not doc:
                continue
            for image in _walk(doc, "image"):
                if not isinstance(image, str):
                    continue
                if "REPLACE_ME" in image:
                    fail.append(f"{path}: image '{image}' is still a placeholder")
                elif is_published(image) and not PINNED.match(image):
                    fail.append(f"{path}: image '{image}' is not pinned to a digest, "
                                f"release tag or commit sha")
            for _ in _walk(doc, "imagePullSecrets"):
                fail.append(f"{path}: declares imagePullSecrets — published images "
                            f"are public and need no credential")
    return fail


def check_workflows():
    """Every published image must be pushed by some workflow. Without this the
    manifests can reference a package that nothing ever builds."""
    text = "\n".join(p.read_text() for p in sorted(WORKFLOWS.glob("*.yml")))
    return [f"no workflow publishes '{name}'" for name in PUBLISHED if name not in text]


if __name__ == "__main__":
    problems = check(sys.argv[1:]) + check_workflows()
    for p in problems:
        print("FAIL:", p)
    print(f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)
