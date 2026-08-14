#!/usr/bin/env bash
# Phase driver for the metric evaluation suite (14 §5).
#
# A phase is a workload plus a time window. This script records t0 before the
# Job is applied and t1 after it stops, then appends one JSON line to
# evaluation/phases.jsonl. report.py asks Prometheus, per metric and per entity,
# whether a sample exists inside that window.
#
# The window is recorded, never assumed. A Job that never reached Running has no
# window at all and is written as status "ERROR": the classifier must be able to
# tell "the workload did not run" from "the metric did not appear", and
# conflating the two is how a harness reports a clean bill of health for a
# system it never exercised.
#
# Usage:
#   run.sh --phase <mode> --target <gpu0|mig|mig:<GPU_I_ID>|hami> [--duration secs]
#
# --target mig is not "the one instance" any more: GPU 1 carries a mixed
# layout (14 §4.5) and a per-instance query that returns one row can hide an
# expression that silently aggregates across instances. `mig` therefore expands
# to one phase per instance advertised by DCGM, and `mig:<GPU_I_ID>` pins a
# single one. Each phase row carries its GPU_I_ID so the report can attribute
# per instance rather than to "the MIG target".
#   run.sh --all [--duration secs]
#   run.sh --repartition <1g.6gb|2g.12gb|4g.24gb>
#
# --repartition is never part of --all. It destroys the existing 1g.6gb
# instance and changes cluster state (14 §4.4).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/manifests/job-template.yaml"
PHASES="$HERE/phases.jsonl"
LOGDIR="$HERE/logs"
NS=default
REGISTRY=192.168.6.123:30080/library

# Measured cluster facts. GPUs here come through DRA, not the device plugin:
# the node advertises nvidia.com/gpu: 0 because the mixed layout (GPU 0 whole,
# GPU 1 MIG) makes the plugin's `single` MIG strategy report
# NVIDIA-A30-MIG-INVALID. See manifests/job-template.yaml.
GPU0_UUID=GPU-26e02ca7-f4ba-b335-915c-2a8541deb8a4
GPU1_UUID=GPU-a4d27439-566b-841c-428f-d87e73e4134e

DURATION=90
DEADLINE_SLACK=240   # seconds allowed on top of DURATION for pull + schedule

PIPE_MODES=(fp64 fp32 fp16 tensor-hmma tensor-imma tensor-dfma int
            dram-bandwidth pcie-h2d pcie-d2h peer-copy hostmem peermem sustained)
API_MODES=(malloc-free memcpy-h2d memcpy-d2h memcpy-d2d memcpy-peer memset-sync
           memset-async stream-sync device-sync event-sync event-elapsed
           graph-launch kernel-dims errors)

# Modes that exit non-zero on this host by design: cudaDeviceCanAccessPeer(0,1)
# is false and NVLink is inactive between the two cards. They still run — the
# recorded verdict is the point, and a mode that unexpectedly succeeds is a
# finding. Their real exit status is recorded, never retried away.
EXPECT_FAIL="peer-copy peermem memcpy-peer"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

image_for() {
  case " ${PIPE_MODES[*]} " in *" $1 "*) echo "$REGISTRY/pipe-exerciser:v1"; return;; esac
  case " ${API_MODES[*]} " in *" $1 "*) echo "$REGISTRY/api-exerciser:v1"; return;; esac
  echo ""
}

