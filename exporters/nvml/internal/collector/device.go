package collector

import "strconv"

// DeviceState is one device's readings. NotSupported marks an absent reading.
//
// Two absence conventions coexist here, deliberately. Percent-scale INT fields
// use Ratio(), which returns (value, ok). Unit-scale FLOAT64 fields (bytes, mW,
// MHz, celsius) carry NotSupported and are guarded with `>= 0`. A new field must
// pick the one matching its scale: `>= 0` is only safe because none of these
// units can be legitimately negative on this API.
type DeviceState struct {
	GPUUtilPercent   int
	MemoryUsedBytes  float64
	MemoryFreeBytes  float64
	MemoryTotalBytes float64
	PowerMilliwatts  float64
	TemperatureC     float64
	SMClockMHz       float64
	MemClockMHz      float64
	// EventReasons holds only the reasons the device reports as SUPPORTED. An
	// unsupported reason must be absent from the map, not present as false.
	EventReasons map[string]bool
	// Support records, per EXPOSED METRIC NAME, whether this GPU can produce
	// that metric — the gpu_metric_supported capability signal
	// (docs-internal/10-metric-support-signal.md). It maps an NVML return
	// code three ways, not two:
	//
	//   SUCCESS             -> true  (metric present in this DeviceState)
	//   ERROR_NOT_SUPPORTED -> false (recorded here as an explicit entry)
	//   any other error     -> no entry at all
	//
	// The third case is load-bearing: a transient failure (driver busy,
	// device lost, permission) is not evidence the hardware can't do this,
	// and recording it as false would plant a permanent, false "unsupported"
	// claim in a series the dashboard presents as fact. An unknown reading
	// must have NO entry, not a false one — same absence discipline as
	// EventReasons above, applied to support rather than to activity.
	Support map[string]bool
}

// StateDevice is the slice of NVML the device collector needs.
type StateDevice interface {
	UUID() (string, bool)
	// MIGInfo reports the MIG instance's own UUID and its GPU instance ID
	// (NVML GetGpuInstanceId), with ok=false for a non-MIG handle. UUID()
	// always reports the PHYSICAL device's UUID, even for a MIG instance
	// (docs-internal/01-architecture.md §3.1).
	//
	// Widened from a UUID-only method rather than adding a second accessor:
	// both values are read from the same MIG instance handle at the same
	// time and are always either both present or both absent, so one
	// (value, value, ok) method keeps the interface minimal without forcing
	// callers to make two calls that must agree.
	MIGInfo() (uuid string, instanceID int, ok bool)
	Index() int
	State() DeviceState
}

type DeviceCollector struct {
	devices []StateDevice
	node    string
}

func NewDeviceCollector(devices []StateDevice, node string) *DeviceCollector {
	return &DeviceCollector{devices: devices, node: node}
}

// Collect returns catalog rows 1, 21, 29, 30, 31, 32 and 33.
//
// Deliberately emits no PCIe, NVLink, C2C or profiling-derived ratio: those
// rows are DCGM's (docs-internal/00 § 3).
func (c *DeviceCollector) Collect() []Sample {
	var out []Sample

	for _, device := range c.devices {
		uuid, ok := device.UUID()
		if !ok {
			continue
		}
		s := device.State()
		base := map[string]string{
			"gpu_uuid": uuid,
			"gpu":      strconv.Itoa(device.Index()),
			"node":     c.node,
		}
		if migUUID, instanceID, ok := device.MIGInfo(); ok {
			base = withLabel(base, "mig_uuid", migUUID)
			// GPU_I_ID intentionally breaks our snake_case label convention:
			// it copies DCGM's own spelling verbatim (GPU_I_ID) so a PromQL
			// join on (gpu_uuid, GPU_I_ID) needs no relabeling on either
			// side. DCGM never publishes the MIG instance UUID on any
			// series — it identifies an instance only by GPU_I_ID within
			// the parent card — so this pair is the only key that reaches a
			// DCGM MIG series at all.
			base = withLabel(base, "GPU_I_ID", strconv.Itoa(instanceID))
		}

		if v, ok := Ratio(s.GPUUtilPercent); ok {
			out = append(out, Sample{"nvml_gpu_utilization_ratio", v, base})
		}
		for _, m := range []struct {
			name  string
			value float64
		}{
			{"nvml_gpu_memory_used_bytes", s.MemoryUsedBytes},
			{"nvml_gpu_memory_free_bytes", s.MemoryFreeBytes},
			{"nvml_gpu_memory_total_bytes", s.MemoryTotalBytes},
			{"nvml_gpu_temperature_celsius", s.TemperatureC},
		} {
			if m.value >= 0 {
				out = append(out, Sample{m.name, m.value, base})
			}
		}
		if s.PowerMilliwatts >= 0 {
			out = append(out, Sample{"nvml_gpu_power_watts", s.PowerMilliwatts / 1000.0, base})
		}
		for _, c := range []struct {
			domain string
			mhz    float64
		}{{"sm", s.SMClockMHz}, {"mem", s.MemClockMHz}} {
			if c.mhz >= 0 {
				out = append(out, Sample{
					"nvml_gpu_clock_hertz", c.mhz * 1e6, withLabel(base, "clock", c.domain),
				})
			}
		}
		for reason, active := range s.EventReasons {
			value := 0.0
			if active {
				value = 1.0
			}
			out = append(out, Sample{
				"nvml_gpu_clocks_event_reason_active", value, withLabel(base, "reason", reason),
			})
		}
		for metric, supported := range s.Support {
			value := 0.0
			if supported {
				value = 1.0
			}
			labels := withLabel(base, "metric", metric)
			labels["source"] = "nvml"
			out = append(out, Sample{"gpu_metric_supported", value, labels})
		}
	}
	return out
}

func withLabel(base map[string]string, key, value string) map[string]string {
	out := make(map[string]string, len(base)+1)
	for k, v := range base {
		out[k] = v
	}
	out[key] = value
	return out
}
