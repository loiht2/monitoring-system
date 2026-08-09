package collector

// ProcSample is one process's readings on one device. SMUtil and MemUtil are
// percentages; NotSupported marks an absent reading.
type ProcSample struct {
	PID         uint32
	SMUtil      int
	MemUtil     int
	MemoryBytes float64
}

// Device is the slice of NVML the per-pod collector needs. Defined at the point
// of use, so tests need no GPU.
type Device interface {
	UUID() (string, bool)
	MIGEnabled() bool
	Processes() []ProcSample
}

// ResolvePID maps a host PID to (namespace, pod, container).
type ResolvePID func(pid uint32) (string, string, string)

type ProcessCollector struct {
	devices []Device
	resolve ResolvePID
}

func NewProcessCollector(devices []Device, resolve ResolvePID) *ProcessCollector {
	return &ProcessCollector{devices: devices, resolve: resolve}
}

type podKey struct{ uuid, namespace, pod, container string }

// Collect returns per-pod metrics. Values are summed per pod and the host PID is
// discarded before exposition (docs-internal/01 § 2.1).
//
// nvml_process_sm_utilization_ratio CAN exceed 1.0 for a pod: NVML reports each
// process's own SM-active share, and concurrent kernels from several processes
// overlap. 1.6 means "this pod's processes were collectively SM-active 160% of
// one process's worth", not a broken reading. Deliberately not clamped —
// clamping would hide that the pod is running several busy processes.
func (c *ProcessCollector) Collect() []Sample {
	var out []Sample

	for _, device := range c.devices {
		uuid, ok := device.UUID()
		if !ok {
			continue
		}
		mig := device.MIGEnabled()
		totals := make(map[podKey]map[string]float64)

		for _, proc := range device.Processes() {
			namespace, pod, container := c.resolve(proc.PID)
			key := podKey{uuid, namespace, pod, container}
			bucket, seen := totals[key]
			if !seen {
				bucket = make(map[string]float64)
				totals[key] = bucket
			}

			bucket["nvml_process_gpu_memory_bytes"] += proc.MemoryBytes

			if mig {
				// Utilization sampling is unsupported on MIG devices. Absent,
				// never zero.
				continue
			}
			if v, ok := Ratio(proc.SMUtil); ok {
				bucket["nvml_process_sm_utilization_ratio"] += v
			}
			if v, ok := Ratio(proc.MemUtil); ok {
				bucket["nvml_process_memory_utilization_ratio"] += v
			}
		}

		for key, metrics := range totals {
			for name, value := range metrics {
				// A FRESH map per Sample. sample.go documents that Labels is
				// owned by its Sample; sharing one map across the 2-3 Samples
				// of a pod would mean a later in-place edit to one silently
				// rewrote the others.
				out = append(out, Sample{Name: name, Value: value, Labels: map[string]string{
					"gpu_uuid":  key.uuid,
					"namespace": key.namespace,
					"pod":       key.pod,
					"container": key.container,
				}})
			}
		}
	}
	return out
}
