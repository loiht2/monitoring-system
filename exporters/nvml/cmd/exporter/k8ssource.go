package main

import (
	"context"
	"log/slog"

	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/kubernetes"

	"github.com/loiht2/monitoring-system/exporters/nvml/internal/alloc"
	"github.com/loiht2/monitoring-system/exporters/nvml/internal/collector"
)

// uuidAttribute is the DeviceAttribute key under which a HAMi/NVIDIA DRA
// driver publishes a device's GPU UUID. Not a well-known k8s.io constant;
// this is the literal key observed on the DRA driver this platform runs.
const uuidAttribute = "uuid"

// k8sAllocSource implements collector.AllocSource against the live cluster.
type k8sAllocSource struct {
	client kubernetes.Interface
	node   string
}

// Entitlements lists this node's pod-to-GPU grants, from either the HAMi
// annotation path or DRA ResourceClaims. Never panics and never returns an
// error to the caller: any failure is logged and yields an empty/partial
// slice, per collector.AllocCollector's "safeCollect" contract at the
// PrometheusAdapter level, and because dropping one pod's entitlement must
// not blank the whole scrape.
func (s k8sAllocSource) Entitlements() []collector.Entitlement {
	ctx := context.Background()

	pods, err := s.client.CoreV1().Pods("").List(ctx, metav1.ListOptions{
		FieldSelector: fields.OneTermEqualSelector("spec.nodeName", s.node).String(),
	})
	if err != nil {
		slog.Warn("k8ssource: listing pods failed", "node", s.node, "err", err)
		return nil
	}

	var out []collector.Entitlement
	var sliceUUIDs map[string]string // lazily built only if a pod needs DRA resolution

	for i := range pods.Items {
		pod := &pods.Items[i]

		// Arbitrary: the first container is used as the label for
		// annotation/DRA entitlements. See report to caller — the
		// per-process collector resolves the real container via cgroup,
		// but entitlement has no such signal to pick among containers.
		container := ""
		if len(pod.Spec.Containers) > 0 {
			container = pod.Spec.Containers[0].Name
		}

		if uuids := alloc.DeviceUUIDsFromAnnotations(pod.Annotations); len(uuids) > 0 {
			for _, uuid := range uuids {
				out = append(out, collector.Entitlement{
					GPUUUID:   uuid,
					Namespace: pod.Namespace,
					Pod:       pod.Name,
					Container: container,
					Source:    "annotation",
				})
			}
			continue
		}

		if len(pod.Spec.ResourceClaims) == 0 {
			continue
		}
		if sliceUUIDs == nil {
			sliceUUIDs = s.resourceSliceUUIDs(ctx)
		}
		for _, ref := range pod.Spec.ResourceClaims {
			results := s.claimResults(ctx, pod, ref)
			for _, name := range alloc.DevicesFromClaim(results) {
				uuid, ok := sliceUUIDs[name]
				if !ok {
					continue
				}
				out = append(out, collector.Entitlement{
					GPUUUID:   uuid,
					Namespace: pod.Namespace,
					Pod:       pod.Name,
					Container: container,
					Source:    "dra",
				})
			}
		}
	}
	return out
}

// resourceSliceUUIDs builds a device-name -> GPU-UUID map from this node's
// ResourceSlices. Logs and returns an empty map on any failure; never errors
// out to the caller.
func (s k8sAllocSource) resourceSliceUUIDs(ctx context.Context) map[string]string {
	out := make(map[string]string)

	slices, err := s.client.ResourceV1().ResourceSlices().List(ctx, metav1.ListOptions{})
	if err != nil {
		slog.Warn("k8ssource: listing resource slices failed", "node", s.node, "err", err)
		return out
	}

	for i := range slices.Items {
		slice := &slices.Items[i]
		if slice.Spec.NodeName == nil || *slice.Spec.NodeName != s.node {
			continue
		}
		for _, device := range slice.Spec.Devices {
			attr, ok := device.Attributes[resourcev1.QualifiedName(uuidAttribute)]
			if !ok || attr.StringValue == nil {
				continue
			}
			out[device.Name] = *attr.StringValue
		}
	}
	return out
}

// claimResults resolves a pod's PodResourceClaim reference to the backing
// ResourceClaim object and returns its allocated device results. A claim
// that does not exist yet, or exists but has not been allocated, is the
// normal pending case — not a failure — and is logged at Debug, returning
// nil either way. Never panics, never surfaces an error: the signature
// returns only the slice.
func (s k8sAllocSource) claimResults(ctx context.Context, pod *corev1.Pod, ref corev1.PodResourceClaim) []alloc.ClaimResult {
	claimName := ""
	for _, st := range pod.Status.ResourceClaimStatuses {
		if st.Name == ref.Name && st.ResourceClaimName != nil {
			claimName = *st.ResourceClaimName
			break
		}
	}
	if claimName == "" && ref.ResourceClaimName != nil {
		claimName = *ref.ResourceClaimName
	}
	if claimName == "" {
		slog.Debug("k8ssource: pod resource claim not yet resolved to an object name",
			"namespace", pod.Namespace, "pod", pod.Name, "claim", ref.Name)
		return nil
	}

	claim, err := s.client.ResourceV1().ResourceClaims(pod.Namespace).Get(ctx, claimName, metav1.GetOptions{})
	if err != nil {
		slog.Debug("k8ssource: resource claim not found (pending is normal)",
			"namespace", pod.Namespace, "claim", claimName, "err", err)
		return nil
	}
	if claim.Status.Allocation == nil {
		slog.Debug("k8ssource: resource claim not yet allocated (pending is normal)",
			"namespace", pod.Namespace, "claim", claimName)
		return nil
	}

	results := make([]alloc.ClaimResult, 0, len(claim.Status.Allocation.Devices.Results))
	for _, r := range claim.Status.Allocation.Devices.Results {
		results = append(results, alloc.ClaimResult{Device: r.Device, Pool: r.Pool, Driver: r.Driver})
	}
	return results
}
