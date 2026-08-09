package main

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	resourcev1 "k8s.io/api/resource/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func strp(s string) *string { return &s }

func ptrTo[T any](v T) *T { return &v }

func testPodWithClaim(namespace, name, claimName, resourceClaimObjName string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "main"}},
			ResourceClaims: []corev1.PodResourceClaim{
				{Name: claimName},
			},
		},
		Status: corev1.PodStatus{
			ResourceClaimStatuses: []corev1.PodResourceClaimStatus{
				{Name: claimName, ResourceClaimName: strp(resourceClaimObjName)},
			},
		},
	}
}

func testClaim(namespace, name string, deviceResults ...resourcev1.DeviceRequestAllocationResult) *resourcev1.ResourceClaim {
	return &resourcev1.ResourceClaim{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Status: resourcev1.ResourceClaimStatus{
			Allocation: &resourcev1.AllocationResult{
				Devices: resourcev1.DeviceAllocationResult{
					Results: deviceResults,
				},
			},
		},
	}
}

func gpuDevice(name, uuid string) resourcev1.Device {
	return resourcev1.Device{
		Name: name,
		Attributes: map[resourcev1.QualifiedName]resourcev1.DeviceAttribute{
			"uuid": {StringValue: strp(uuid)},
			"type": {StringValue: strp("gpu")},
		},
	}
}

func migDevice(name, migUUID, parentUUID string) resourcev1.Device {
	return resourcev1.Device{
		Name: name,
		Attributes: map[resourcev1.QualifiedName]resourcev1.DeviceAttribute{
			"uuid":       {StringValue: strp(migUUID)},
			"type":       {StringValue: strp("mig")},
			"parentUUID": {StringValue: strp(parentUUID)},
		},
	}
}

func resourceSlice(name, node string, devices ...resourcev1.Device) *resourcev1.ResourceSlice {
	return &resourcev1.ResourceSlice{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: resourcev1.ResourceSliceSpec{
			NodeName: ptrTo(node),
			Driver:   "gpu.nvidia.com",
			Pool:     resourcev1.ResourcePool{Name: node},
			Devices:  devices,
		},
	}
}

func TestPlainGPUDeviceResolvesToGPUUUIDOnly(t *testing.T) {
	slice := resourceSlice("slice-1", "node-a", gpuDevice("gpu-0", "GPU-plain-uuid"))
	pod := testPodWithClaim("team-x", "trainer-0", "claim", "claim-obj")
	claim := testClaim("team-x", "claim-obj", resourcev1.DeviceRequestAllocationResult{Device: "gpu-0"})

	client := fake.NewSimpleClientset(pod, claim, slice)
	src := k8sAllocSource{client: client, node: "node-a"}

	ents := src.Entitlements()
	if len(ents) != 1 {
		t.Fatalf("got %d entitlements, want 1: %+v", len(ents), ents)
	}
	if ents[0].GPUUUID != "GPU-plain-uuid" || ents[0].MIGUUID != "" {
		t.Fatalf("got GPUUUID=%q MIGUUID=%q, want GPUUUID=GPU-plain-uuid MIGUUID=empty", ents[0].GPUUUID, ents[0].MIGUUID)
	}
}

func TestMIGDeviceResolvesToBothMIGAndParentGPUUUID(t *testing.T) {
	slice := resourceSlice("slice-1", "node-a",
		migDevice("gpu-0-mig-1g.5gb-0", "MIG-instance-uuid", "GPU-parent-uuid"))
	pod := testPodWithClaim("team-x", "trainer-0", "claim", "claim-obj")
	claim := testClaim("team-x", "claim-obj", resourcev1.DeviceRequestAllocationResult{Device: "gpu-0-mig-1g.5gb-0"})

	client := fake.NewSimpleClientset(pod, claim, slice)
	src := k8sAllocSource{client: client, node: "node-a"}

	ents := src.Entitlements()
	if len(ents) != 1 {
		t.Fatalf("got %d entitlements, want 1: %+v", len(ents), ents)
	}
	if ents[0].GPUUUID != "GPU-parent-uuid" {
		t.Fatalf("GPUUUID = %q, want parent GPU UUID GPU-parent-uuid", ents[0].GPUUUID)
	}
	if ents[0].MIGUUID != "MIG-instance-uuid" {
		t.Fatalf("MIGUUID = %q, want MIG-instance-uuid", ents[0].MIGUUID)
	}
}