# Per-target DRA wiring. The MIG instance UUID is read live rather than pinned,
# because --repartition changes it.
target_wiring() {
  GPU_I_ID=""
  case "$1" in
    gpu0)
      DEVICE_CLASS=gpu.nvidia.com
      DEVICE_SELECTOR="'device.attributes[\"gpu.nvidia.com\"].uuid == \"$GPU0_UUID\"'"
      CAPACITY=""
      ;;
    mig:*)
      # One specific instance. DCGM names an instance by GPU_I_ID; DRA names it
      # by MIG uuid, and the two schemes only meet in nvml_gpu_memory_total_bytes
      # (14 §4.6). Resolve the id to a uuid there, then reuse the *existing*
      # uuid-equality CEL selector rather than inventing a new mechanism — the
      # only thing that changes per instance is which uuid it is pinned to.
      local id uuid
      id="${1#mig:}"
      uuid=$(mig_uuid_for_id "$id")
      [ -n "$uuid" ] || { log "no MIG uuid for GPU_I_ID=$id"; return 1; }
      GPU_I_ID="$id"
      DEVICE_CLASS=mig.nvidia.com
      DEVICE_SELECTOR="'device.attributes[\"gpu.nvidia.com\"].uuid == \"$uuid\"'"
      CAPACITY=""
      ;;
    hami)
      DEVICE_CLASS=hami-core-gpu.project-hami.io
      DEVICE_SELECTOR="'device.attributes[\"hami-core-gpu.project-hami.io\"].uuid == \"$GPU0_UUID\"'"
      # Deliberately tight: 20 cores to provoke compute throttling, 2 GiB to
      # provoke an allocator OOM inside the HAMi limit rather than on the card.
      CAPACITY=$'          capacity:\n            requests:\n              cores: "20"\n              memory: 2048Mi'
      ;;
    *) log "unknown target: $1"; return 1;;
  esac
}

# Prometheus, discovered the same way report.py does it: PROM_URL if set, else
# the prometheus pod's IP (`prometheus-operated` is headless, so no ClusterIP
# name resolves off-cluster).
prom_url() {
  if [ -n "${PROM_URL:-}" ]; then echo "$PROM_URL"; return; fi
  local ip
  ip=$(kubectl get pod -n gpu-monitoring -l app.kubernetes.io/name=prometheus \
       -o jsonpath='{.items[0].status.podIP}' 2>/dev/null)
  [ -n "$ip" ] && echo "http://$ip:9090"
}

prom_query() {
  local base; base=$(prom_url)
  [ -n "$base" ] || { log "no prometheus found; set PROM_URL"; return 1; }
  curl -sf -G "$base/api/v1/query" --data-urlencode "query=$1"
}

# The instances DCGM actually reports, as "<GPU_I_ID> <profile>", sorted by id.
# DCGM is the source of truth for what exists to be measured — asking DRA
# instead would report what is schedulable, which is a different question and
# has been observed to lag a re-partition.
mig_instance_ids() {
  prom_query 'DCGM_FI_DEV_FB_USED{GPU_I_ID!=""}' | python3 -c '
import json,sys
seen={}
for s in json.load(sys.stdin)["data"]["result"]:
    m=s["metric"]; seen[m["GPU_I_ID"]]=m.get("GPU_I_PROFILE","?")
for i in sorted(seen, key=int): print(i, seen[i])
'
}

# GPU_I_ID -> MIG uuid, across the bridge that carries both (14 §4.6). Windowed,
# because the exporter publishes these at its own cadence and an instant query
# can miss a scrape; scoped short so a destroyed instance cannot resolve.
mig_uuid_for_id() {
  prom_query "last_over_time(nvml_gpu_memory_total_bytes{mig_uuid!=\"\",GPU_I_ID=\"$1\"}[5m])" \
  | python3 -c '
import json,sys
u={s["metric"]["mig_uuid"] for s in json.load(sys.stdin)["data"]["result"]}
print(u.pop() if len(u)==1 else "")
'
}

mig_instance_uuid() {
  kubectl get resourceslice -o json 2>/dev/null | python3 -c '
import json,sys
for sl in json.load(sys.stdin)["items"]:
    if sl["spec"].get("driver") != "gpu.nvidia.com": continue
    for d in sl["spec"]["devices"]:
        a = d.get("attributes", {})
        if a.get("type", {}).get("string") == "mig":
            print(a["uuid"]["string"]); raise SystemExit
'
}

