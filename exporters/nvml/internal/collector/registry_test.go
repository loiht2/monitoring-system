package collector

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

type stubCollector struct {
	rows  []Sample
	panic bool
}

func (s stubCollector) Collect() []Sample {
	if s.panic {
		panic("nvml gone")
	}
	return s.rows
}

func gatheredNames(t *testing.T, c prometheus.Collector) map[string]int {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	if err := reg.Register(c); err != nil {
		t.Fatal(err)
	}
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("gather failed: %v", err)
	}
	out := map[string]int{}
	for _, f := range families {
		out[f.GetName()] = len(f.GetMetric())
	}
	return out
}

func TestExposesEverySampleName(t *testing.T) {
	c := NewPrometheusAdapter([]Collector{stubCollector{rows: []Sample{
		{"nvml_gpu_utilization_ratio", 0.4, map[string]string{"gpu_uuid": "GPU-1"}},
	}}})
	if gatheredNames(t, c)["nvml_gpu_utilization_ratio"] != 1 {
		t.Fatal("metric missing from exposition")
	}
}

func TestAFailingCollectorDoesNotBlankTheScrape(t *testing.T) {
	// A stale target is visible; an empty one is indistinguishable from an
	// idle cluster.
	c := NewPrometheusAdapter([]Collector{
		stubCollector{panic: true},
		stubCollector{rows: []Sample{
			{"nvml_gpu_utilization_ratio", 0.4, map[string]string{"gpu_uuid": "GPU-1"}},
		}},
	})
	if gatheredNames(t, c)["nvml_gpu_utilization_ratio"] != 1 {
		t.Fatal("one bad collector blanked the scrape")
	}
}

func TestSamplesSharingANameShareALabelSet(t *testing.T) {
	// Describe is empty, so this adapter is registered unchecked and
	// checkDescConsistency never runs against it: differing label-key sets
	// under one name are not rejected. This test pins down what actually
	// happens instead — two samples sharing a name and differing only in
	// label values land as two distinct metrics in one family.
	c := NewPrometheusAdapter([]Collector{stubCollector{rows: []Sample{
		{"nvml_gpu_clock_hertz", 1, map[string]string{"gpu_uuid": "GPU-1", "clock": "sm"}},
		{"nvml_gpu_clock_hertz", 2, map[string]string{"gpu_uuid": "GPU-1", "clock": "mem"}},
	}}})
	if got := gatheredNames(t, c)["nvml_gpu_clock_hertz"]; got != 2 {
		t.Fatalf("clock family has %d metrics; want 2", got)
	}
}

func TestADuplicateSeriesDoesNotBlankTheScrape(t *testing.T) {
	// One collector emitting the same (name, label set) twice — e.g. a pod
	// visible through both HAMi annotations and DRA ResourceClaims — makes
	// checkMetricConsistency fail Gather(), and promhttp's default
	// HTTPErrorOnError then discards every family in the scrape, not just
	// the duplicated one. Deduping in Collect is what keeps an unrelated
	// metric in the same scrape alive.
	c := NewPrometheusAdapter([]Collector{stubCollector{rows: []Sample{
		{"gpu_alloc_device_pod_info", 1, map[string]string{"gpu_uuid": "GPU-1", "pod": "p1"}},
		{"gpu_alloc_device_pod_info", 1, map[string]string{"gpu_uuid": "GPU-1", "pod": "p1"}},
		{"nvml_gpu_power_watts", 250, map[string]string{"gpu_uuid": "GPU-1"}},
	}}})
	names := gatheredNames(t, c)
	if got := names["gpu_alloc_device_pod_info"]; got != 1 {
		t.Fatalf("gpu_alloc_device_pod_info has %d metrics; want 1 (duplicate not dropped)", got)
	}
	if got := names["nvml_gpu_power_watts"]; got != 1 {
		t.Fatalf("nvml_gpu_power_watts missing; want 1, got %d", got)
	}
}
