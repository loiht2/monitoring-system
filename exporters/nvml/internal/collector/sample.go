// Package collector turns NVML and Kubernetes state into Prometheus samples.
//
// Every collector returns []Sample rather than writing to a registry, so each
// one is testable against fakes with no GPU and no cluster.
package collector

// NotSupported marks a reading the hardware or driver does not provide.
// Deliberately not zero: a zero is indistinguishable from a real measurement
// and corrupts every average, rate and alert computed over the series
// (docs-internal/02 § 5.2).
const NotSupported = -1

// Sample is one metric value with its label set.
//
// Labels is owned by the Sample. Never build a second Sample by assigning an
// existing Labels map and adding a key — maps are references, so the mutation
// reaches back and rewrites the label set of every Sample already built from
// it. Copy the map first (see withLabel in device.go).
type Sample struct {
	Name   string
	Value  float64
	Labels map[string]string
}

// Ratio converts an NVML percentage to a 0-1 ratio. The second return is false
// when the reading is absent, in which case the caller must omit the metric.
func Ratio(percent int) (float64, bool) {
	if percent < 0 {
		return 0, false
	}
	return float64(percent) / 100.0, true
}