mig_instances() {
  kubectl get resourceslice -o json 2>/dev/null | python3 -c '
import json,sys
for sl in json.load(sys.stdin)["items"]:
    if sl["spec"].get("driver") != "gpu.nvidia.com": continue
    for d in sl["spec"]["devices"]:
        a = d.get("attributes", {})
        if a.get("type", {}).get("string") == "mig":
            print(a["uuid"]["string"], a.get("profile", {}).get("string", "?"))
'
}

cleanup_phase() {
  kubectl -n "$NS" delete job "$1" --ignore-not-found --wait=true >/dev/null 2>&1
  kubectl -n "$NS" delete resourceclaim "$1" --ignore-not-found --wait=true >/dev/null 2>&1
}

record() {
  python3 -c '
import json,sys
phase,mode,target,image,t0,t1,status,exit_code,note,gpu_i_id = sys.argv[1:]
print(json.dumps({"phase":phase,"mode":mode,"target":target,"image":image,
                  "t0":int(t0),"t1":int(t1),"status":status,
                  "exit_code":None if exit_code=="" else int(exit_code),
                  "note":note,
                  "gpu_i_id":gpu_i_id or None}))' "$@" >> "$PHASES"
}

# Run one phase. Always writes exactly one line to phases.jsonl.
run_phase() {
  local mode="$1" target="$2"
  local image; image="$(image_for "$mode")"
  if [ -z "$image" ]; then log "unknown mode: $mode"; return 1; fi
  target_wiring "$target" || {
    record "$target/$mode" "$mode" "$target" "$image" 0 0 ERROR "" "target unavailable" \
           "$(printf '%s' "$target" | sed -n 's/^mig://p')"
    return 1
  }

  local job="eval-${target/:/}-$mode"
  job="${job//_/-}"
  cleanup_phase "$job"
  mkdir -p "$LOGDIR"

  export JOB_NAME="$job" IMAGE="$image" MODE="$mode" DURATION DEVICE=0 \
         DEVICE_CLASS DEVICE_SELECTOR CAPACITY

  local t0; t0=$(date +%s)
  if ! envsubst < "$TEMPLATE" | kubectl apply -f - >/dev/null 2>"$LOGDIR/$job.apply.err"; then
    log "$job: apply failed"; cat "$LOGDIR/$job.apply.err" >&2
    record "$target/$mode" "$mode" "$target" "$image" "$t0" "$(date +%s)" ERROR "" \
           "kubectl apply failed: $(tr '\n' ' ' < "$LOGDIR/$job.apply.err" | cut -c1-300)" \
           "$GPU_I_ID"
    cleanup_phase "$job"
    return 1
  fi

  # Poll rather than `kubectl wait`, because we need to know whether the pod
  # ever reached Running — a Pending pod that times out is ERROR, not a phase.
  local deadline=$((t0 + DURATION + DEADLINE_SLACK))
  local ran=0 phase_status="" exit_code="" note="" podphase=""
  while :; do
    podphase=$(kubectl -n "$NS" get pod -l "job-name=$job" \
               -o jsonpath='{.items[0].status.phase}' 2>/dev/null)
    case "$podphase" in Running|Succeeded|Failed) ran=1;; esac
    case "$podphase" in
      Succeeded) phase_status=COMPLETE; exit_code=0; break;;
      Failed)
        exit_code=$(kubectl -n "$NS" get pod -l "job-name=$job" \
          -o jsonpath='{.items[0].status.containerStatuses[0].state.terminated.exitCode}' 2>/dev/null)
        phase_status=FAILED; break;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      if [ "$ran" = 1 ]; then
        phase_status=FAILED; note="timed out while Running after $((DURATION + DEADLINE_SLACK))s"
      else
        phase_status=ERROR
        note="pod never reached Running (last phase: ${podphase:-none}); $(pod_reason "$job")"
      fi
      break
    fi
    sleep 3
  done
  local t1; t1=$(date +%s)

  kubectl -n "$NS" logs "job/$job" --all-containers --tail=-1 \
      > "$LOGDIR/$job.log" 2>&1 || true

  if [ "$phase_status" = FAILED ] && [ -z "$note" ]; then
    case " $EXPECT_FAIL " in
      *" $mode "*) note="non-zero by design on this host: peer access is unavailable";;
      *) note="workload exited non-zero: $(tail -n 2 "$LOGDIR/$job.log" | tr '\n' ' ' | cut -c1-300)";;
    esac
  fi

  log "$job: $phase_status exit=${exit_code:-?} window=$((t1 - t0))s"
  record "$target/$mode" "$mode" "$target" "$image" "$t0" "$t1" \
         "$phase_status" "$exit_code" "$note" "$GPU_I_ID"
  cleanup_phase "$job"
  [ "$phase_status" != ERROR ]
}

