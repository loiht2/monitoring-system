package collector

import "testing"

type fakeAllocSource struct{ entitlements []Entitlement }

func (f fakeAllocSource) Entitlements() []Entitlement { return f.entitlements }

func TestEmitsOneInfoSeriesPerEntitlement(t *testing.T) {
	src := fakeAllocSource{[]Entitlement{
		{GPUUUID: "GPU-aaa", Namespace: "ns", Pod: "p1", Container: "main", Source: "annotation"},
	}}
	rows := NewAllocCollector(src).Collect()
	if len(rows) != 1 {
		t.Fatalf("rows = %+v", rows)
	}
	if rows[0].Name != "gpu_alloc_device_pod_info" || rows[0].Value != 1 {
		t.Fatalf("unexpected sample: %+v", rows[0])
	}
	if rows[0].Labels["gpu_uuid"] != "GPU-aaa" || rows[0].Labels["alloc_source"] != "annotation" {
		t.Fatalf("labels = %v", rows[0].Labels)
	}
}

func TestEveryEntitlementGetsItsOwnSeries(t *testing.T) {
	// A pod granted two GPUs, and a second pod on one of them. An
	// implementation that returned only the first entitlement, or that
	// collapsed them by pod, would pass every other test here.
	src := fakeAllocSource{[]Entitlement{
		{GPUUUID: "GPU-a", Namespace: "ns", Pod: "p1", Source: "annotation"},
		{GPUUUID: "GPU-b", Namespace: "ns", Pod: "p1", Source: "annotation"},
		{GPUUUID: "GPU-a", Namespace: "ns", Pod: "p2", Source: "dra"},
	}}
	rows := NewAllocCollector(src).Collect()
	if len(rows) != 3 {
		t.Fatalf("expected 3 series, got %d: %+v", len(rows), rows)
	}
	seen := map[string]bool{}
	for _, r := range rows {
		seen[r.Labels["gpu_uuid"]+"/"+r.Labels["pod"]+"/"+r.Labels["alloc_source"]] = true
	}
	for _, want := range []string{"GPU-a/p1/annotation", "GPU-b/p1/annotation", "GPU-a/p2/dra"} {
		if !seen[want] {
			t.Fatalf("missing series %s; got %v", want, seen)
		}
	}
}

func TestLabelsAreIdentifiersOnly(t *testing.T) {
	// No instance profile, no SM count: MIG catalog rows 1-2 are DCGM's
	// (specs/02 § 3.3).
	src := fakeAllocSource{[]Entitlement{{GPUUUID: "GPU-aaa", Namespace: "ns", Pod: "p1"}}}
	labels := NewAllocCollector(src).Collect()[0].Labels
	want := map[string]bool{
		"gpu_uuid": true, "mig_uuid": true, "namespace": true,
		"pod": true, "container": true, "alloc_source": true,
	}
	for k := range labels {
		if !want[k] {
			t.Errorf("unexpected label %q", k)
		}
	}
	if len(labels) != len(want) {
		t.Errorf("labels = %v; want exactly %v", labels, want)
	}
}

func TestNoEntitlementsProducesNoSeries(t *testing.T) {
	if rows := NewAllocCollector(fakeAllocSource{}).Collect(); len(rows) != 0 {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestMIGUUIDReachesTheLabel(t *testing.T) {
	// mig_uuid is the join key DCGM uses to attach its per-MIG-instance
	// (GPU_I entity) metrics to a pod. An implementation that hardcoded
	// the label to "" instead of e.MIGUUID would pass every other test in
	// this file while silently breaking all MIG attribution.
	src := fakeAllocSource{[]Entitlement{
		{GPUUUID: "GPU-aaa", MIGUUID: "MIG-8c1a5f3e-0d2b-4a77-9e61-3f4b8d2c7a19", Namespace: "ns", Pod: "p1", Container: "main", Source: "device-plugin"},
	}}
	rows := NewAllocCollector(src).Collect()
	if len(rows) != 1 {
		t.Fatalf("rows = %+v", rows)
	}
	if rows[0].Labels["mig_uuid"] != "MIG-8c1a5f3e-0d2b-4a77-9e61-3f4b8d2c7a19" {
		t.Fatalf("labels = %v", rows[0].Labels)
	}
}
