package collector

import "testing"

func TestSampleCarriesNameValueAndLabels(t *testing.T) {
	s := Sample{
		Name:   "nvml_gpu_utilization_ratio",
		Value:  0.4,
		Labels: map[string]string{"gpu_uuid": "GPU-1"},
	}
	if s.Name != "nvml_gpu_utilization_ratio" || s.Value != 0.4 {
		t.Fatalf("unexpected sample: %+v", s)
	}
	if s.Labels["gpu_uuid"] != "GPU-1" {
		t.Fatalf("missing label: %+v", s.Labels)
	}
}

func TestRatioConvertsPercentAndReportsAbsence(t *testing.T) {
	// An unsupported reading must be reported as absent, never as zero: a zero
	// is indistinguishable from a measurement (specs/02 § 5.2).
	if got, ok := Ratio(40); !ok || got != 0.4 {
		t.Fatalf("Ratio(40) = %v, %v; want 0.4, true", got, ok)
	}
	// 0% is what an IDLE GPU reports, and it is a real measurement. An
	// implementation using `percent <= 0` would pass every other case here
	// while making every idle GPU vanish from the metrics entirely.
	if got, ok := Ratio(0); !ok || got != 0 {
		t.Fatalf("Ratio(0) = %v, %v; want 0, true — zero is a measurement, not absence", got, ok)
	}
	if _, ok := Ratio(NotSupported); ok {
		t.Fatal("Ratio(NotSupported) must report absence")
	}
}

func TestBytesReportsAbsenceOnlyForNegativeValues(t *testing.T) {
	// A positive reading is a real measurement.
	if got, ok := Bytes(1024); !ok || got != 1024 {
		t.Fatalf("Bytes(1024) = %v, %v; want 1024, true", got, ok)
	}
	// A REAL zero — a live process using no memory right now — is still a
	// measurement and must be reported, exactly like Ratio(0). Conflating it
	// with "unmeasured" would make a genuinely idle-but-attributed pod vanish.
	if got, ok := Bytes(0); !ok || got != 0 {
		t.Fatalf("Bytes(0) = %v, %v; want 0, true — zero is a measurement, not absence", got, ok)
	}
	if _, ok := Bytes(NotSupported); ok {
		t.Fatal("Bytes(NotSupported) must report absence")
	}
}