# Expand a target into the concrete targets to run. Bare `mig` means every
# instance, one phase each — with a mixed layout, running only one of them
# cannot distinguish a per-instance metric from one aggregated over the card
# (14 §4.5). Every other target expands to itself.
expand_target() {
  case "$1" in
    mig) mig_instance_ids | while read -r id _; do echo "mig:$id"; done;;
    *) echo "$1";;
  esac
}

run_target() {
  local mode="$1" target="$2" t rc=0
  local targets; targets="$(expand_target "$target")"
  if [ -z "$targets" ]; then
    log "no instances for target $target"
    return 1
  fi
  for t in $targets; do
    run_phase "$mode" "$t" || rc=1
  done
  return $rc
}

run_all() {
  log "MIG instances reported by DCGM (GPU_I_ID profile):"
  mig_instance_ids | while read -r l; do log "  $l"; done
  local n=0 bad=0
  for m in "${PIPE_MODES[@]}" "${API_MODES[@]}"; do
    for t in gpu0 $(expand_target mig); do
      n=$((n + 1)); run_phase "$m" "$t" || bad=$((bad + 1))
    done
  done
  # HAMi-limited: the two ebpf_hami_* families need a pod constrained by HAMi,
  # not by the card. `errors` asks for an allocation far past the 2 GiB limit,
  # which is what HAMi's interposer refuses; `sustained` saturates against the
  # 20-core limit. `malloc-free` runs too, as the ordinary-allocation control.
  for m in errors sustained malloc-free; do
    n=$((n + 1)); run_phase "$m" hami || bad=$((bad + 1))
  done
  log "ran $n phases, $bad could not run"
}

repartition() {
  local profile="$1"
  cat >&2 <<EOF
--repartition destroys the MIG instances that exist now and changes cluster
state. It is never run as part of --all. Current instances:
EOF
  mig_instances >&2
  read -r -p "re-partition GPU 1 into $profile? [yes/NO] " ans
  [ "$ans" = yes ] || { log "aborted"; return 1; }
  nvidia-smi mig -i 1 -dci && nvidia-smi mig -i 1 -dgi || {
    log "could not destroy existing instances"; return 1; }
  nvidia-smi mig -i 1 -cgi "$profile" -C || { log "could not create $profile"; return 1; }
  log "re-partitioned; DRA needs a moment to re-advertise"
  mig_instances
}

pod_reason() {
  kubectl -n "$NS" get pod -l "job-name=$1" \
    -o jsonpath='{range .items[*].status.conditions[*]}{.type}={.status}({.reason}) {end}' 2>/dev/null
}

main() {
  local mode="" target="" action=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --phase) mode="$2"; action=one; shift 2;;
      --target) target="$2"; shift 2;;
      --duration) DURATION="$2"; shift 2;;
      --all) action=all; shift;;
      --repartition) action=repart; target="${2:-1g.6gb}"; shift; [ $# -gt 0 ] && shift;;
      *) log "unknown argument: $1"; return 2;;
    esac
  done
  case "$action" in
    one)  [ -n "$target" ] || { log "--phase needs --target"; return 2; }
          run_target "$mode" "$target";;
    all)  run_all;;
    repart) repartition "$target";;
    *) log "usage: run.sh --phase <mode> --target <gpu0|mig|mig:ID|hami> | --all | --repartition <profile>"; return 2;;
  esac
}

main "$@"
