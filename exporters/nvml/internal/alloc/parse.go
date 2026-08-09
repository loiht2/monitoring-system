// Package alloc parses GPU allocation state.
//
// Reimplemented in Go from the CNLab ML Platform control plane, quota_api/k8s.py
// @ 1dbe89b, whose docstrings record these schemas as confirmed against a live
// cluster. D-13: the language differs, the contract does not.
//
// Deliberate divergence: the upstream DRA reader sums consumed_capacity and
// discards results[].device. That identifier is this system's join key, so it is
// kept here; the capacity summing is not carried over, being no catalog
// requirement.
package alloc

import (
	"regexp"
	"sort"
	"strings"
)

const annotationSuffix = "vgpu-devices-allocated"

var uuidRe = regexp.MustCompile(`GPU-[0-9a-fA-F-]{8,}`)

// ClaimResult is one entry of ResourceClaim.status.allocation.devices.results.
type ClaimResult struct {
	Device string
	Pool   string
	Driver string
}

// DeviceUUIDsFromAnnotations returns EVERY device UUID in the HAMi allocation
// annotation, in order, or nil.
//
// A pod granted two GPUs carries both in one annotation, ";"-separated:
//   GPU-<uuid1>,NVIDIA,4096,50:;GPU-<uuid2>,NVIDIA,4096,50:;
// Returning only the first would leave the second GPU with no entitlement
// series at all — precisely the granted-but-idle case this exporter exists to
// surface.
//
// Matched by key SUFFIX because the prefix differs between HAMi variants. Keys
// are visited in sorted order: if a pod ever carried two matching keys, Go's
// random map order would make the reported UUID flip between scrapes, and a
// metric that changes without the underlying state changing is worse than one
// that is merely incomplete.
//
// Deliberately tolerant of format drift: any parse failure yields nil.
func DeviceUUIDsFromAnnotations(annotations map[string]string) []string {
	keys := make([]string, 0, len(annotations))
	for key := range annotations {
		if strings.HasSuffix(key, annotationSuffix) && annotations[key] != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)

	var out []string
	for _, key := range keys {
		for _, entry := range strings.Split(annotations[key], ";") {
			if m := uuidRe.FindString(entry); m != "" {
				out = append(out, m)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return out
}

// DevicesFromClaim returns the device names of an allocated claim.
func DevicesFromClaim(results []ClaimResult) []string {
	var out []string
	for _, r := range results {
		if r.Device != "" {
			out = append(out, r.Device)
		}
	}
	return out
}
