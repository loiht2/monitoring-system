# 13 — UI visual design

How the advanced monitoring UI should look and behave. [12](12-monitoring-ui.md) specifies what it renders
and where the data comes from; this document specifies the presentation, and replaces §4 of that document.

Reference mockups were used while designing this and are not kept in the repository: they were
direction, not specification, and §7 records what was deliberately not taken from them.

---

## 1. Tokens

Dark only. The deployment has no light surface and the mockups have none; the token structure below would
support one later, but a light mode is **not** built now (a selected light palette is real work, not an
inversion).

### 1.1 Surfaces and ink

| Role | Value |
|---|---|
| Page plane | `#0b0f16` |
| Panel surface | `#131922` |
| Raised surface (control bar, row header) | `#1a212c` |
| Hairline border | `rgba(255,255,255,0.08)` |
| Primary ink | `#e6edf3` |
| Secondary ink | `#9aa7b4` |
| Muted ink (axis, ticks) | `#6e7d8d` |
| Gridline | `rgba(255,255,255,0.06)` |

Panels sit one step lighter than the page so a card reads as a card without a heavy border. The gridline is
deliberately weaker than any series colour.

### 1.2 Series palette — validated, do not eyeball

The reference palette's **dark** column, validated against this project's panel surface:

```
$ node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" \
      --mode dark --surface "#131922"
  [PASS] Lightness band       all 8 inside L 0.48–0.67
  [PASS] Chroma floor         all 8 >= 0.1
  [PASS] CVD separation       worst adjacent #c98500↔#199e70 ΔE 8.4 (protan) · tritan 8.7
  [PASS] Normal-vision floor  worst adjacent #d55181↔#c98500 ΔE 19.3
  [PASS] Contrast vs surface  all 8 >= 3:1
  → ALL CHECKS PASS
```

| Slot | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| | `#3987e5` | `#d95926` | `#199e70` | `#c98500` | `#d55181` | `#008300` | `#9085e9` | `#e66767` |

**Changing any hex invalidates the result — re-run the validator, do not reason about it.** An earlier
version of this palette used the reference set's *light-mode* steps on this dark surface: four of eight fell
outside the lightness band and one sat at 2.02:1, an invisible series. It looked plausible and was wrong,
which is why the rule is to measure rather than judge by eye.

### 1.3 Series-to-slot assignment

Two rules, both currently violated:

- **Colour follows the entity, not its rank.** The series *key* is its label set serialized
  deterministically (label names sorted, `k=v` joined). New keys take the lowest free slot in sorted-key
  order, so the assignment does not depend on the order Prometheus happened to return.

  Stability under filtering needs one more thing: a slot, once given to a key, is **retained for as long as
  the panel lives**, even while that series is filtered out. A purely stateless allocation over the
  surviving set cannot do this — drop the second of three series and the third slides down into the freed
  slot, repainting it. So the allocator takes the panel's previous assignment as input and each panel
  carries its own map across refreshes. The scope is per panel, because colour only has to be consistent
  within one chart.
