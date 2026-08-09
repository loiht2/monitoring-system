package cgroup

import "testing"

const crioV2 = "0::/kubepods.slice/kubepods-besteffort.slice/" +
	"kubepods-besteffort-pod390cff0a_3f2d_4947_ac7a_b468162fef32.slice/" +
	"crio-7a18dfa5f9d77aced0f92ddcb992c48a5f0a069be6e871e0e08d844eb570aaa3.scope/container\n"

const containerdV1 = "11:memory:/kubepods/burstable/pod3f8e1b2c-1111-2222-3333-444455556666/" +
	"9f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b\n"

func TestCrioV2UnderscoredUIDIsNormalized(t *testing.T) {
	podUID, ctrID := Parse(crioV2)
	if podUID != "390cff0a-3f2d-4947-ac7a-b468162fef32" {
		t.Fatalf("pod uid = %q", podUID)
	}
	if ctrID != "7a18dfa5f9d77aced0f92ddcb992c48a5f0a069be6e871e0e08d844eb570aaa3" {
		t.Fatalf("container id = %q", ctrID)
	}
}

func TestContainerdV1HyphenatedUID(t *testing.T) {
	podUID, ctrID := Parse(containerdV1)
	if podUID != "3f8e1b2c-1111-2222-3333-444455556666" {
		t.Fatalf("pod uid = %q", podUID)
	}
	if ctrID != "9f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b" {
		t.Fatalf("container id = %q", ctrID)
	}
}

func TestNonPodAndGarbageDegradeToEmpty(t *testing.T) {
	// The resolver must degrade to an unattributed series, never panic
	// (docs-internal/04 § 3.1).
	for _, in := range []string{"0::/system.slice/sshd.service\n", "", "garbage\n\n"} {
		if podUID, ctrID := Parse(in); podUID != "" || ctrID != "" {
			t.Fatalf("Parse(%q) = %q, %q; want empty", in, podUID, ctrID)
		}
	}
}

func TestParseForPIDOfDeadProcessIsNotAnError(t *testing.T) {
	if podUID, _ := ParseForPID(999999999, "/proc"); podUID != "" {
		t.Fatalf("dead pid yielded %q", podUID)
	}
}
