package collector

import "testing"

type fakeProcDevice struct {
	uuid  string
	mig   bool
	procs []ProcSample
}

func (d fakeProcDevice) UUID() (string, bool)    { return d.uuid, true }
func (d fakeProcDevice) MIGEnabled() bool        { return d.mig }
func (d fakeProcDevice) Processes() []ProcSample { return d.procs }

func resolver(pid uint32) (string, string, string) {
	switch pid {
	case 101, 102:
		return "ns-a", "pod-a", "main"
	case 103:
		return "ns-b", "pod-b", "main"
	}
	return "", "", ""
}

func find(t *testing.T, rows []Sample, name, pod string) Sample {
	t.Helper()
	for _, r := range rows {
		if r.Name == name && r.Labels["pod"] == pod {
			return r
		}
	}
	t.Fatalf("no sample %s for pod %s in %+v", name, pod, rows)
	return Sample{}
}

func TestTwoProcessesInOnePodProduceOneSummedSeries(t *testing.T) {
	dev := fakeProcDevice{uuid: "GPU-1", procs: []ProcSample{
		{PID: 101, SMUtil: 30, MemUtil: 10, MemoryBytes: 1000},
		{PID: 102, SMUtil: 20, MemUtil: 5, MemoryBytes: 2000},
	}}
	rows := NewProcessCollector([]Device{dev}, resolver).Collect()

	if got := find(t, rows, "nvml_process_sm_utilization_ratio", "pod-a").Value; got != 0.5 {
		t.Fatalf("sm utilization = %v; want 0.5 (summed per pod)", got)
	}
	if got := find(t, rows, "nvml_process_gpu_memory_bytes", "pod-a").Value; got != 3000 {
		t.Fatalf("memory = %v; want 3000", got)
	}
}

func TestNoSeriesCarriesAPIDLabel(t *testing.T) {
	dev := fakeProcDevice{uuid: "GPU-1", procs: []ProcSample{{PID: 101, SMUtil: 30, MemoryBytes: 1000}}}
	for _, r := range NewProcessCollector([]Device{dev}, resolver).Collect() {
		if _, bad := r.Labels["pid"]; bad {
			t.Fatalf("pid leaked as a label: %+v", r.Labels)
		}
	}
}

func TestMIGDeviceYieldsMemoryButNoUtilization(t *testing.T) {
	// Per-process utilization is unavailable on MIG devices; per-process
	// memory survives (docs-internal/02 § 3.2).
	dev := fakeProcDevice{uuid: "GPU-1", mig: true,
		procs: []ProcSample{{PID: 101, SMUtil: 30, MemoryBytes: 1000}}}
	for _, r := range NewProcessCollector([]Device{dev}, resolver).Collect() {
		if r.Name != "nvml_process_gpu_memory_bytes" {
			t.Fatalf("unexpected metric under MIG: %s", r.Name)
		}
	}
}

func TestUnresolvablePIDIsEmittedUnattributedNotDropped(t *testing.T) {
	dev := fakeProcDevice{uuid: "GPU-1", procs: []ProcSample{{PID: 999, SMUtil: 40, MemoryBytes: 500}}}
	rows := NewProcessCollector([]Device{dev}, resolver).Collect()
	if len(rows) == 0 {
		t.Fatal("measurement was dropped instead of emitted unattributed")
	}
	for _, r := range rows {
		if r.Labels["pod"] != "" {
			t.Fatalf("expected empty pod label, got %q", r.Labels["pod"])
		}
	}
}

func TestUnsupportedUtilizationEmitsNoSampleNotZero(t *testing.T) {
	// Ratio returns (value, ok); a caller that discards ok would emit 0 here,
	// which is indistinguishable from a genuinely idle process. This is the
	// collector-level enforcement of that rule — memory is still reported,
	// because only the utilization reading is absent.
	dev := fakeProcDevice{uuid: "GPU-1", procs: []ProcSample{
		{PID: 101, SMUtil: NotSupported, MemUtil: NotSupported, MemoryBytes: 1000},
	}}
	for _, r := range NewProcessCollector([]Device{dev}, resolver).Collect() {
		if r.Name != "nvml_process_gpu_memory_bytes" {
			t.Fatalf("unsupported reading was emitted as %s = %v", r.Name, r.Value)
		}
	}
}

func TestTwoDevicesDoNotMergeIntoOneSeries(t *testing.T) {
	// The whole point of this exporter is per-pod-per-GPU attribution. An
	// implementation that keyed totals without the device UUID would merge two
	// GPUs' usage into one series, and every other test here would still pass.
	devA := fakeProcDevice{uuid: "GPU-A", procs: []ProcSample{{PID: 101, SMUtil: 30, MemoryBytes: 1000}}}
	devB := fakeProcDevice{uuid: "GPU-B", procs: []ProcSample{{PID: 101, SMUtil: 50, MemoryBytes: 2000}}}
	rows := NewProcessCollector([]Device{devA, devB}, resolver).Collect()

	seen := map[string]float64{}
	for _, r := range rows {
		if r.Name == "nvml_process_sm_utilization_ratio" {
			seen[r.Labels["gpu_uuid"]] = r.Value
		}
	}
	if len(seen) != 2 {
		t.Fatalf("expected one series per GPU, got %v", seen)
	}
	if seen["GPU-A"] != 0.3 || seen["GPU-B"] != 0.5 {
		t.Fatalf("per-device values merged or wrong: %v", seen)
	}
}

func TestEachSampleOwnsItsLabelMap(t *testing.T) {
	// sample.go documents that Labels is owned by its Sample. If the collector
	// hands one map to several Samples, a later in-place edit to one rewrites
	// the others — silently, and no value assertion would notice.
	dev := fakeProcDevice{uuid: "GPU-1", procs: []ProcSample{{PID: 101, SMUtil: 30, MemoryBytes: 1000}}}
	rows := NewProcessCollector([]Device{dev}, resolver).Collect()
	if len(rows) < 2 {
		t.Fatalf("need at least two samples to test aliasing, got %d", len(rows))
	}
	rows[0].Labels["pod"] = "MUTATED"
	for _, r := range rows[1:] {
		if r.Labels["pod"] == "MUTATED" {
			t.Fatal("samples share one Labels map: mutating one rewrote another")
		}
	}
}

func TestPodWithNoLiveProcessProducesNoSeries(t *testing.T) {
	// Dropped, not zeroed: the series set must track reality.
	if rows := NewProcessCollector([]Device{fakeProcDevice{uuid: "GPU-1"}}, resolver).Collect(); len(rows) != 0 {
		t.Fatalf("expected no series, got %+v", rows)
	}
}