- **There is no ninth hue.** Beyond eight series, the remainder shares a single muted **Other** colour
  (`#6e7d8d`). Generating a ninth hue is forbidden — the palette is CVD-validated as a set of eight.
  This governs **colour only**: the legend still names every series individually ([§9](#9-the-legend-must-not-eat-the-plot)),
  and a series sharing the Other colour is identified by isolating it, not by its hue.

### 1.4 Status and sequential

Status (reserved — never used for a series): good `#0ca30c`, warning `#fab219`, serious `#ec835a`,
critical `#d03b3b`. Always shipped with a label, never colour alone.

Sequential (the heatmap only): the blue ramp, **dark → light** for low → high. On a dark surface the
near-zero end is the end that recedes into the surface, which is the inverse of the light-mode direction.
Not a rainbow, and not the multi-hue ramp in the software mockup.

---

## 2. Page structure

```
┌ app bar ──────────────────────────────────────────────────────────┐
│ GPU observability                    ● Live · updated 10:42        │
├───────────────────────────────────────────────────────────────────┤
│ GPU HARDWARE                                    ← eyebrow          │
│ GPU Hardware — Device                           ← h1, from catalog │
│ [ Device ] [ MIG instances ] [ Workloads ]      ← tabs             │
│ ⓘ  Physical-device view. …                      ← context banner   │
│ GPU scope ▾   Pod scope ▾   Range ⟨5m 15m 1h…⟩   Refresh ▾  ↻      │
├───────────────────────────────────────────────────────────────────┤
│ ▼ Performance · 8 panels                                          │
│   ┌────────┐ ┌────────┐ ┌────────┐                                │
│ ▶ Memory · 4 panels                                               │
└───────────────────────────────────────────────────────────────────┘
```

**Tabs replace the dashboard `<select>`.** Three dashboards is a tab set; a dropdown hides two thirds of the
product. Tab order follows catalog order.

**The context banner is the dashboard's own `description`.** Every dashboard already carries one, and they
carry real semantics — the MIG one states that instance utilisation must never be summed into a device
total. First sentence in the banner, full text behind a "More" disclosure. Tone by dashboard: the MIG banner
is **warning**-toned because its content is a correctness warning; the other two are informational. No new
config file, no drift: the text stays in the Grafana JSON that `check-dashboards.py` already governs.

**The control bar gains labels and hierarchy.** Time range becomes a segmented control (the mockups' clearest
win — six ranges visible at once instead of hidden in a dropdown). GPU scope becomes a popover with a
summary label ("2 GPUs selected") rather than a raw `<select multiple>`, which cannot show more than a few
rows and gives no indication that it is multi-select. **Pod scope appears only on the Workloads tab**, because
`$pod` exists only in that dashboard — a control that does nothing on two of three tabs is worse than absent.

**Rows become cards with a count.** Panel counts come from `panels.json`; the expanded/collapsed default
comes from the Grafana row state already in the JSON.

---

## 3. Panel anatomy

| Part | Spec |
|---|---|
| Title | Primary ink, 0.9rem, 600 |
| Info affordance | `ⓘ` beside the title, description on hover **and** focus; not a bare `title=` attribute |
| Legend | Above the plot, **outside** the canvas — chips of `● series-name`. Present whenever ≥2 series |
| Plot | Fills remaining height; no in-canvas legend |
| Body padding | 1rem; radius 10 (unchanged, matches the ML Platform destination) |

Legends move out of the canvas because Chart.js's built-in legend consumes plot height and cannot be styled
to match the rest of the page.

---

## 4. The seven renderers

Only presentation changes. No renderer gains a data source, and no panel is added or removed.

| Renderer | n | Change |
|---|---|---|
| `timeseries` | 42 | Validated palette; 2px lines; `pointRadius: 0` with an 8px hover point; recessive grid, horizontal only; external legend; crosshair tooltip; a 0.10-alpha area fill **only when a panel has one series** (translucent fills over each other muddy the plot) |
| `stat` | 3 | Large value in primary ink with a sparkline behind it, per the software mockup. Sparkline needs one extra range query per stat panel — three in total, acceptable |
| `gauge` | 4 | SVG arc: 12px track in the hairline colour, rounded cap, value centred in primary ink, min/max in muted. The current flat rendering is the weakest panel type on the page |
| `bargauge` | 2 | Horizontal bars, 4px rounded data-end anchored to the baseline, 2px surface gap between adjacent bars, value direct-labelled at the end |
| `table` | 5 | Hairline row separators, `tabular-nums`, muted header, no zebra striping |
| `state-timeline` | 1 | Status palette for bands, 2px surface gap between adjacent bands, legend of states above |
| `heatmap` | 1 | Blue sequential ramp plus **a legend gradient bar with min/max labels** — a sequential encoding is unreadable without one |

Text — values, labels, ticks, legends — always wears an ink token, never the series colour. The coloured
chip beside a legend label carries identity; the label itself stays legible.

---

## 5. Template variables (prerequisite, not polish)

`substituteVars` handles `$gpu` only. It must handle every variable the dashboards actually use:

| Variable | Used by | Resolution |
|---|---|---|
| `$gpu` | all | Unchanged: selected `gpu_uuid` values as a regex alternation, `.*` when empty |
| `$pod` | 27 panels | Same treatment over `k8s_pod_name`, driving the Workloads tab's Pod scope control. **Values must be metric-scoped** — see §5.1 |
| `$__range` | 5 panels | The selected range as a duration literal — `1h` for 3600s |
| `$__rate_interval` | 22 panels | `max(step + scrapeInterval, 4 × scrapeInterval)`, Grafana's own rule. `scrapeInterval` is 30s, the widest interval in `deploy/` — the widest is the safe choice, because a rate window narrower than the true scrape interval yields gaps |
| `$__all` | — | Grafana's "All" sentinel; resolves to `.*` like an empty selection |

Substitution stays in the frontend immediately before the request, so the stored spec remains byte-identical
to the Grafana source ([12 §2.2](12-monitoring-ui.md)).

### 5.1 The pod list must be scoped to the metric

The dashboard's own variable query is
`label_values(ebpf_cuda_kernel_launch_calls_total, k8s_pod_name)` — pods that have actually run CUDA work.
The API's `/label/{name}/values` does a bare label lookup instead, which on the live cluster answers with
the monitoring system's own pods. Offering those in a Pod picker is offering selections that can only ever
produce an empty panel.

The endpoint therefore needs to honour the metric-scoped form the variable already specifies, rather than
the UI hardcoding a metric name.

### 5.2 The catalog loses which dashboard owns which variable

`extract-panels.py` does read `templating.list`, but flattens all dashboards' variables into one global
`variables` array deduped by name, and the per-dashboard object carries only `uid`, `title` and `rows`.

Two consequences, both needed by §2: the UI cannot tell that `pod` belongs to the Workloads dashboard alone,
and the dashboard **`description`** — the context banner's text — is not carried at all. Both are additive
extractor changes; no panel content moves.

---

## 6. Empty states

An empty panel is ambiguous, and the ambiguity is what this system exists to remove. Five causes, five
messages — a reader must never have to guess which one they are looking at.

| State | Cause | What it says |
|---|---|---|
| `nodata` | Query succeeded, empty result, metric is supported | "No data in this range" |
| `unsupported` | `gpu_metric_supported` is `0` for every metric on the panel | "Not supported on this GPU" |
| `partitioned` | Device-scope panel, every selected card is MIG-partitioned | "Partitioned into MIG instances — see the MIG tab" |
| `rejected` | Prometheus returned 4xx | "Query rejected", with the upstream reason |
| `down` | Prometheus unreachable (5xx or no response) | "Prometheus unreachable" |

Resolution is most-specific-first: `rejected` → `partitioned` → `unsupported` → `nodata`.

A malformed query is a **bug**, not an observation about the cluster, and must never render as absence of
data. `partitioned` outranks `unsupported` because it is the more precise statement: the reading exists, at
instance scope. Each state carries a distinct colour from the status palette **and** a label — never colour
alone.

This table is canonical. Nothing else specifies panel states.

---

## 7. Not adopted from the mockups

| In the mockups | Decision |
|---|---|
| An "Overview" KPI strip on the Workloads view | **Already exists** — the three `stat` panels in that dashboard's Overview row are exactly these. They need §4's stat treatment, not new panels |
| "Active pods by kernel launches/s" top-N bar list | **Not built.** No such panel exists, and adding one means either new PromQL in the frontend (forbidden by [12 §1.1](12-monitoring-ui.md)) or editing the Grafana dashboards — the change that was backed out previously |
| Multi-hue blue→green→yellow heatmap ramp | **Not adopted.** Sequential encoding is one hue; §1.4 |
| Per-row `⋮` overflow menus | **Not built.** They have no actions behind them |
| A "10 signals" badge by the title | **Not built.** Ambiguous — it is not the panel count |
| Dismissible banner (`×`) | **Not built.** The MIG banner is a correctness warning; it should not be dismissable |

---

## 8. Every displayed number carries its unit

The panel specs already set the right unit on every panel — the gap is that three surfaces never apply it,
and two units are unimplemented. A reader currently meets raw values like `12616466432` where the panel
means 11.8 GiB.

| Surface | Today | Panels |
|---|---|---|
| Chart tooltip | no `callbacks.label`, so Chart.js prints the raw number | **42** |
| Table cells | `s.value[1]` pushed verbatim; `formatValue` is not even imported | 5 |
| y-axis ticks | correct — already formatted | — |
| Stat / gauge / bargauge | correct | — |

And two units fall through `formatValue`'s `default` to a bare SI number:

| Unit | Panels | Today | Should be |
|---|---|---|---|
| `s` | 6 | `si()` renders a 0.000123 s latency as **`0.00`** — the value is destroyed, not just ugly | `123 µs`, scaling through ns/µs/ms/s |
| `ops` | 4 | loses the rate entirely | `1.2K ops/s` |

`s` is the serious one: every latency panel on the eBPF dashboard is a P95/P99 in seconds, so sub-millisecond
values currently render as `0.00` and the panel appears to show nothing happening.

**Memory stays in IEC units — KiB/MiB/GiB, not MB.** `formatValue` already does this and it is deliberate:
`DCGM_FI_DEV_FB_USED` is reported in **MiB** ([02 §0.3](02-metric-catalog.md)), Grafana's `bytes` unit is
IEC, and the dashboards this UI replaces render IEC. Switching to decimal MB would put the native UI 4.9%
adrift of Grafana on the same metric, which is a worse outcome than the unfamiliar `i`. The fix is that the
value gets formatted at all, not that the base changes.

---

## 9. The legend must not eat the plot

Measured: `ebpf_cuda_kernel_launch_calls_total` carries **46 series**. At one chip per series the legend
fills the panel and the chart is pushed out of view entirely — the panel becomes a list of names with no
picture, which is the opposite of what a chart is for.

The legend already had the answer and was not using it. [§1.3](#13-series-to-slot-assignment) folds
everything past the eighth series into a single muted **Other**, because there is no ninth hue. The legend
must show what the plot shows:

**Every series is listed.** An earlier version of this section folded everything past the eighth into a
single `Other — N more series` row. That was wrong: it answered "the legend is too tall" by removing
information, and a panel that will not tell you what it is plotting is not a fixed panel. The height problem
is a *layout* problem and is solved by layout.

| Series | Legend |
|---|---|
| 1 | none — the panel title names it |
| ≥2 | **one row per series, all of them** |

Rows are ordered by palette slot, so the hued series come first and row *n* is series colour *n*
([§1.3](#13-series-to-slot-assignment) allocates slots by sorted series key, which has no relation to query
order — ordering by arrival named a near-random subset).

**Height is capped, not content.** The list scrolls inside a `max-height` of about five rows, and the plot
keeps a `min-height`, so a 47-series panel still shows its chart. Nothing is hidden: it is one scroll away
rather than deleted.

**Colour still stops at eight.** [§1.2](#12-series-palette--validated-do-not-eyeball) is a validated,
CVD-checked palette and a ninth hue would break it, so series beyond the eighth share the muted `OTHER`.
The legend names them individually even though they share a colour, and [§9.1](#91-clicking-a-legend-row-toggles-that-series)
is what makes that useful: a grey series is identified by isolating it, not by its colour.

### 9.1 Clicking a legend row toggles that series

Listing 47 series only helps if you can act on the list. Clicking a row hides or shows that series; the row
dims while hidden. **Alt/⌘-click isolates** — hides every other series — because reaching one series out of
47 by clicking 46 times is not a feature.

Two consequences worth stating:

- **The y-axis rescales to what is visible.** Isolating a small series is how you read it when a large one
  compresses the axis, which is the main reason to want the control at all.
- **Hiding never frees a colour slot.** A hidden series keeps its hue, so unhiding it restores the same
  colour and its neighbours never repaint. This follows from [§1.3](#13-series-to-slot-assignment)'s rule
  that colour follows the entity — toggling is a view state, not a change of identity.

Visibility is per panel and resets on reload. It is not persisted: a hidden series is a temporary act of
looking, and silently restoring one across sessions would mean a panel that hides data without saying so.

This is a display cap, not a query cap. The query is unchanged and the folded series still contribute to the
plot — nothing is silently dropped from the data, only from the list of names.

## 10. A time range the operator chooses

The six presets stay, because they are one click. They are not sufficient: an incident happened between
14:05 and 14:20 yesterday, and no preset expresses that.

Add **Custom** to the segmented control. Selecting it reveals two `datetime-local` inputs and an Apply
button; the segmented control then shows the chosen span. Rules:

- **Apply is disabled while the range is invalid** — `from` at or after `to`, or `to` in the future — with
  the reason stated next to it. A silently-ignored Apply is worse than a disabled one.
- The chosen absolute range is what every panel and every label lookup uses, so a device that existed only
  inside that window is offered and one that did not is not ([12 §2.2](12-monitoring-ui.md)).
- `step` is still derived to keep each query near 200 points, so a 30-day custom range costs what a 30-day
  preset costs.
- The selection is **absolute**, not relative: re-rendering hours later shows the same window, not a sliding
  one. Presets stay relative and continue to follow "now".

## 11. Scope controls are per tab

Each tab asks about a different kind of thing, so each gets the control that fits it —
see [12 §2.3–2.4](12-monitoring-ui.md) for why the underlying source must be DCGM rather than a bare label
lookup.

| Tab | Control | Options |
|---|---|---|
| Device | **GPU scope** | the physical cards. A partitioned card stays selectable and renders the `partitioned` state |
| MIG | **MIG instance** | one entry per instance, labelled `GPU 1 · 1g.6gb · id 3`; sets `$gpu` *and* `$migid` |
| eBPF | **GPU scope** *and* **Pod scope** | cards and instances together, resolved to pods through the workload (§11.1); pod scope narrows further |

No tab offers an entity it cannot plot. The Device tab must never list a MIG instance, and the MIG tab must
never list a whole card. The eBPF tab lists **both**, because a pod runs on either and the correlation is
identical.

### 11.1 The eBPF tab's GPU scope is resolved through the workload, not the metric

The eBPF exporter's own device label is close to useless. Measured over 24h on
`ebpf_cuda_kernel_launch_calls_total`: **43 pods produce series, and the exporter labels 3 of them with a
`gpu_uuid`.** It emits no MIG discriminator at all — no `GPU_I_ID`, no `mig_uuid`.

Filtering the panels on that label would therefore hide ~93% of the data whenever a specific GPU is
selected, silently. `All` appears to work only because `.*` also matches an absent label.

**But the identity exists elsewhere.** The NVML exporter publishes `gpu_alloc_device_pod_info`, which maps a
workload pod to the device it was granted, and it carries `mig_uuid` as well as `gpu_uuid`. Measured against
the same 43 pods:

| Route | Pods resolved |
|---|---|
| eBPF's own `gpu_uuid` label | **3 / 43** |
| Correlating through `gpu_alloc_device_pod_info` | **43 / 43** (17 of them on a MIG instance) |

So the GPU scope stays on the eBPF tab, and is answered by the exporter that actually knows: **a device
selection resolves to the set of pods allocated that device, and that set is substituted into `$pod`.**

```
selection (card or instance)
   → gpu_alloc_device_pod_info{gpu_uuid=…}  or  {mig_uuid=…}
   → the pods that held it in this window
   → $pod
```

Three properties follow, and each is why this beats a PromQL join inside the panels:

- **Panel expressions are unchanged.** No `label_replace` in 27 places to reconcile `pod` with
  `k8s_pod_name`, and no new failure mode where a missing `gpu_alloc` series blanks every eBPF panel at
  once.
- **It composes with Pod scope.** Choosing a GPU narrows the pod set; choosing pods narrows it further. The
  two controls intersect rather than fight.
- **It is time-scoped like every other lookup.** Pod-to-device bindings change; the window decides.

### 11.1.1 The lookup must be windowed, not instant

`gpu_alloc_device_pod_info` describes **current** allocations. Measured: an instant query returns **0
series** while `last_over_time(...[24h])` returns 67, because every evaluation pod has since finished.

An instant lookup would therefore resolve every historical selection to an empty pod set and blank the whole
tab — the same "looks deployed, renders nothing" failure this project keeps meeting. **The query is
`last_over_time(gpu_alloc_device_pod_info[<window>])` over the selected range**, never an instant query.

### 11.1.2 Not every pod can be attributed, and the gap is stated

Coverage is high but not guaranteed. Re-measured a few hours after the first run: **41 of 43** pods
resolved, not 43 — `gpu-burn-a` and `gpu-burn-b` still had eBPF series in the window but their allocation
records had aged out of it. The two metrics are written by different exporters with different lifetimes, so
one can outlive the other inside the same window.

So the UI **counts what it could not attribute and says so** next to the control — "3 pods not attributed to
a device" — rather than quietly narrowing. An unattributed pod stays reachable through Pod scope. It is
never folded into a device's set on a guess, and a device that resolves to nothing yields an empty result
and the ordinary "No data in this range", never every pod.

**An empty pod list cannot express "no pods".** `substituteVars` maps an empty selection to `.*` — that is
correct for a scope control, where "nothing ticked" means "no filter", and it is what makes `All` work. But
it turns the resolve-to-nothing case into *every pod*, which is the precise inversion of the rule above:
the operator selects a device that ran nothing, and sees every other device's workload.

A device that resolves to zero pods therefore substitutes a **sentinel that cannot match a pod name**
(`__none__`; underscores are invalid in Kubernetes pod names). The distinction between "no filter" and
"a filter that matches nothing" has to survive into the query, and an empty list cannot carry it.

### 11.1.3 The join key is (namespace, pod), and name collisions are detected

`gpu_alloc_device_pod_info` carries `namespace` + `pod`; eBPF carries `k8s_namespace_name` +
`k8s_pod_name`. Pod names are unique only *within* a namespace, and two namespaces are already in play here
(`default`, `gpu-burn`). **The join is on the pair.**

Substitution is still by name, because the panel expressions filter `k8s_pod_name=~"$pod"` alone — so if the
same pod name existed in two namespaces, and only one of them was on the selected device, the filter would
over-match into the other. Measured today: 67 distinct `(namespace, pod)` pairs and 67 distinct names, so no
collision exists. That is a property of this cluster, not a guarantee.

The UI therefore **detects the case rather than assuming it away**: when a resolved name appears in more
than one namespace inside the window, it is reported as an ambiguous attribution. If that ever fires
routinely, the fix is a `$podns` variable on the eBPF dashboard, the same shape as `$migid` — deliberately
not built now, because it adds a filter to 27 targets to solve a problem that does not yet exist.

### 11.1.4 The resolved set has a size cap

The pod set becomes a regex alternation. Measured at current scale: 40 pods → 1030 characters, ~1108
URL-encoded, which is comfortable. It grows linearly, so a few hundred pods would approach practical URL
limits.

Above **200 resolved pods the UI stops substituting and falls back to no device filter**, saying so
explicitly. A truncated regex would silently plot a subset while looking complete, which is worse than not
filtering.

### 11.2 A MIG instance has two identifiers, and the UI carries both

DCGM knows an instance as `(gpu_uuid, GPU_I_ID)` and publishes its profile; NVML knows it as `mig_uuid`.
Neither exporter publishes the other's identifier, so **one scope option must carry both**: `GPU_I_ID` to
filter the MIG dashboard's DCGM panels, `mig_uuid` to resolve eBPF pods.

They are joined by the NVML series that carry both — `nvml_gpu_memory_*` and `gpu_metric_supported` — which
is the only place in the system where the two naming schemes meet. The MIG option is therefore assembled
from DCGM (profile, `GPU_I_ID`) plus that bridge (`mig_uuid`), and an operator still picks one thing:
`GPU 1 · 1g.6gb · id 3`.

If the bridge is unavailable, the option is still usable for the MIG dashboard and only the eBPF correlation
degrades — it must degrade to "no pods resolved", never to "all pods".

---

## 12. Verification

| Claim | Check |
|---|---|
| A 47-series panel lists every series AND shows its chart | eBPF tab, "Kernel launch rate by pod": 47 legend rows, scrollable, plot still visible |
| Clicking a legend row toggles its series | click one → the line disappears and the row dims; click again → it returns in the **same** colour |
| Alt-click isolates | alt-click one row → only that series is plotted, and the y-axis rescales to it |
| Tooltips carry units | hover a memory panel → `11.8 GiB`, not `12616466432` |
| Latency panels are readable | a sub-millisecond P95 renders as `123 µs`, not `0.00` |
| Table cells are formatted | no raw Prometheus value strings in any of the 5 table panels |
| Custom range works and validates | Pick a past 15-minute window; panels redraw to it. Set `from` after `to`; Apply is disabled with a stated reason |
| Device tab lists only cards | GPU scope offers exactly the physical cards, and no `MIG-…` entry at any time range |
| MIG tab lists only instances | MIG scope offers one entry per instance, labelled with its profile, and no whole card |
| eBPF GPU scope resolves through pods | Selecting a card yields the pods allocated it — 43/43 resolvable today, versus 3/43 by eBPF's own label |
| eBPF MIG scope works | Selecting an instance narrows to the pods that held it; panels redraw rather than blanking |
| A device selection never over-matches | A pod with no allocation record appears under no card, never under all of them |
| Palette is legal on the real surface | `validate_palette.js` passes all five checks at `--surface #131922`; recorded in §1.2 |
| Colour never follows rank | Unit test: changing the series order leaves each key's slot unchanged |
| Variables resolve | Unit tests per variable; then **zero** panels reach Prometheus with a literal `$` |
| The eBPF dashboard is alive | All 27 panels render data or an honest state — measured against the live cluster, not asserted |
| A rejected query is distinguishable | Force a 400; the panel reads "Query rejected", not "No data" |
| Nothing regressed | `npm test`, `npx tsc --noEmit`, `scripts/check-dashboards.py` → 0 problems |

Layout is checked by looking at it. The validator checks colour, not collisions.
