package alloc

import "testing"

func TestAnnotationMatchedBySuffixNotExactPrefix(t *testing.T) {
	// Covers both the classic HAMi prefix and the DRA fork's project-scoped one.
	for _, key := range []string{
		"hami.io/vgpu-devices-allocated",
		"other.example.com/vgpu-devices-allocated",
	} {
		got := DeviceUUIDsFromAnnotations(map[string]string{
			key: "GPU-26e02ca7-f4ba-b335-915c-2a8541deb8a4,NVIDIA,4096,50:;",
		})
		if len(got) != 1 || got[0] != "GPU-26e02ca7-f4ba-b335-915c-2a8541deb8a4" {
			t.Fatalf("key %s gave %v", key, got)
		}
	}
}

func TestMissingOrUnparseableAnnotationYieldsEmpty(t *testing.T) {
	if got := DeviceUUIDsFromAnnotations(nil); len(got) != 0 {
		t.Fatalf("nil annotations gave %v", got)
	}
	if got := DeviceUUIDsFromAnnotations(map[string]string{"hami.io/vgpu-devices-allocated": "!!!"}); len(got) != 0 {
		t.Fatalf("garbage gave %v", got)
	}
}

func TestBothGPUsOfAMultiDeviceAnnotationAreReturned(t *testing.T) {
	// A pod granted two GPUs carries both in one ";"-separated annotation.
	// Returning only the first leaves the second GPU with no entitlement
	// series — the exact granted-but-idle case this exporter exists to show.
	// The two UUIDs differ, which also proves the parser EXTRACTS rather than
	// returning a constant.
	got := DeviceUUIDsFromAnnotations(map[string]string{
		"hami.io/vgpu-devices-allocated": "GPU-26e02ca7-f4ba-b335-915c-2a8541deb8a4,NVIDIA,4096,50:;" +
			"GPU-a4d27439-566b-841c-428f-d87e73e4134e,NVIDIA,4096,50:;",
	})
	want := []string{
		"GPU-26e02ca7-f4ba-b335-915c-2a8541deb8a4",
		"GPU-a4d27439-566b-841c-428f-d87e73e4134e",
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v; want %v", got, want)
	}
}

func TestDRAResultsKeepTheDeviceIdentityUpstreamDiscards(t *testing.T) {
	// The upstream ML Platform reader sums consumed_capacity and throws away
	// results[].device, because it only ever needed "how much". That field is
	// our join key (specs/04 § 1.2).
	devices := DevicesFromClaim([]ClaimResult{
		{Device: "gpu-0", Pool: "node-a", Driver: "gpu.nvidia.com"},
		{Device: "", Pool: "node-a", Driver: "gpu.nvidia.com"},
	})
	if len(devices) != 1 || devices[0] != "gpu-0" {
		t.Fatalf("devices = %v", devices)
	}
}

func TestEmptyResultsYieldNoDevices(t *testing.T) {
	if devices := DevicesFromClaim(nil); len(devices) != 0 {
		t.Fatalf("devices = %v", devices)
	}
}
