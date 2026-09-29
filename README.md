# @aidev/ui-crawl

An agent-native UI inspection instrument. It does two things, and only these two:

1. **Batch audit** — crawls many routes at once and reports visual, layout, contrast,
   accessibility, and interaction defects with a `file:line` to edit and a screenshot of
   the defect.
2. **Live session** — opens a real browser that an agent drives one action at a time, so
   it can look at a page, click one specific control, look again, and reason about the
   difference.

It assumes **no human is in the loop**. There are no visual galleries, no HTML reports, and
no dashboards. Every output is either structured JSON on stdout, a file an agent can read,
or an image an agent can look at.

---

## Quickstart

```bash
npm install
npm run build
```

### Batch audit

```bash
# A running dev server
node bin/ui-crawl.js --base-url http://localhost:3000 --routes /

# A static build (auto-discovers every HTML route)
node bin/ui-crawl.js --dir ./dist

# Parallel across 8 workers, with dark-mode sweep and per-finding crops
node bin/ui-crawl.js --dir ./dist -c 8 --theme-sweep --crops

# WebKit, mechanical defects only, no clicks
node bin/ui-crawl.js --dir ./dist --browser webkit --defects-only

# Re-audit just the routes that failed last run
node bin/ui-crawl.js --dir ./dist --rerun-defects
```

### Live session

```json
[
  { "type": "click", "index": 0 },
  { "type": "resize", "width": 390, "height": 844 },
  { "type": "theme", "scheme": "dark" },
  { "type": "screenshot" }
]
```

```bash
node bin/ui-crawl.js --session --steps steps.json --dir ./dist
```

Each step reports the `ACTED`/`NOOP` verdict, the signals behind it, the resulting URL, a
fresh numbered snapshot, and a screenshot.

### Local TUI evaluation and live session

`ui-crawl` evaluates beyond the browser: it can see, manipulate, and audit local terminal user interfaces (TUIs) running in a pseudo-terminal.

```bash
# Batch audit a local TUI command (startup health, WCAG ANSI contrast, clipping, control responsiveness)
node bin/ui-crawl.js --tui "python3 my_app.py"

# Inspect terminal controls and formatted screen text
node bin/ui-crawl.js --tui "python3 my_app.py" --snapshot

# Capture a rendered PNG screenshot of the terminal window
node bin/ui-crawl.js --tui "python3 my_app.py" --shot terminal.png

# Replay an interactive scripted session against a local TUI
node bin/ui-crawl.js --session --steps steps.json --tui "python3 my_app.py"
```

### Snapshots and shots

```bash
node bin/ui-crawl.js --snapshot --file ./index.html
node bin/ui-crawl.js --snapshot --file ./index.html --json
node bin/ui-crawl.js --shot preview.png --dir ./dist
node bin/ui-crawl.js --shot modal.png --dir ./dist --selector "dialog#lead-modal"
```

### History and diffs

```bash
node bin/ui-crawl.js --history --limit 5
node bin/ui-crawl.js --diff
```

### MCP server

```bash
node bin/ui-crawl.js --mcp
```

```json
{
  "mcpServers": {
    "ui-crawl": {
      "command": "node",
      "args": ["/path/to/ui-crawl/bin/ui-crawl.js", "--mcp"]
    }
  }
}
```

| Tool | Purpose |
|---|---|
| `ui_audit` | Batch audit. Every CLI knob is exposed; the two surfaces do not diverge. Page renders and finding crops arrive as native `image` blocks after the JSON text. |
| `ui_tui_audit` | Batch audit a local TUI command: startup health, WCAG ANSI contrast, clipping/overflow, and control responsiveness. Emits `AgentPayload` with rendered terminal screenshot. |
| `ui_fix_plan` | **Start here after an audit.** Ordered work order — one step per root cause, worst first, each with the `file:line`, the concrete fix, and the picture. Returns `done` / `exitCriteria` so you know when to stop. Reads the last run without re-crawling. |
| `ui_open` | Open a live browser session (or TUI session with `tui: "cmd"`); returns a `sessionId`, a numbered snapshot, and a screenshot `image` block. |
| `ui_tui_open` | Open a live local TUI session; returns a `sessionId`, numbered control list, formatted screen text, and rendered terminal screenshot. |
| `ui_act` / `ui_tui_act` | One action (browser click/fill/press or TUI press/write/type/click/resize); returns the verdict, signals, new snapshot, and a screenshot `image` block. |
| `ui_close` | Release a browser or TUI session. |
| `ui_login` | Replay a login flow; returns a `storageState` object for `ui_audit` / `ui_open`. COMMITS — dev targets only. |
| `ui_snapshot` | Numbered control list, standalone or from a live browser/TUI session. |
| `ui_selectors` | What this tool can and cannot see — the probe selector vs the snapshot selector. |
| `ui_diff` | Fixed / persistent / regressions between two runs. |
| `ui_history` | Past runs with verdicts and counts. |

