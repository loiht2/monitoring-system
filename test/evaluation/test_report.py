from report import classify, metrics_from_panels


def test_extracts_metrics_per_dashboard():
    panels = {"dashboards": [{"uid": "d1", "rows": [{"panels": [
        {"targets": [{"expr": 'DCGM_FI_PROF_PIPE_FP64_ACTIVE{gpu_uuid=~"$gpu"}'}]}]}]}]}
    assert metrics_from_panels(panels) == {"DCGM_FI_PROF_PIPE_FP64_ACTIVE": ["d1"]}


def test_same_metric_on_two_dashboards_lists_both():
    t = [{"expr": "DCGM_FI_PROF_PIPE_INT_ACTIVE"}]
    panels = {"dashboards": [
        {"uid": "a", "rows": [{"panels": [{"targets": t}]}]},
        {"uid": "b", "rows": [{"panels": [{"targets": t}]}]}]}
    assert metrics_from_panels(panels)["DCGM_FI_PROF_PIPE_INT_ACTIVE"] == ["a", "b"]


def test_ignores_promql_functions_and_template_vars():
    panels = {"dashboards": [{"uid": "d", "rows": [{"panels": [
        {"targets": [{"expr": 'sum(rate(ebpf_cuda_kernel_launch_calls_total[$__rate_interval]))'}]}]}]}]}
    assert list(metrics_from_panels(panels)) == ["ebpf_cuda_kernel_launch_calls_total"]


def test_a_sample_in_the_window_is_observed():
    assert classify(samples=[(100.0, "0.42")], support=None)[0] == "OBSERVED"


def test_no_sample_with_a_zero_verdict_is_unsupported():
    # A pass, not a failure: the system correctly knows it cannot produce this.
    assert classify(samples=[], support=0.0)[0] == "UNSUPPORTED"


def test_no_sample_and_no_verdict_is_unverified():
    # The defect class. A blank panel with nothing explaining it.
    assert classify(samples=[], support=None)[0] == "UNVERIFIED"


def test_no_sample_but_supported_is_unverified_not_unsupported():
    # support==1 means it CAN produce data, so silence is unexplained.
    assert classify(samples=[], support=1.0)[0] == "UNVERIFIED"


def test_observed_reports_the_peak():
    assert classify(samples=[(1.0, "0.2"), (2.0, "0.9")], support=None)[1] == 0.9
