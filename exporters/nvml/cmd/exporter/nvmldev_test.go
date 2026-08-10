package main

import (
	"testing"

	"github.com/NVIDIA/go-nvml/pkg/nvml"
)

// TestSupportFromMapsReturnCodes locks down the three-way mapping that keeps
// gpu_metric_supported trustworthy. Collapsing the "any other error" branch
// into "unsupported" (e.g. by writing `ret != nvml.SUCCESS`) turns a
// transient failure (driver busy, device lost, permission) into a permanent,
// false "this hardware cannot do it" claim recorded in a series the
// dashboard presents as fact.
func TestSupportFromMapsReturnCodes(t *testing.T) {
	tests := []struct {
		name          string
		ret           nvml.Return
		wantSupported bool
		wantKnown     bool
	}{
		{"success", nvml.SUCCESS, true, true},
		{"not supported", nvml.ERROR_NOT_SUPPORTED, false, true},
		{"unknown error", nvml.ERROR_UNKNOWN, false, false},
		{"gpu is lost", nvml.ERROR_GPU_IS_LOST, false, false},
		{"no permission", nvml.ERROR_NO_PERMISSION, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotSupported, gotKnown := supportFrom(tt.ret)
			if gotSupported != tt.wantSupported || gotKnown != tt.wantKnown {
				t.Errorf("supportFrom(%v) = (%v, %v), want (%v, %v)",
					tt.ret, gotSupported, gotKnown, tt.wantSupported, tt.wantKnown)
			}
		})
	}
}