### Gated targets

```bash
# Save a login once, audit with it ever after
node bin/ui-crawl.js --login login-steps.json --save-storage state.json \
  --login-route /login --dir ./dist
node bin/ui-crawl.js --dir ./dist --storage-state state.json

# Or do both in one run (state stays in memory, never touches disk)
node bin/ui-crawl.js --login login-steps.json --login-route /login --dir ./dist
```

A login replays real steps and really submits the form — unlike the audit sweep, which
never commits a mutating request. Dev targets only.

---

## Output

stdout is pure data. Progress and diagnostics go to stderr.

```json
{
  "runId": "run_1790285831742_a146e4",
  "verdict": "has_defects",
  "summary": {
    "defects": 10,
    "taste": 8,
    "pagesCrawled": 4,
    "byType": { "low-contrast": 2, "layout-overlap": 1 }
  },
  "actions": [
    {
      "id": "find_5c1b707a",
      "fingerprint": "/::layout-overlap::.card-index",
      "route": "/",
      "type": "layout-overlap",
      "bucket": "defect",
      "severity": "high",
      "selector": ".card-index",
      "title": "In-flow elements collide",
      "remediation": "Add flex-wrap: wrap to container .card-header",
      "source": { "file": "src/components/CardHeader.tsx", "line": 42, "component": "CardHeader" },
      "cropBase64": "data:image/png;base64,iVBORw0KGgo...",
      "evidence": { "layout": { "otherSelector": ".research-badge", "overlapFrac": 0.35 } }
    }
  ],
  "routes": ["/"],
  "pages": [
    {
      "route": "/",
      "screenshot": "screenshots/index_html.png",
      "zoomShots": [
        { "zoom": 1.5, "screenshot": "screenshots/index_html@150.png" },
        { "zoom": 2, "screenshot": "screenshots/index_html@200.png" }
      ],
      "status": 200,
      "controlCount": 9,
      "probedControls": 8,
      "skippedControls": 0
    }
  ],
  "diff": { "runA": "run_…", "runB": "run_…", "fixed": [], "regressions": [], "persistent": [] }
}
```

`actions` arrive defects-first, severest first. `groups` collapses actions that share a
fix site (`src:file:line`, else type + remediation) into one edit with a count — fix the
group once, not each member. Findings are fingerprinted by content, not DOM position, so
inserting a control does not rename its neighbours' findings in the next diff.

`pages[].screenshot` paths are relative to the report directory (`--out`, default
`./ui-crawl-out`). `screenshot` is the viewport-sized render a model can actually read;
`screenshotFull` is the whole document and exists only for tall pages;
`darkScreenshot` exists only with `--theme-sweep`. `cropBase64` is present only with
`--crops`, alongside a `crop` file path for callers with filesystem access. Over MCP the
same pixels arrive as native `image` content blocks — see AGENTS.md §4.

Findings are capped per route (`--max-findings`, default 200): defects outrank taste when
the cap binds, and `summary.truncated` reports the dropped count — zero means complete.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | No defects — clean, or taste questions only. |
| `1` | One or more mechanical defects. |
| `2` | Misconfiguration or missing arguments. |

---

## What it detects

**Mechanical (`defect`, exit 1)** — positive evidence of brokenness:

`page-load-error` · `console-error` · `broken-asset` · `dead-button` · `button-threw` ·
`broken-link` · `low-contrast` (< 3.0:1) · `missing-accessible-name` ·
`keyboard-inaccessible` · `missing-image-alt` · `invalid-aria-reference` ·
`invalid-aria-state` · `dialog-missing-label` · `layout-overlap` · `text-overlap` ·
`text-line-collision` · `container-overflow` · `sibling-overlap` · `viewport-overflow` ·
`pointer-intercepted` · `dark-mode-contrast` · `text-border-collision`

**Judgement calls (`taste`, exit 0)** — a human or the calling model decides:

