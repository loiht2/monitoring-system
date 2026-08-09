package collector

// Entitlement is one pod's grant of one device or MIG instance.
//
// Entitlement is not occupancy: a pod can hold a device with no live CUDA
// context, and that gap is the idle-GPU signal (docs-internal/01 § 2.4).
type Entitlement struct {
	GPUUUID   string
	MIGUUID   string
	Namespace string
	Pod       string
	Container string
	Source    string // "device-plugin" | "annotation" | "dra"
}

// AllocSource supplies entitlements. Implemented against the Kubernetes API in
// cmd/exporter; faked in tests.
type AllocSource interface {
	Entitlements() []Entitlement
}

type AllocCollector struct{ source AllocSource }

func NewAllocCollector(source AllocSource) *AllocCollector {
	return &AllocCollector{source: source}
}

// Collect emits one constant-1 info series per entitlement. All information is
// in the labels, and the labels are IDENTIFIERS ONLY.
func (c *AllocCollector) Collect() []Sample {
	var out []Sample
	for _, e := range c.source.Entitlements() {
		out = append(out, Sample{
			Name:  "gpu_alloc_device_pod_info",
			Value: 1,
			Labels: map[string]string{
				"gpu_uuid":     e.GPUUUID,
				"mig_uuid":     e.MIGUUID,
				"namespace":    e.Namespace,
				"pod":          e.Pod,
				"container":    e.Container,
				"alloc_source": e.Source,
			},
		})
	}
	return out
}
