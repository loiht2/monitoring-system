package podcache

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	k8scache "k8s.io/client-go/tools/cache"
)

func containerID() string { return strings.Repeat("c", 64) }

func testPod() *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			UID:       types.UID("aaaa-bbbb"),
			Namespace: "team-x",
			Name:      "trainer-0",
		},
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{
				{Name: "main", ContainerID: "cri-o://" + containerID()},
			},
		},
	}
}

func TestResolvesPodUIDToNamespaceAndPod(t *testing.T) {
	c := New()
	c.Upsert(testPod())
	ns, name, ctr := c.Lookup("aaaa-bbbb", "")
	if ns != "team-x" || name != "trainer-0" || ctr != "" {
		t.Fatalf("got %q %q %q", ns, name, ctr)
	}
}

func TestResolvesContainerNameFromContainerID(t *testing.T) {
	c := New()
	c.Upsert(testPod())
	if _, _, ctr := c.Lookup("aaaa-bbbb", containerID()); ctr != "main" {
		t.Fatalf("container = %q", ctr)
	}
}

func TestUnknownUIDYieldsEmptyLabelsNotAnError(t *testing.T) {
	// Racing with pod deletion must not drop the measurement
	// (docs-internal/04 § 3.1).
	c := New()
	c.Upsert(testPod())
	if ns, name, ctr := c.Lookup("does-not-exist", ""); ns != "" || name != "" || ctr != "" {
		t.Fatalf("got %q %q %q; want empty", ns, name, ctr)
	}
}

func TestDeleteRemovesTheEntry(t *testing.T) {
	c := New()
	p := testPod()
	c.Upsert(p)
	c.Delete(p)
	if ns, _, _ := c.Lookup("aaaa-bbbb", ""); ns != "" {
		t.Fatalf("entry survived delete: %q", ns)
	}
}

func TestDeleteHandlesTombstoneFromMissedWatchEvent(t *testing.T) {
	// client-go delivers DeletedFinalStateUnknown, not a *Pod, when the
	// informer misses a delete during a relist. Dropping it leaks the entry
	// for the lifetime of the process — there is no other eviction path.
	c := New()
	p := testPod()
	c.Upsert(p)
	c.handleDelete(k8scache.DeletedFinalStateUnknown{Key: "team-x/trainer-0", Obj: p})
	if ns, _, _ := c.Lookup("aaaa-bbbb", ""); ns != "" {
		t.Fatalf("tombstone ignored, entry leaked: %q", ns)
	}
}

func TestSyncedIsFalseBeforeTheInitialListCompletes(t *testing.T) {
	// Until the initial list lands, Lookup misses for every PID indistinguishably
	// from a genuinely unattributable process, so per-pod metrics would carry
	// blank attribution — /readyz must hold traffic off until Synced() is true.
	c := New()
	if c.Synced() {
		t.Fatal("freshly constructed Cache reports Synced() == true")
	}
}

func TestSyncedBecomesTrueAfterTheInformerSyncs(t *testing.T) {
	client := fake.NewSimpleClientset(testPod())
	c := New()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx, client, "node-1")

	deadline := time.After(2 * time.Second)
	for {
		if c.Synced() {
			return
		}
		select {
		case <-deadline:
			t.Fatal("cache never reported Synced() == true within 2s")
		case <-time.After(time.Millisecond):
		}
	}
}

func TestAllSyncedIsFalseWhenAnyInformerFailed(t *testing.T) {
	if !allSynced(map[reflect.Type]bool{}) {
		// An empty map means no informer was waited on at all, which is not
		// the same as one having failed to sync — there is nothing to be
		// false about, so vacuously true is the correct answer here. Run's
		// only caller passes WaitForCacheSync's own result, which is never
		// empty for a factory with at least one informer registered.
		t.Fatal("allSynced(empty map) = false; want true (vacuous case)")
	}
	if !allSynced(map[reflect.Type]bool{reflect.TypeOf(0): true}) {
		t.Fatal("allSynced(all true) = false; want true")
	}
	if allSynced(map[reflect.Type]bool{reflect.TypeOf(0): true, reflect.TypeOf(""): false}) {
		t.Fatal("allSynced(one false) = true; want false")
	}
}

func TestConcurrentUpsertAndLookupIsRaceFree(t *testing.T) {
	// The informer writes while scrapes read — that is the whole reason this
	// type carries a mutex. Without a test that actually overlaps them,
	// `go test -race` runs over sequential calls and proves nothing.
	c := New()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 1000; i++ {
			c.Upsert(testPod())
			c.Delete(testPod())
		}
	}()
	for i := 0; i < 1000; i++ {
		c.Lookup("aaaa-bbbb", containerID())
	}
	<-done
}
