package main

import (
	"fmt"
	"log/slog"

	"github.com/NVIDIA/go-nvml/pkg/nvml"

	"github.com/loiht2/monitoring-system/exporters/nvml/internal/collector"
)

// nvmlDevice implements both collector.Device and collector.StateDevice.
type nvmlDevice struct {
	handle nvml.Device
	index  int
	mig    bool
	// migParent is true only for the whole-device handle of a MIG-enabled
	// device, never for one of its instances. Used to skip per-process
	// collection on the parent (see Processes()).
	migParent bool
	// parentUUID is set only on a MIG INSTANCE handle, to the UUID of the
	// physical device it belongs to. Empty for both non-MIG devices and the
	// MIG-enabled parent handle itself. UUID() reports this instead of the
	// handle's own UUID so gpu_uuid always names the physical device
	// (specs/01-architecture.md §3.1); MIGInfo() reports the
	// instance's own UUID and GPU instance ID.
	parentUUID string
	// instanceID is the NVML GPU instance ID (GetGpuInstanceId), captured at
	// discovery time alongside parentUUID so collectors never call back into
	// NVML. Meaningful only when parentUUID is set.
	instanceID int
}

// valueNotAvailable is nvml.h's NVML_VALUE_NOT_AVAILABLE (-1) reinterpreted as
// the unsigned type usedGpuMemory actually is (0xFFFFFFFFFFFFFFFF).
const valueNotAvailable uint64 = 1<<64 - 1

func (d nvmlDevice) Index() int { return d.index }

func (d nvmlDevice) UUID() (string, bool) {
	if d.parentUUID != "" {
		return d.parentUUID, true
	}
	uuid, ret := d.handle.GetUUID()
	return uuid, ret == nvml.SUCCESS
}

// MIGInfo reports the MIG instance's own UUID and GPU instance ID, with
// ok=false for any handle that is not a MIG instance (a non-MIG device, or a
// MIG-enabled parent handle).
func (d nvmlDevice) MIGInfo() (string, int, bool) {
	if d.parentUUID == "" {
		return "", 0, false
	}
	uuid, ret := d.handle.GetUUID()
	if ret != nvml.SUCCESS {
		return "", 0, false
	}
	return uuid, d.instanceID, true
}

func (d nvmlDevice) MIGEnabled() bool { return d.mig }

// supportFrom maps an NVML return code to a capability fact
// (specs/10-metric-support-signal.md § 2.1). known=false means the
// call failed for a reason that says nothing about what the hardware can do,
// so the caller must record no entry at all: a transient error must never
// become a permanent "unsupported" claim.
func supportFrom(ret nvml.Return) (supported bool, known bool) {
	switch ret {
	case nvml.SUCCESS:
		return true, true
	case nvml.ERROR_NOT_SUPPORTED:
		return false, true
	default:
		return false, false
	}
}

// record writes the supportFrom outcome for ret into m under name, doing
// nothing when the outcome is unknown.
func record(m map[string]bool, name string, ret nvml.Return) {
	if supported, known := supportFrom(ret); known {
		m[name] = supported
	}
}

// migSupport reports the process-utilization support facts that are known at
// MIG-decision time, independent of the per-device State() call: NVML does
// not implement GetProcessUtilization on a MIG device, which is itself a
// known-unsupported fact for the two per-process ratio metrics. State() and
// Processes() are both methods on this same value, but neither can see the
// other's map, so this helper is the single place that fact is expressed and
// both callers merge it into their own Support map instead of guessing.
func (d nvmlDevice) migSupport() map[string]bool {
	if !d.mig {
		return nil
	}
	return map[string]bool{
		"nvml_process_sm_utilization_ratio":     false,
		"nvml_process_memory_utilization_ratio": false,
	}
}

