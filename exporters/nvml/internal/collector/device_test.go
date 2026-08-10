package collector

import (
	"strings"
	"testing"
)

type fakeStateDevice struct {
	uuid       string
	index      int
	state      DeviceState
	migUUID    string
	instanceID int
	isMIG      bool
}

func (d fakeStateDevice) UUID() (string, bool) { return d.uuid, true }
func (d fakeStateDevice) Index() int           { return d.index }
func (d fakeStateDevice) State() DeviceState   { return d.state }
func (d fakeStateDevice) MIGInfo() (string, int, bool) {
	if !d.isMIG {
		return "", 0, false
	}
	return d.migUUID, d.instanceID, true
}

func fullState() DeviceState {
	return DeviceState{
		GPUUtilPercent:   40,
		MemoryUsedBytes:  2 << 30,
		MemoryFreeBytes:  22 << 30,
		MemoryTotalBytes: 24 << 30,
		PowerMilliwatts:  120000,
		TemperatureC:     55,
		SMClockMHz:       1200,
		MemClockMHz:      877,
		EventReasons:     map[string]bool{"sw_power_cap": true, "hw_thermal_slowdown": false},
	}
}

func namesOf(rows []Sample) map[string]bool {
	out := map[string]bool{}
	for _, r := range rows {
		out[r.Name] = true
	}
	return out
}

func collectDevice(s DeviceState) []Sample {
	return NewDeviceCollector([]StateDevice{fakeStateDevice{uuid: "GPU-1", index: 0, state: s}}, "node-a").Collect()
}

func TestEmitsExactlyTheNVMLOwnedRows(t *testing.T) {
	want := map[string]bool{
		"nvml_gpu_utilization_ratio":          true,
		"nvml_gpu_memory_used_bytes":          true,
		"nvml_gpu_memory_free_bytes":          true,
		"nvml_gpu_memory_total_bytes":         true,
		"nvml_gpu_power_watts":                true,
		"nvml_gpu_temperature_celsius":        true,
		"nvml_gpu_clock_hertz":                true,
		"nvml_gpu_clocks_event_reason_active": true,
	}
	got := namesOf(collectDevice(fullState()))
	for n := range want {
		if !got[n] {
			t.Errorf("missing %s", n)
		}
	}
	for n := range got {
		if !want[n] {
			t.Errorf("unexpected metric %s", n)
		}
	}
}

func TestUnitsAreBaseUnits(t *testing.T) {
	for _, r := range collectDevice(fullState()) {
		switch {
		case r.Name == "nvml_gpu_utilization_ratio" && r.Value != 0.4:
			t.Errorf("utilization = %v; want 0.4", r.Value)
		case r.Name == "nvml_gpu_power_watts" && r.Value != 120:
			t.Errorf("power = %v W; want 120 (mW converted)", r.Value)
		case r.Name == "nvml_gpu_clock_hertz" && r.Labels["clock"] == "sm" && r.Value != 1.2e9:
			t.Errorf("sm clock = %v Hz; want 1.2e9 (MHz converted)", r.Value)
		}
	}
}

func TestBothClockDomainsAreEmitted(t *testing.T) {
	// The exact-name set check cannot see a missing LABEL VALUE. Dropping the
	// mem clock entirely leaves nvml_gpu_clock_hertz present via sm, so every
	// other test here still passes.
	seen := map[string]float64{}
	for _, r := range collectDevice(fullState()) {
		if r.Name == "nvml_gpu_clock_hertz" {
			seen[r.Labels["clock"]] = r.Value
		}
	}
	if seen["sm"] != 1.2e9 || seen["mem"] != 877e6 {
		t.Fatalf("both clock domains must be emitted with converted units, got %v", seen)
	}
}

func TestUnsupportedFieldIsAbsentNeverZero(t *testing.T) {
	s := fullState()
	s.PowerMilliwatts = NotSupported
	if namesOf(collectDevice(s))["nvml_gpu_power_watts"] {
		t.Fatal("unsupported power was emitted")
	}
}

