package collector

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
)

// Collector is anything that turns state into samples.
type Collector interface {
	Collect() []Sample
}

var help = map[string]string{
	"nvml_process_sm_utilization_ratio":     "Fraction of SM capacity used by this pod (0-1).",
	"nvml_process_memory_utilization_ratio": "Fraction of the period this pod was accessing device memory (0-1).",
	"nvml_process_gpu_memory_bytes":         "Device memory held by this pod.",
	"nvml_gpu_utilization_ratio":            "Fraction of the period one or more kernels was executing (0-1).",
	"nvml_gpu_memory_used_bytes":            "Device memory allocated.",
	"nvml_gpu_memory_free_bytes":            "Device memory available.",
	"nvml_gpu_memory_total_bytes":           "Total device memory.",
	"nvml_gpu_power_watts":                  "Board power draw.",
	"nvml_gpu_temperature_celsius":          "GPU core temperature.",
	"nvml_gpu_clock_hertz":                  "Current clock frequency of the named domain.",
	"nvml_gpu_clocks_event_reason_active":   "Whether the named clock-limiting reason is active.",
	"gpu_alloc_device_pod_info":             "Pod entitled to this device. Constant 1; information is in the labels.",
}

// PrometheusAdapter exposes our Samples through client_golang.
type PrometheusAdapter struct{ collectors []Collector }

func NewPrometheusAdapter(collectors []Collector) *PrometheusAdapter {
	return &PrometheusAdapter{collectors: collectors}
}

// Describe is intentionally empty: metric families come and go with the
// hardware and the workload, which is the point — absent, never zero.
func (a *PrometheusAdapter) Describe(chan<- *prometheus.Desc) {}

func (a *PrometheusAdapter) Collect(ch chan<- prometheus.Metric) {
	var rows []Sample
	for _, c := range a.collectors {
		rows = append(rows, safeCollect(c)...)
	}

	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		keys := make([]string, 0, len(row.Labels))
		for k := range row.Labels {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		values := make([]string, 0, len(keys))
		for _, k := range keys {
			values = append(values, row.Labels[k])
		}

		// Two independent collectors (or one, e.g. an allocation collector
		// merging HAMi-annotation and DRA-ResourceClaim entitlements) can
		// legitimately emit the same series twice. client_golang's
		// checkMetricConsistency rejects a duplicate at Gather() time and
		// promhttp's default error handling then blanks the whole scrape,
		// not just the offender — so dedup here, at the one funnel every
		// sample passes through, rather than in each collector.
		//
		// \xff in a label name/value byte set is invalid UTF-8 for
		// Prometheus labels, so using it as the field separator (and
		// prefixing each field with its length) makes the key injective:
		// no two distinct (name, keys, values) triples can produce the same
		// encoded string, unlike plain concatenation where {a:"b_c"} and
		// {a_b:"c"} would collide.
		var key strings.Builder
		key.WriteString(row.Name)
		for i, k := range keys {
			fmt.Fprintf(&key, "\xff%d:%s\xff%d:%s", len(k), k, len(values[i]), values[i])
		}
		if _, dup := seen[key.String()]; dup {
			slog.Warn("dropping duplicate series", "metric", row.Name)
			continue
		}
		seen[key.String()] = struct{}{}

		desc := prometheus.NewDesc(row.Name, helpFor(row.Name), keys, nil)
		metric, err := prometheus.NewConstMetric(desc, prometheus.GaugeValue, row.Value, values...)
		if err != nil {
			slog.Warn("dropping malformed sample", "metric", row.Name, "err", err)
			continue
		}
		ch <- metric
	}
}

// safeCollect isolates one collector's failure from the rest of the scrape.
func safeCollect(c Collector) (rows []Sample) {
	defer func() {
		if r := recover(); r != nil {
			slog.Warn("collector failed", "err", r)
			rows = nil
		}
	}()
	return c.Collect()
}

func helpFor(name string) string {
	if h, ok := help[name]; ok {
		return h
	}
	return name
}
