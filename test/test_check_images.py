import importlib.util, pathlib, tempfile

# Anchored to the repo root rather than the working directory — see test_check_dashboards.
ROOT = pathlib.Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    "check_images", ROOT / "scripts/check-images.py")
check_images = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_images)


def manifest(image, pull_secret=False):
    secrets = "      imagePullSecrets:\n        - name: harbor-pull-secret\n" if pull_secret else ""
    return (
        "apiVersion: apps/v1\n"
        "kind: DaemonSet\n"
        "metadata:\n"
        "  name: sample\n"
        "spec:\n"
        "  template:\n"
        "    spec:\n"
        f"{secrets}"
        "      containers:\n"
        "        - name: agent\n"
        f"          image: {image}\n"
    )


def run(image, pull_secret=False):
    with tempfile.TemporaryDirectory() as tmp:
        p = pathlib.Path(tmp) / "40-sample.yaml"
        p.write_text(manifest(image, pull_secret))
        return check_images.check([str(p)])


def test_placeholder_token_is_rejected():
    """REPLACE_ME means the manifest cannot be applied without an out-of-band
    edit — the exact friction this change removes."""
    assert any("placeholder" in f for f in run("REPLACE_ME"))


def test_mutable_tag_on_a_published_image_is_rejected():
    """build-nvml-exporter.yml records that a manifest must never reference a
    mutable tag: :latest silently changes what a deployed cluster is running."""
    assert any("not pinned" in f for f in run("ghcr.io/loiht2/nvml-exporter:latest"))


def test_release_tag_is_accepted():
    assert not run("ghcr.io/loiht2/nvml-exporter:v1.0.0")


def test_commit_sha_tag_is_accepted():
    assert not run("ghcr.io/loiht2/nvml-exporter:" + "a" * 40)


def test_digest_is_accepted():
    assert not run("ghcr.io/loiht2/nvml-exporter@sha256:" + "b" * 64)


def test_third_party_image_is_not_subject_to_the_pin_rule():
    """Pinning upstream images is not this contract's business — grafana:11.6.1
    carries no `v` prefix and must not be reported."""
    assert not run("grafana/grafana:11.6.1")


def test_pull_secret_is_rejected():
    """A public image needs no credential; a leftover imagePullSecrets makes the
    manifest fail on any cluster that lacks that secret."""
    assert any("imagePullSecrets" in f for f in run("ghcr.io/loiht2/nvml-exporter:v1.0.0",
                                                    pull_secret=True))


def test_every_published_image_has_a_publishing_workflow():
    """The set the spec promises to publish, checked against the workflows that
    actually push. A name in one and not the other is a broken promise."""
    assert not check_images.check_workflows()


def test_registryless_published_name_is_still_subject_to_the_pin_rule():
    """A bare name is still one of our images. Letting it skip the pin rule is
    how a mutable tag gets into deploy/ with the checker green."""
    assert any("not pinned" in f for f in run("nvml-exporter:latest"))


def test_prerelease_tag_is_accepted():
    """v1.0.0-rc1 is as immutable as v1.0.0 — rejecting it would push people
    toward a mutable tag instead."""
    assert not run("ghcr.io/loiht2/nvml-exporter:v1.0.0-rc1")


def test_registry_port_does_not_defeat_the_pin_rule():
    """The registry's port colon must not be mistaken for the tag separator."""
    assert not run("ghcr.io:5000/loiht2/nvml-exporter:v1.0.0")


def test_workflow_that_only_mentions_an_image_does_not_count_as_publishing_it():
    """A matrix `context:` line or a comment mentioning the name must not
    satisfy the check — only a step that actually pushes the image does."""
    import textwrap
    with tempfile.TemporaryDirectory() as tmp:
        wf = pathlib.Path(tmp) / "sham.yml"
        wf.write_text(textwrap.dedent("""\
            name: sham
            on: {push: {}}
            jobs:
              build:
                runs-on: ubuntu-latest
                steps:
                  - run: echo building nvml-exporter and advanced-monitoring-ui
            """))
        assert check_images.published_by(wf.read_text()) == set()
