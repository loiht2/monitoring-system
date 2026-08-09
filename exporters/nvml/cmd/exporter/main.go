package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/NVIDIA/go-nvml/pkg/nvml"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/loiht2/monitoring-system/exporters/nvml/internal/cgroup"
	"github.com/loiht2/monitoring-system/exporters/nvml/internal/collector"
	"github.com/loiht2/monitoring-system/exporters/nvml/internal/podcache"
)

func main() {
	if err := run(); err != nil {
		slog.Error("exiting", "err", err)
		os.Exit(1)
	}
}

func run() error {
	node := os.Getenv("NODE_NAME")
	if node == "" {
		return fmt.Errorf("NODE_NAME is required")
	}
	addr := ":" + envOr("LISTEN_PORT", "9401")

	if ret := nvml.Init(); ret != nvml.SUCCESS {
		return fmt.Errorf("nvml.Init: %s", nvml.ErrorString(ret))
	}
	defer nvml.Shutdown()

	devices, err := discoverDevices()
	if err != nil {
		return err
	}
	slog.Info("discovered device handles", "count", len(devices))

	cfg, err := rest.InClusterConfig()
	if err != nil {
		return err
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cache := podcache.New()
	go func() {
		if err := cache.Run(ctx, client, node); err != nil {
			slog.Error("pod informer stopped", "err", err)
		}
	}()

	// Gate per-process attribution on the cache having completed its initial
	// sync. This does not prevent blank-labelled series — ProcessCollector
	// emits one for any unresolvable PID regardless — it prevents the same
	// PID from flickering between attributed and blank as the cache fills in
	// mid-sync, which would otherwise make series look inconsistent scrape to
	// scrape. Keeping scrapers off entirely during that window is /readyz's
	// job. Device metrics need no cache, so this only affects resolve.
	resolve := func(pid uint32) (string, string, string) {
		if !cache.Synced() {
			return "", "", ""
		}
		podUID, containerID := cgroup.ParseForPID(pid, envOr("PROC_ROOT", "/proc"))
		return cache.Lookup(podUID, containerID)
	}

	procDevices := make([]collector.Device, 0, len(devices))
	stateDevices := make([]collector.StateDevice, 0, len(devices))
	for _, d := range devices {
		procDevices = append(procDevices, d)
		stateDevices = append(stateDevices, d)
	}

	registry := prometheus.NewRegistry()
	registry.MustRegister(collector.NewPrometheusAdapter([]collector.Collector{
		collector.NewDeviceCollector(stateDevices, node),
		collector.NewProcessCollector(procDevices, resolve),
		collector.NewAllocCollector(k8sAllocSource{client: client, node: node}),
	}))

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		// Withholds readiness (so k8s withholds traffic/scrape) until the pod
		// cache has synced, without blocking run() itself: a Kubernetes API
		// outage must not prevent device metrics, which need no cache, from
		// being served on /metrics.
		if !cache.Synced() {
			http.Error(w, "pod cache not yet synced", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	slog.Info("listening", "addr", addr)
	return http.ListenAndServe(addr, mux)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
