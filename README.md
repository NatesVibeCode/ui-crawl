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
| `ui_fix_plan` | **Start here after an audit.** Ordered work order — one step per root cause, worst first, each with the `file:line`, the concrete fix, and the picture. Returns `done` / `exitCriteria` so you know when to stop. Reads the last run without re-crawling. |
| `ui_open` | Open a live browser session; returns a `sessionId`, a numbered snapshot, and a screenshot `image` block. |
| `ui_act` | One action; returns the verdict, the signals, the new snapshot, and a screenshot `image` block. `snapshot: full\|changed\|none` controls list verbosity; `dialog: accept\|dismiss` decides native dialogs. |
| `ui_close` | Release a session. |
| `ui_login` | Replay a login flow; returns a `storageState` object for `ui_audit` / `ui_open`. COMMITS — dev targets only. |
| `ui_snapshot` | Numbered control list, standalone or from a live session. |
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
