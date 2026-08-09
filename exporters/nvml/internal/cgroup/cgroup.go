// Package cgroup resolves a host PID to the pod and container that own it.
//
// A host PID must never become a Prometheus label: PIDs churn without bound and
// are recycled. This is the first hop of the resolution in docs-internal/01
// § 2.1 — the PID is discarded before exposition.
package cgroup

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Matches both cgroup layouts. systemd-managed slices write the pod UID with
// underscores; the cgroupfs driver writes it with hyphens.
var podUIDRe = regexp.MustCompile(
	`pod([0-9a-fA-F]{8}[-_][0-9a-fA-F]{4}[-_][0-9a-fA-F]{4}[-_][0-9a-fA-F]{4}[-_][0-9a-fA-F]{12})`)

// The container ID is a 64-hex token, optionally prefixed by the runtime name
// (crio-, docker-, containerd-) and suffixed with .scope.
var ctrIDRe = regexp.MustCompile(`(?:^|[-/])([0-9a-f]{64})(?:\.scope)?(?:/|$)`)

// Parse returns (podUID, containerID); either may be empty.
// Never returns an error: an unrecognized format yields empty strings so the
// caller emits an unattributed series rather than dropping the measurement.
func Parse(content string) (string, string) {
	m := podUIDRe.FindStringSubmatch(content)
	if m == nil {
		return "", ""
	}
	podUID := strings.ToLower(strings.ReplaceAll(m[1], "_", "-"))

	var ctrID string
	for _, line := range strings.Split(content, "\n") {
		if c := ctrIDRe.FindStringSubmatch(line); c != nil {
			ctrID = c[1]
			break
		}
	}
	return podUID, ctrID
}

// ParseForPID reads /proc/<pid>/cgroup. A process that has exited is not an
// error; it yields empty strings.
func ParseForPID(pid uint32, procRoot string) (string, string) {
	data, err := os.ReadFile(fmt.Sprintf("%s/%d/cgroup", procRoot, pid))
	if err != nil {
		return "", ""
	}
	return Parse(string(data))
}