`clipped-text` · `small-touch-target` · `tight-target` · `missing-affordance` ·
`maybe-contextual-button` · `redundant-control` · `zoom-clip` · `zoom-overlap` ·
`stale-selector` · `vertical-rhythm-drift` · `viewport-scale-imbalance` ·
`unanchored-divider-bleed` · `adjacent-wordmark-echo`

**Not our bug, and never a silent pass:** `robots-blocked` and `bot-challenge` (a WAF
interstitial means the app never rendered; that is reported, not swallowed).

The boundary is deterministic and lives in exactly one place (`src/triage.ts`). **Silence
is always `taste`, never a `defect`.** There is no model in that path: this tool is called
by a model, and a nested one would spend the caller's budget without their choosing and
make the output non-reproducible for no gain.

---

MIT licensed. See [`LICENSE`](./LICENSE).

## Design notes

- **One CLI implementation.** `src/cli.ts` is the whole command line; `bin/ui-crawl.js` is
  a shim. It used to exist twice, with nothing asserting the copies agreed.
- **`src/` imports only `node:*`, relative modules, and `playwright`.** Enforced by
  `test/importIndependence.test.ts`.
- **Evidence is resolved before the page moves.** Controls are enumerated on the pristine
  render and their boxes travel with the finding, because the interaction sweep clicks
  links and by the time it finishes the document is often a different page. Crops taken
  after a navigation would be pictures of the wrong thing.
- **Crops are honest and scroll-aware.** Every finding type can produce one: the element
  is scrolled into view and re-measured before the shutter, so below-fold findings get
  real pictures. A finding whose element cannot be resolved carries no image rather than
  a misleading one. Hit-testing likewise scrolls each control into view, so pointer
  interception is checked below the fold instead of skipped.
- **Final pixels, deterministically.** Navigation waits for webfonts (bounded) before any
  audit or screenshot, and every browser context emulates `prefers-reduced-motion` so
  looping media does not jitter screenshots or mutation counts.
- **Contrast remediation names a colour.** `Set color to #737373 — same hue, darkened,
  4.54:1 against #fafafa` — measured, not predicted. When no hue-preserving shift clears
  the bar, the remediation says to change the background instead.
- **Remediations are audited, not just emitted.** Each suggestion is applied in the live
  DOM and re-measured; `verified: true` means the fix provably works on that page, and a
  failure names the real edit (`!important` weight, `-webkit-text-fill-color`).
- **No arbitrary evaluation.** The session exposes navigation and visual interaction. It
  does not expose `eval`; nothing in looking at a page needs it.
- **Web components are not a blind spot.** Open shadow roots are pierced for control
  enumeration, snapshots, badges, the click sweep, and evidence resolution — so a finding
  inside a component still gets a `file:line`, a badge, and a crop. The contrast palette
  and the layout/typography/spacing passes do not pierce yet; see AGENTS.md §2b.
- **Snapshots ground to pixels.** Session screenshots and `--crops` audit renders carry
  numbered set-of-marks badges: badge `n` is control `[n]`, so the text list and the
  image agree without guessing. Actions name their badge in `snapshotIndex`. Clean
  renders always exist alongside.

### Prior art

The set-of-marks grounding technique is not ours. It originates in Set-of-Mark prompting
research and is used by agent frameworks including `browser-use`; we implemented it
independently here. Everything else in `src/` is original to this repo, and the only
runtime dependency is Playwright.
- **Sessions are bounded.** Four concurrent, then a loud error rather than evicting a
  session a caller still holds an id for.

---

## Development

```bash
npm run build      # compile src/ to dist/
npm test           # hermetic suite
npm run test:live  # + real-browser session, interaction, and parallel suites
npm run typecheck
```

Agent contracts, MCP schemas, and the closed-loop remediation workflow are in
[`AGENTS.md`](./AGENTS.md).


### Terminal interaction guarantees

TUI batch audits are observation-only by default. `probeControls: true` or CLI
`--probe-controls` explicitly enables real mouse actions and can change application
state. Terminal controls inferred from text are labeled candidates, not semantic UI
controls. An indexed action requires a previously returned, still-matching candidate.

`Ctrl` and `Control` key names are accepted, including modified navigation such as
`Ctrl+PageUp`, `Ctrl+End`, and `Shift+Tab`. Unsupported keys/actions fail explicitly.
Clicks and wheel events require the application's mouse mode; wheel `dx`/`dy` values
are terminal wheel steps (up to 100 per action). `fill` targets the focused candidate
and never adds Enter. `type`/`paste` use bracketed paste when enabled; multiline input
without that mode is rejected. `write` explicitly sends raw application input.