func (d nvmlDevice) Processes() []collector.ProcSample {
	byPID := map[uint32]*collector.ProcSample{}

	// Catalog row 22. On a MIG-enabled PARENT, NVML aggregates all instances'
	// processes onto the parent handle too (nvml.h: nvmlDeviceGetComputeRunningProcesses
	// "In MIG mode, if device handle is provided, the API returns aggregate
	// information"). Collecting on both the parent and its instances would
	// double-count every pod's memory, so the parent is skipped entirely and
	// per-process reporting is left to the instance handles.
	if !d.migParent {
		if procs, ret := d.handle.GetComputeRunningProcesses(); ret == nvml.SUCCESS {
			for _, p := range procs {
				memBytes := float64(p.UsedGpuMemory)
				// nvml.h: usedGpuMemory reports NVML_VALUE_NOT_AVAILABLE (-1) under
				// WDDM; as the unsigned field it actually is, that reads back as
				// ~1.8e19 bytes. Windows-only in practice. process.go now guards
				// MemoryBytes with collector.Bytes exactly like SMUtil/MemUtil are
				// guarded with collector.Ratio, so collector.NotSupported here is
				// omitted rather than summed — it must not be substituted with 0,
				// which would misreport an unmeasured reading as "not busy" for the
				// idle-GPU reclamation query.
				if p.UsedGpuMemory == valueNotAvailable {
					memBytes = collector.NotSupported
				}
				byPID[p.Pid] = &collector.ProcSample{
					PID:         p.Pid,
					SMUtil:      collector.NotSupported,
					MemUtil:     collector.NotSupported,
					MemoryBytes: memBytes,
				}
			}
		}
	}

	// Catalog row 2. Unsupported on MIG devices; absent, never zero.
	if !d.mig {
		if samples, ret := d.handle.GetProcessUtilization(0); ret == nvml.SUCCESS {
			for _, s := range samples {
				entry, ok := byPID[s.Pid]
				if !ok {
					entry = &collector.ProcSample{PID: s.Pid, MemoryBytes: collector.NotSupported}
					byPID[s.Pid] = entry
				}
				entry.SMUtil = int(s.SmUtil)
				entry.MemUtil = int(s.MemUtil)
			}
		}
	}

	out := make([]collector.ProcSample, 0, len(byPID))
	for _, p := range byPID {
		out = append(out, *p)
	}
	return out
}

func (d nvmlDevice) State() collector.DeviceState {
	s := collector.DeviceState{
		GPUUtilPercent:   collector.NotSupported,
		MemoryUsedBytes:  collector.NotSupported,
		MemoryFreeBytes:  collector.NotSupported,
		MemoryTotalBytes: collector.NotSupported,
		PowerMilliwatts:  collector.NotSupported,
		TemperatureC:     collector.NotSupported,
		SMClockMHz:       collector.NotSupported,
		MemClockMHz:      collector.NotSupported,
		EventReasons:     map[string]bool{},
		Support:          map[string]bool{},
	}

	// Each reading maps its NVML return code three ways
	// (specs/10-metric-support-signal.md § 2.1): SUCCESS records the
	// value AND support=true; ERROR_NOT_SUPPORTED records support=false with
	// no value; any other error leaves the value absent and records NO
	// support entry at all, because a transient failure is not evidence the
	// hardware can't do this.
	u, ret := d.handle.GetUtilizationRates()
	if ret == nvml.SUCCESS {
		s.GPUUtilPercent = int(u.Gpu)
	}
	record(s.Support, "nvml_gpu_utilization_ratio", ret)

	m, ret := d.handle.GetMemoryInfo()
	if ret == nvml.SUCCESS {
		s.MemoryUsedBytes = float64(m.Used)
		s.MemoryFreeBytes = float64(m.Free)
		s.MemoryTotalBytes = float64(m.Total)
	}
	record(s.Support, "nvml_gpu_memory_used_bytes", ret)
	record(s.Support, "nvml_gpu_memory_free_bytes", ret)
	record(s.Support, "nvml_gpu_memory_total_bytes", ret)

	p, ret := d.handle.GetPowerUsage()
	if ret == nvml.SUCCESS {
		s.PowerMilliwatts = float64(p)
	}
	record(s.Support, "nvml_gpu_power_watts", ret)

	t, ret := d.handle.GetTemperature(nvml.TEMPERATURE_GPU)
	if ret == nvml.SUCCESS {
		s.TemperatureC = float64(t)
	}
	record(s.Support, "nvml_gpu_temperature_celsius", ret)
	// nvml_gpu_clock_hertz covers two clock domains under one metric name, so
	// it gets a single Support entry: supported if EITHER domain reads
	// successfully. An ERROR_NOT_SUPPORTED on one domain only counts as a
	// definitive "false" if the other domain didn't already prove "true", and
	// any other error on a domain contributes nothing (unknown) unless the
	// other domain resolves it either way.
	smOK, smRet := d.handle.GetClockInfo(nvml.CLOCK_SM)
	if smRet == nvml.SUCCESS {
		s.SMClockMHz = float64(smOK)
	}
	memOK, memRet := d.handle.GetClockInfo(nvml.CLOCK_MEM)
	if memRet == nvml.SUCCESS {
		s.MemClockMHz = float64(memOK)
	}
	smSupported, smKnown := supportFrom(smRet)
	memSupported, memKnown := supportFrom(memRet)
	switch {
	case (smKnown && smSupported) || (memKnown && memSupported):
		s.Support["nvml_gpu_clock_hertz"] = true
	case smKnown && memKnown:
		// Both calls resolved and neither succeeded, so supportFrom gave
		// (false, true) for each: both domains are definitively unsupported.
		s.Support["nvml_gpu_clock_hertz"] = false
	}
	s.EventReasons = d.eventReasons()
	for metric, supported := range d.migSupport() {
		s.Support[metric] = supported
	}
	return s
}