func TestMIGDeviceMissingParentUUIDIsSkippedNotPanicked(t *testing.T) {
	badMIG := resourcev1.Device{
		Name: "gpu-0-mig-1g.5gb-0",
		Attributes: map[resourcev1.QualifiedName]resourcev1.DeviceAttribute{
			"uuid": {StringValue: strp("MIG-instance-uuid")},
			"type": {StringValue: strp("mig")},
			// parentUUID deliberately missing
		},
	}
	slice := resourceSlice("slice-1", "node-a", badMIG)
	pod := testPodWithClaim("team-x", "trainer-0", "claim", "claim-obj")
	claim := testClaim("team-x", "claim-obj", resourcev1.DeviceRequestAllocationResult{Device: "gpu-0-mig-1g.5gb-0"})

	client := fake.NewSimpleClientset(pod, claim, slice)
	src := k8sAllocSource{client: client, node: "node-a"}

	ents := src.Entitlements()
	if len(ents) != 0 {
		t.Fatalf("got %d entitlements, want 0 (device should be skipped): %+v", len(ents), ents)
	}
}

func TestUnknownDeviceTypeAttributeIsSkippedGracefully(t *testing.T) {
	// A device whose "type" attribute is something the exporter doesn't
	// recognize (e.g. "vfio") must be treated as a plain UUID entry, not
	// crash and not be dropped — this mirrors current behavior for anything
	// that isn't explicitly "mig".
	vfio := resourcev1.Device{
		Name: "gpu-0",
		Attributes: map[resourcev1.QualifiedName]resourcev1.DeviceAttribute{
			"uuid": {StringValue: strp("GPU-vfio-uuid")},
			"type": {StringValue: strp("vfio")},
		},
	}
	slice := resourceSlice("slice-1", "node-a", vfio)
	pod := testPodWithClaim("team-x", "trainer-0", "claim", "claim-obj")
	claim := testClaim("team-x", "claim-obj", resourcev1.DeviceRequestAllocationResult{Device: "gpu-0"})

	client := fake.NewSimpleClientset(pod, claim, slice)
	src := k8sAllocSource{client: client, node: "node-a"}

	ents := src.Entitlements()
	if len(ents) != 1 || ents[0].GPUUUID != "GPU-vfio-uuid" || ents[0].MIGUUID != "" {
		t.Fatalf("got %+v, want single entitlement GPUUUID=GPU-vfio-uuid MIGUUID=empty", ents)
	}
}

func TestDeviceMissingUUIDAttributeIsSkippedWithoutPanic(t *testing.T) {
	noUUID := resourcev1.Device{
		Name: "gpu-0",
		Attributes: map[resourcev1.QualifiedName]resourcev1.DeviceAttribute{
			"type": {StringValue: strp("gpu")},
		},
	}
	slice := resourceSlice("slice-1", "node-a", noUUID)
	pod := testPodWithClaim("team-x", "trainer-0", "claim", "claim-obj")
	claim := testClaim("team-x", "claim-obj", resourcev1.DeviceRequestAllocationResult{Device: "gpu-0"})

	client := fake.NewSimpleClientset(pod, claim, slice)
	src := k8sAllocSource{client: client, node: "node-a"}

	ents := src.Entitlements()
	if len(ents) != 0 {
		t.Fatalf("got %d entitlements, want 0: %+v", len(ents), ents)
	}
}

func TestResourceSliceWithNilNodeNameIsIgnored(t *testing.T) {
	slice := &resourcev1.ResourceSlice{
		ObjectMeta: metav1.ObjectMeta{Name: "slice-1"},
		Spec: resourcev1.ResourceSliceSpec{
			NodeName: nil,
			Driver:   "gpu.nvidia.com",
			Pool:     resourcev1.ResourcePool{Name: "node-a"},
			Devices:  []resourcev1.Device{gpuDevice("gpu-0", "GPU-uuid")},
		},
	}
	pod := testPodWithClaim("team-x", "trainer-0", "claim", "claim-obj")
	claim := testClaim("team-x", "claim-obj", resourcev1.DeviceRequestAllocationResult{Device: "gpu-0"})

	client := fake.NewSimpleClientset(pod, claim, slice)
	src := k8sAllocSource{client: client, node: "node-a"}

	ents := src.Entitlements()
	if len(ents) != 0 {
		t.Fatalf("got %d entitlements, want 0 (nil NodeName slice must be ignored): %+v", len(ents), ents)
	}
}