Resize uses a separate framed PTY control pipe. Snapshots preserve Unicode graphemes
and terminal cell widths. Screenshots render that cell grid in Playwright; they are
not native-terminal captures. Each session retains `.ansi` output and `.screen.json`
state alongside screenshots. Failed screenshots are reported, not silently passed.
Check expected screen changes to establish task success; `ACTED` alone is insufficient.


### Measuring terminal spacing

`measureTuiSpacing(session.screenBuffer, specs)` checks named regions in terminal
cells. Supply a known rectangle or the surface's exact background color, minimum
rows/columns, padding on each edge, a preceding gap, and text that must stay visible.
The result includes measured bounds, padding, and explicit violations. Missing or
offscreen surfaces fail the check. It does not guess which text is an editor or
turn subjective density into a defect finding.

```ts
const checks = measureTuiSpacing(session.screenBuffer, [{
  name: 'composer', background: '#171d17', minRows: 5,
  minPadding: { top: 1, bottom: 1, left: 2, right: 2 },
  minGapBefore: 1, requiredText: ['first draft line', 'third draft line'],
}]);
```

Wait for the application surface to appear before checking it. Exercise empty,
multiline, and wrapped drafts at representative sizes; inspect screenshots as well
as measurements. The exported TypeScript types are `TuiSpacingSpec` and
`TuiSpacingMeasurement`.

### Explicit terminal contracts and temporal evidence

A screenshot, an `ACTED` verdict, or an animated spinner does not prove a usable
session. Use `ui_tui_check` on an open session for named surface padding and
visible-content assertions. `readyText` waits for the application frame (not just
startup escape bytes); measurements run once after readiness, so the tool never
waits for bad spacing to become a pass. Readiness timeout, missing text, ambiguous
background rectangles, and screenshot failures are explicit failures. Coordinates
are zero-based terminal cells. Background selection requires one solid rectangle;
use explicit `bounds` when the same color paints multiple areas.

CLI: `ui-crawl --tui "aoa" --tui-check contracts.json --cols 80 --rows 24`

```json
{
  "readyText": ["ÆLTUM"],
  "timeoutMs": 3000,
  "requiredText": ["Enter send"],
  "spacing": [{
    "name": "composer", "background": "#171d17", "minRows": 5,
    "minPadding": {"top": 1, "bottom": 1, "left": 2, "right": 2},
    "minGapBefore": 1
  }]
}
```

Scripted TUI sessions also accept `{ "type": "check", ...contract }` and
`{ "type": "observe", ...observation }` steps. Failed explicit checks or failed
actions exit 1; invalid options exit 2. These contract results are separate from
heuristic findings and never promote `taste` into `defect`.

`ui_tui_observe` / `observeTui(session, options)` samples changed visible text for
up to 10 seconds. `bounds` can exclude status spinners. A `sequence` requires
milestones in different changed samples; `absentText` distinguishes partial output
from the completed response. The result retains timed frames, missed milestones,
and evidence truncation. Without a sequence, `passed` is null: observation alone
is not a successful evaluation. Start observation before the behavior of interest;
in JS the observation promise can run concurrently with an explicit send action.

```json
{
  "durationMs": 4000, "intervalMs": 40,
  "sequence": [
    {"name": "progress before completion", "text": "Checking files", "absentText": ["Done"]},
    {"name": "tool before completion", "text": "Running file_read", "absentText": ["Done"]},
    {"name": "completed", "text": "Done"}
  ]
}
```

Use application-specific assertions for menu titles, selected rows, exit hints,
model identity, tool availability, long-history navigation, and draft preservation.
A zero-tool session cannot prove tool rendering. A static screen cannot prove
streaming. Provider logs prove execution; temporal screens prove what was visible.
Clipboard selection/copy and native terminal shortcuts require a native-terminal
check; PTY screenshots do not prove them. Test copy/export/fork explicitly when
those features are expected, rather than assuming a chat-looking screen has them.
No check launches model inference beyond the command/actions the caller supplies.

Use `maxGapBefore` on a named terminal surface to bound excessive blank rows
between related transcript blocks. It can be combined with `minGapBefore` to
assert an exact gap; minimums greater than maximums are rejected.