// eventReasons is catalog row 33. Only reasons the device reports as SUPPORTED
// become series — an unsupported reason is absent, never false.
//
// This go-nvml release (v0.13.3-1) only defines "ClocksEventReason*" spellings
// for gpu_idle, applications_clocks_setting, sw_power_cap, sync_boost,
// sw_thermal_slowdown and display_clock_setting. The hw_slowdown,
// hw_thermal_slowdown and hw_power_brake_slowdown bits exist only under the
// legacy "ClocksThrottleReason*" spelling in const.go — there is no
// "ClocksEventReason*" alias for those three in this version. The bit VALUES
// are identical between the two families (verified in const.go: e.g.
// ClocksThrottleReasonHwSlowdown = 8, matching the nvml.h numbering used by the
// other ClocksEventReason* constants), so using the ClocksThrottleReason*
// constants here preserves semantics exactly against
// GetCurrentClocksEventReasons/GetSupportedClocksEventReasons, which operate on
// the same bitmask regardless of which constant family names a given bit.
func (d nvmlDevice) eventReasons() map[string]bool {
	current, ret := d.handle.GetCurrentClocksEventReasons()
	if ret != nvml.SUCCESS {
		return map[string]bool{}
	}
	supported, ret := d.handle.GetSupportedClocksEventReasons()
	if ret != nvml.SUCCESS {
		return map[string]bool{}
	}

	bits := map[string]uint64{
		"gpu_idle":                    nvml.ClocksEventReasonGpuIdle,
		"applications_clocks_setting": nvml.ClocksEventReasonApplicationsClocksSetting,
		"sw_power_cap":                nvml.ClocksEventReasonSwPowerCap,
		"hw_slowdown":                 nvml.ClocksThrottleReasonHwSlowdown,
		"sync_boost":                  nvml.ClocksEventReasonSyncBoost,
		"sw_thermal_slowdown":         nvml.ClocksEventReasonSwThermalSlowdown,
		"hw_thermal_slowdown":         nvml.ClocksThrottleReasonHwThermalSlowdown,
		"hw_power_brake_slowdown":     nvml.ClocksThrottleReasonHwPowerBrakeSlowdown,
		"display_clock_setting":       nvml.ClocksEventReasonDisplayClockSetting,
	}

	out := map[string]bool{}
	for name, bit := range bits {
		if supported&bit != 0 {
			out[name] = current&bit != 0
		}
	}
	return out
}

// discoverDevices returns every handle to collect from: whole devices, plus the
// MIG instances of any partitioned device. Both the parent and its instances
// are collected for device-level State() (memory, power, temperature, clocks
// are all real on the parent), but Processes() skips the parent — see its
// comment — so per-process memory is only reported once, on the instance
// handle (catalog MIG row 17).
func discoverDevices() ([]nvmlDevice, error) {
	count, ret := nvml.DeviceGetCount()
	if ret != nvml.SUCCESS {
		return nil, fmt.Errorf("DeviceGetCount: %s", nvml.ErrorString(ret))
	}

	var out []nvmlDevice
	for i := 0; i < count; i++ {
		handle, ret := nvml.DeviceGetHandleByIndex(i)
		if ret != nvml.SUCCESS {
			slog.Warn("nvml: skipping device handle", "index", i, "error", nvml.ErrorString(ret))
			continue
		}
		mode, _, ret := handle.GetMigMode()
		migOn := ret == nvml.SUCCESS && mode == nvml.DEVICE_MIG_ENABLE
		out = append(out, nvmlDevice{handle: handle, index: i, mig: migOn, migParent: migOn})

		if !migOn {
			continue
		}
		parentUUID, ret := handle.GetUUID()
		if ret != nvml.SUCCESS {
			slog.Warn("nvml: skipping MIG instance enumeration", "index", i, "error", nvml.ErrorString(ret))
			continue
		}
		max, ret := handle.GetMaxMigDeviceCount()
		if ret != nvml.SUCCESS {
			slog.Warn("nvml: skipping MIG instance enumeration", "index", i, "error", nvml.ErrorString(ret))
			continue
		}
		for j := 0; j < max; j++ {
			inst, ret := handle.GetMigDeviceHandleByIndex(j)
			if ret != nvml.SUCCESS {
				slog.Warn("nvml: skipping MIG instance handle", "index", i, "instance", j, "error", nvml.ErrorString(ret))
				continue
			}
			instanceID, ret := inst.GetGpuInstanceId()
			if ret != nvml.SUCCESS {
				slog.Warn("nvml: skipping MIG instance handle", "index", i, "instance", j, "error", nvml.ErrorString(ret))
				continue
			}
			out = append(out, nvmlDevice{handle: inst, index: i, mig: true, parentUUID: parentUUID, instanceID: instanceID})
		}
	}
	return out, nil
}