func TestResourceSliceForDifferentNodeIsIgnored(t *testing.T) {
	slice := resourceSlice("slice-1", "node-b", gpuDevice("gpu-0", "GPU-uuid"))
	pod := testPodWithClaim("team-x", "trainer-0", "claim", "claim-obj")
	claim := testClaim("team-x", "claim-obj", resourcev1.DeviceRequestAllocationResult{Device: "gpu-0"})

	client := fake.NewSimpleClientset(pod, claim, slice)
	src := k8sAllocSource{client: client, node: "node-a"}

	ents := src.Entitlements()
	if len(ents) != 0 {
		t.Fatalf("got %d entitlements, want 0 (different node's slice must be ignored): %+v", len(ents), ents)
	}
}

func TestTwoDriversPublishingSameUUIDDoesNotCorruptMapping(t *testing.T) {
	// gpu.nvidia.com and hami-core-gpu.project-hami.io both publish a device
	// for the same physical card, under different device names, carrying the
	// same bare uuid attribute. Both should resolve independently and
	// correctly to that same GPU UUID.
	sliceA := resourceSlice("slice-nvidia", "node-a", gpuDevice("gpu-0", "GPU-shared-uuid"))
	sliceB := &resourcev1.ResourceSlice{
		ObjectMeta: metav1.ObjectMeta{Name: "slice-hami"},
		Spec: resourcev1.ResourceSliceSpec{
			NodeName: ptrTo("node-a"),
			Driver:   "hami-core-gpu.project-hami.io",
			Pool:     resourcev1.ResourcePool{Name: "node-a"},
			Devices: []resourcev1.Device{
				{
					Name: "hami-gpu-0",
					Attributes: map[resourcev1.QualifiedName]resourcev1.DeviceAttribute{
						"uuid": {StringValue: strp("GPU-shared-uuid")},
						"type": {StringValue: strp("hami-gpu")},
					},
				},
			},
		},
	}

	podA := testPodWithClaim("team-x", "trainer-a", "claim", "claim-a-obj")
	claimA := testClaim("team-x", "claim-a-obj", resourcev1.DeviceRequestAllocationResult{Device: "gpu-0"})
	podB := testPodWithClaim("team-x", "trainer-b", "claim", "claim-b-obj")
	claimB := testClaim("team-x", "claim-b-obj", resourcev1.DeviceRequestAllocationResult{Device: "hami-gpu-0"})

	client := fake.NewSimpleClientset(podA, claimA, podB, claimB, sliceA, sliceB)
	src := k8sAllocSource{client: client, node: "node-a"}

	ents := src.Entitlements()
	if len(ents) != 2 {
		t.Fatalf("got %d entitlements, want 2: %+v", len(ents), ents)
	}
	for _, e := range ents {
		if e.GPUUUID != "GPU-shared-uuid" || e.MIGUUID != "" {
			t.Fatalf("entitlement %+v does not have the expected shared GPU UUID and empty MIGUUID", e)
		}
	}
}

func TestPendingClaimYieldsNoEntitlementsNotPanic(t *testing.T) {
	pod := testPodWithClaim("team-x", "trainer-0", "claim", "")
	// no PodResourceClaimStatus resolved, no ResourceClaimName either
	pod.Status.ResourceClaimStatuses = nil
	pod.Spec.ResourceClaims = []corev1.PodResourceClaim{{Name: "claim"}}

	client := fake.NewSimpleClientset(pod)
	src := k8sAllocSource{client: client, node: "node-a"}

	if got := src.Entitlements(); len(got) != 0 {
		t.Fatalf("got %d entitlements, want 0: %+v", len(got), got)
	}
}
