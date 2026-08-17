#!/usr/bin/env python3
"""Enforce the published-image contract on deployment manifests.
Usage: check-images.py <file>..."""
import re, sys, pathlib, yaml

# The images this repository builds and publishes (15 §1). The pin rule applies
# only to these: pinning an upstream image like grafana:11.6.1 is not this
# contract's business, and the evaluation exercisers are deliberately excluded.
PUBLISHED = ("nvml-exporter", "ebpf-gpu-exporter",
             "advanced-monitoring-api", "advanced-monitoring-ui")

# A digest, a vX.Y.Z release tag (a `-rc1`-style pre-release suffix is just as
# immutable), or a 40-hex commit sha. Anything else can move underneath a
# running cluster. Matched against the tag alone, never the whole reference:
# a registry port (ghcr.io:5000/...) puts a colon in the name.
PINNED = re.compile(r"^(?:v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[0-9a-f]{40}|sha256:[0-9a-f]{64})$")

WORKFLOWS = pathlib.Path(__file__).resolve().parent.parent / ".github/workflows"


def _walk(node, key):
    """Every value stored under `key` at any depth. Manifests nest images under
    containers and initContainers alike, so a fixed path would miss some.
    Known limitation: an image nested inside an embedded YAML/JSON string — a
    ConfigMap holding a manifest, say — is invisible here, because
    yaml.safe_load_all yields that whole value as one opaque string."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            else:
                yield from _walk(v, key)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item, key)


def split_ref(image):
    """(name, tag-or-digest) for an image reference. The digest wins if present;
    otherwise the tag is what follows the LAST colon, and only when that colon
    comes after the last slash — `ghcr.io:5000/x/y` has a port, not a tag."""
    if "@" in image:
        name, _, digest = image.partition("@")
        return name, digest
    head, sep, tail = image.rpartition(":")
    if sep and "/" not in tail:
        return head, tail
    return image, ""


def is_published(image):
    """One of ours, by exact match on the final path segment. Substring matching
    would let `nvml-exporter-test` inherit the rule and miss a bare name."""
    name, _ = split_ref(image)
    return name.rsplit("/", 1)[-1] in PUBLISHED


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
                elif is_published(image) and not PINNED.match(split_ref(image)[1]):
                    fail.append(f"{path}: image '{image}' is not pinned to a digest, "
                                f"release tag or commit sha")
            for _ in _walk(doc, "imagePullSecrets"):
                fail.append(f"{path}: declares imagePullSecrets — published images "
                            f"are public and need no credential")
    return fail


_MATRIX_REF = re.compile(r"\$\{\{\s*matrix\.(\w+)\s*\}\}")


def _expand(value, matrix):
    """`images: .../${{ matrix.name }}` names a real image only once the matrix
    is expanded, so substitute each include entry in turn."""
    if not matrix or not _MATRIX_REF.search(value):
        return [value]
    return [_MATRIX_REF.sub(lambda m: str(entry.get(m.group(1), "")), value)
            for entry in matrix]


def _names_in(value, matrix):
    """The published names a step's image/tag input resolves to. metadata-action
    emits one reference per line, so each line is considered separately."""
    found = set()
    for expanded in _expand(str(value), matrix):
        for line in expanded.splitlines():
            line = line.strip()
            if not line:
                continue
            name = split_ref(line)[0].rsplit("/", 1)[-1]
            if name in PUBLISHED:
                found.add(name)
    return found


def published_by(text):
    """The published images a workflow genuinely pushes. A bare mention — a
    matrix `context:`, an `if:` expression, a comment — must not count, so only
    a metadata-action's `images:` and the tag inputs of a step that actually
    pushes are read."""
    found = set()
    for doc in yaml.safe_load_all(text):
        if not isinstance(doc, dict):
            continue
        for job in (doc.get("jobs") or {}).values():
            if not isinstance(job, dict):
                continue
            matrix = ((job.get("strategy") or {}).get("matrix") or {}).get("include") or []
            for step in job.get("steps") or []:
                if not isinstance(step, dict):
                    continue
                uses, with_, env = step.get("uses", ""), step.get("with") or {}, step.get("env") or {}
                if "docker/metadata-action" in uses and "images" in with_:
                    found |= _names_in(with_["images"], matrix)
                # A step that pushes: build-push-action with push: true, or a
                # script that runs `docker push` off an IMG/TAGS environment.
                if "docker/build-push-action" in uses and with_.get("push") in (True, "true"):
                    found |= _names_in(with_.get("tags", ""), matrix)
                if "docker push" in str(step.get("run", "")):
                    for key in ("IMG", "TAGS", "tags"):
                        if key in env:
                            found |= _names_in(env[key], matrix)
    return found


def check_workflows():
    """Every published image must be pushed by some workflow. Without this the
    manifests can reference a package that nothing ever builds."""
    published = set()
    for path in sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml")):
        published |= published_by(path.read_text())
    return [f"no workflow publishes '{name}'" for name in PUBLISHED if name not in published]


if __name__ == "__main__":
    problems = check(sys.argv[1:]) + check_workflows()
    for p in problems:
        print("FAIL:", p)
    print(f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)