func TestOneSeriesPerSupportedEventReason(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range collectDevice(fullState()) {
		if r.Name == "nvml_gpu_clocks_event_reason_active" {
			seen[r.Labels["reason"]] = true
		}
	}
	if !seen["sw_power_cap"] || !seen["hw_thermal_slowdown"] {
		t.Fatalf("reasons = %v", seen)
	}
}

func TestMIGInstanceCarriesParentGPUUUID(t *testing.T) {
	// A MIG instance's device-level series must carry gpu_uuid = the PARENT
	// physical GPU's UUID and mig_uuid = the instance's own UUID
	// (docs-internal/01-architecture.md §3.1). Putting the MIG UUID in
	// gpu_uuid instead (the observed defect) makes the series unjoinable to
	// DCGM, which only ever labels gpu_uuid with a physical UUID, and it
	// inflates GPU inventory counts computed as
	// count(count by (gpu_uuid) (...)).
	dev := fakeStateDevice{uuid: "GPU-parent", index: 1, state: fullState(), isMIG: true, migUUID: "MIG-instance"}
	rows := NewDeviceCollector([]StateDevice{dev}, "node-a").Collect()
	if len(rows) == 0 {
		t.Fatal("expected samples")
	}
	for _, r := range rows {
		if r.Labels["gpu_uuid"] != "GPU-parent" {
			t.Fatalf("gpu_uuid = %q; want parent UUID GPU-parent", r.Labels["gpu_uuid"])
		}
		if r.Labels["mig_uuid"] != "MIG-instance" {
			t.Fatalf("mig_uuid = %q; want MIG-instance", r.Labels["mig_uuid"])
		}
	}
}

func TestNonMIGDeviceHasNoMIGLabel(t *testing.T) {
	rows := collectDevice(fullState())
	for _, r := range rows {
		if _, present := r.Labels["mig_uuid"]; present {
			t.Fatalf("non-MIG device must not carry a mig_uuid key at all, got %+v", r.Labels)
		}
	}
}

func TestMIGInstanceEmitsGPUIID(t *testing.T) {
	// DCGM never publishes a MIG instance UUID on any series — it identifies
	// an instance only by GPU_I_ID within the parent card. So (gpu_uuid,
	// GPU_I_ID) is the only pair that reaches a DCGM MIG series; a join on
	// mig_uuid alone matches nothing. GPU_I_ID's value must be the decimal
	// string DCGM itself emits (e.g. "3"), not a formatted/padded variant.
	dev := fakeStateDevice{uuid: "GPU-parent", index: 1, state: fullState(), isMIG: true, migUUID: "MIG-instance", instanceID: 3}
	rows := NewDeviceCollector([]StateDevice{dev}, "node-a").Collect()
	if len(rows) == 0 {
		t.Fatal("expected samples")
	}
	for _, r := range rows {
		if r.Labels["GPU_I_ID"] != "3" {
			t.Fatalf("GPU_I_ID = %q; want \"3\"", r.Labels["GPU_I_ID"])
		}
	}
}

func TestNonMIGDeviceHasNoGPUIIDLabel(t *testing.T) {
	// Same rationale as TestMIGInstanceEmitsGPUIID: GPU_I_ID only means
	// something for a MIG instance, so a non-MIG device must not carry the
	// key at all (absence, not an empty/zero value).
	rows := collectDevice(fullState())
	for _, r := range rows {
		if _, present := r.Labels["GPU_I_ID"]; present {
			t.Fatalf("non-MIG device must not carry a GPU_I_ID key at all, got %+v", r.Labels)
		}
	}
}

func TestNoDCGMOwnedMetricIsEmitted(t *testing.T) {
	// PCIe, NVLink, C2C and every profiling-derived ratio belong to DCGM
	// (docs-internal/00 § 3). Emitting one would create a second source.
	for name := range namesOf(collectDevice(fullState())) {
		for _, forbidden := range []string{"pcie", "nvlink", "c2c", "sm_active", "occupancy", "tensor", "dram"} {
			if strings.Contains(name, forbidden) {
				t.Fatalf("%s crosses the DCGM boundary", name)
			}
		}
	}
}
