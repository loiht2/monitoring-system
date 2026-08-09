// Package podcache maps a pod UID to its identity, fed by an informer.
//
// Field-selected to one node: the exporter needs no cluster-wide pod read, and
// scoping it keeps both RBAC and memory small.
package podcache

import (
	"context"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

type identity struct{ namespace, name string }

// Cache is safe for concurrent use: the informer writes, scrapes read.
type Cache struct {
	mu         sync.RWMutex
	byUID      map[string]identity
	containers map[string]string // podUID + "/" + containerID -> container name
}

func New() *Cache {
	return &Cache{
		byUID:      make(map[string]identity),
		containers: make(map[string]string),
	}
}

func (c *Cache) Upsert(pod *corev1.Pod) {
	uid := string(pod.UID)
	if uid == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byUID[uid] = identity{namespace: pod.Namespace, name: pod.Name}
	for _, cs := range pod.Status.ContainerStatuses {
		if id := trimRuntimePrefix(cs.ContainerID); id != "" {
			c.containers[uid+"/"+id] = cs.Name
		}
	}
}

func (c *Cache) Delete(pod *corev1.Pod) {
	uid := string(pod.UID)
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.byUID, uid)
	for key := range c.containers {
		if strings.HasPrefix(key, uid+"/") {
			delete(c.containers, key)
		}
	}
}

// Lookup returns (namespace, pod, container); empty strings when unknown.
func (c *Cache) Lookup(podUID, containerID string) (string, string, string) {
	if podUID == "" {
		return "", "", ""
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	id, ok := c.byUID[podUID]
	if !ok {
		return "", "", ""
	}
	return id.namespace, id.name, c.containers[podUID+"/"+containerID]
}

func trimRuntimePrefix(id string) string {
	if i := strings.Index(id, "://"); i >= 0 {
		return id[i+3:]
	}
	return id
}

// Run starts a node-scoped pod informer and blocks until ctx is done.
func (c *Cache) Run(ctx context.Context, client kubernetes.Interface, nodeName string) error {
	factory := informers.NewSharedInformerFactoryWithOptions(
		client, 10*time.Minute,
		informers.WithTweakListOptions(func(opts *metav1.ListOptions) {
			opts.FieldSelector = fields.OneTermEqualSelector("spec.nodeName", nodeName).String()
		}),
	)
	informer := factory.Core().V1().Pods().Informer()
	if _, err := informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(obj any) { c.upsertAny(obj) },
		UpdateFunc: func(_, obj any) { c.upsertAny(obj) },
		DeleteFunc: func(obj any) { c.handleDelete(obj) },
	}); err != nil {
		return err
	}
	factory.Start(ctx.Done())
	factory.WaitForCacheSync(ctx.Done())
	<-ctx.Done()
	return nil
}

func (c *Cache) upsertAny(obj any) {
	if p, ok := obj.(*corev1.Pod); ok {
		c.Upsert(p)
	}
}

// handleDelete accepts either a *corev1.Pod or the DeletedFinalStateUnknown
// tombstone client-go delivers when the informer MISSED a delete (watch gap or
// relist). Ignoring the tombstone leaks the entry for the lifetime of the
// process: there is no TTL and no other eviction path. Pod UIDs are never
// reused, so a leaked entry cannot mislabel anything — it is purely unbounded
// growth in a DaemonSet that runs for weeks.
//
// Kept as a method rather than inline in the event handler so it can be tested
// without standing up an informer.
func (c *Cache) handleDelete(obj any) {
	switch v := obj.(type) {
	case *corev1.Pod:
		c.Delete(v)
	case cache.DeletedFinalStateUnknown:
		if p, ok := v.Obj.(*corev1.Pod); ok {
			c.Delete(p)
		}
	}
}
