# AGENTS.md — ui-crawl Agent Manual

`ui-crawl` is an agent-native UI inspection instrument. It exists to be called by an LLM
harness: there is no human in the loop, no HTML report, and no dashboard. Outputs are
structured JSON, indexed DOM snapshots, screenshots with source locations, and exact CSS
remediations.

It offers two shapes of work. Pick deliberately.

| Need | Use |
|---|---|
| "Tell me what's broken across this app" | `ui_audit` / `--base-url` |
| "Look at this page, click *that*, and tell me what changed" | `ui_open` + `ui_act` / `--session` |

---

## 1. Golden rules

1. **stdout is pure data.** JSON payloads or formatted snapshot lines, nothing else. Every
   progress line, warning, and error goes to stderr. You can pipe stdout straight into a
   JSON parser.
2. **Zero dependencies in `src/`.** `src/**` imports only `node:*`, local modules, and
   `playwright`. Enforced by `test/importIndependence.test.ts`. Native SQLite is
   `node:sqlite` (Node 22+).
3. **No standalone Chrome.** Never launch a browser through a shell; it wedges headless
   environments. All automation goes through Playwright.
4. **Vanilla Node.** `node bin/ui-crawl.js` works with no `tsx` and no global TypeScript.
   `bin/ui-crawl.js` is a shim over the compiled `dist/cli.js`; the CLI itself is
   `src/cli.ts`, once, typechecked, and covered by tests.
5. **Defect vs taste is a hard line.**
   - `defect` — positive evidence of brokenness. Exit `1`. Fix these.
   - `taste` — a judgement call. Exit `0`. Informational; never fails a build.
6. **Silence is never a defect.** A control that did nothing is `taste`
   (`maybe-contextual-button`) unless it had a real destination, in which case it is
   `broken-link`. The boundary is deterministic and lives only in `src/triage.ts`.
7. **Never claim a defect the tool did not report.** Do not promote a `taste` finding to
   `defect` in your own output. If you disagree, say so in prose and leave the bucket
   alone.

---

## 2. Batch audit

### CLI

```bash
node bin/ui-crawl.js --base-url http://localhost:3000 --routes /
node bin/ui-crawl.js --dir ./dist                 # auto-discovers HTML routes
node bin/ui-crawl.js --dir ./dist -c 8
node bin/ui-crawl.js --dir ./dist --quick --browser webkit --defects-only
node bin/ui-crawl.js --dir ./dist --rerun-defects
node bin/ui-crawl.js --dir ./dist --theme-sweep --crops --diff
```

Useful flags: `--routes a,b` · `--max-pages N` · `--max-probes N` · `--max-findings N` ·
`--crops` · `--theme-sweep` · `--quick` · `--browser chromium|webkit|firefox` · `-c N` ·
`--diff [runId]` · `--rerun-defects` · `--db <path>|false` · `--out <dir>` ·
`--defects-only` · `--full` · `--login <steps.json>` · `--login-route <path>` ·
`--save-storage <path>` · `--no-marked` · `--no-clicks` · `--no-zoom` · `--no-layout` ·
`--no-contrast` · `--no-spacing` · `--no-hit-test` · `--no-affordance` ·
`--no-guidance` · `--no-network` · `--no-robots` · `--headed` · `--storage-state` ·
`--seed-storage <file>` · `--user-agent` · `--nav-retries N` · `--host-delay MS`

Findings are capped per route (`--max-findings`, default 200): defects outrank taste when
the cap binds, and the dropped count is reported as `summary.truncated` — zero means the
report is complete.

`--ui` was **removed**. It was a human dashboard, which this tool no longer has. A stale
invocation fails with that explanation rather than doing something else.

### MCP — `ui_audit`

Parameters mirror the CLI: `baseUrl` / `dir` / `file`, `routes`, `maxPages`,
`maxProbesPerPage` (default 40), `viewports`, `browser`, `quick`, `themeSweep`,
`captureCrops`, `concurrency`, `headless`, `storageState`, `seedStorage`, `outDir`,
`dbPath`, `diff`, `rerunDefects`, every `skip*`, `guidance`, `networkInventory`, `full`.
The two surfaces are kept in step; a test asserts the CLI's knobs are present.

`ui_login` replays a step list and returns a `storageState` object for gated targets.
It COMMITS — submitting the form really submits it — so point it at a dev target, never
production. Pass the object straight back into `ui_audit` / `ui_open` as `storageState`.

---

## 3. Live session — the navigation loop

Open a session, then act one step at a time. Every action returns the resulting observable
state, so the next decision is grounded in what happened rather than what was intended.

```bash
# Scripted
node bin/ui-crawl.js --session --steps steps.json --dir ./dist
```

```json
[
  { "type": "click", "index": 0 },
  { "type": "resize", "width": 390, "height": 844 },
  { "type": "theme", "scheme": "dark" },
  { "type": "screenshot", "fullPage": true }
]
```

MCP: `ui_open` → `ui_act` (repeatedly) → `ui_close`.

| Action | Arguments |
|---|---|
| `click` | `index` |
| `fill` | `index`, `value` |
| `select` | `index`, `value` |
| `press` | `key` |
| `scroll` | `dy`, `dx` |
| `resize` | `width`, `height` |
| `theme` | `scheme: light \| dark` |
| `screenshot` | `fullPage` |
| `back` / `forward` / `reload` / `wait` | `ms` for `wait` |

MCP `ui_act` also accepts `route` to navigate within the session's origin, and
`snapshot: full | changed | none` to control the control-list verbosity. `full`
re-sends the whole list (the default — an index is only addressable if you have seen
it). `changed` sends only what moved since the last step (`+` added, `~` changed,
`-` gone), for long loops where eighty unchanged lines per step are token burn.
`none` sends no list, for steps where only the verdict and the screenshot matter.

### Addressing controls

Controls are addressed by the `[n]` index in the snapshot — never by guessing a CSS
selector. The index is the element's position in the snapshot's selector set, so
`click { index: 3 }` always hits the element the snapshot described as `[3]`.

If an index is not in the current snapshot the action fails with an error naming the
index. It never clicks something adjacent. Re-snapshot and use a listed index.

`ui_selectors` returns the two selectors the tool uses: the narrow **probe** selector the
click sweep covers, and the broad **snapshot** selector a listing shows. The gap between
them — menus, tabs, `role=combobox`, custom widgets — is exactly where dead controls hide.
If a page has an obviously interactive element the sweep never touched, drive it yourself
through a session.

### Reading an action result

```json
{
  "ok": true,
  "action": "click [0]",
  "index": 0,
  "target": { "tag": "button", "name": "Add item" },
  "url": "http://localhost:3000/",
  "title": "Dashboard",
  "viewport": { "width": 1280, "height": 800 },
  "navigated": false,
  "verdict": "ACTED",
  "signals": { "domMutated": true, "domMutationCount": 2, "networkRequests": 0, "consoleErrors": 0 },
  "snapshot": "[0] button \"Add item\" (covered)\n[1] …",
  "screenshot": "screenshots/session_sess_abc_2.png"
}
```

`verdict` is the same classifier the crawl uses:

- `ACTED` — a positive signal: navigation, network, real DOM mutation, dialog, popup.
- `NOOP` — nothing happened. Not an error. Report it as observed, not as a defect.
- `INCONCLUSIVE` — the click could not be dispatched (element detached, obscured).

`ok: false` means the action itself failed, and `error` says why.

Every session screenshot carries numbered set-of-marks badges: badge `n` sits on control
`[n]`, so the snapshot text grounds to pixels without guessing. The badges are injected
for the shutter and removed before the action returns — verdicts never see them, and
neither does any later step. `markedScreenshots: false` (or `--no-marked`) takes clean
renders instead.

---

## 4. Output schema (`AgentPayload`)

```json
{
  "runId": "run_…",
  "verdict": "clean | has_defects | has_taste_questions",
  "summary": { "defects": 10, "taste": 8, "pagesCrawled": 4, "byType": { "low-contrast": 2 } },
  "actions": [ { "id": "find_…", "fingerprint": "/::low-contrast::p#faint", "route": "/",
                 "type": "low-contrast", "bucket": "defect", "severity": "high",
                 "selector": "p#faint", "title": "…", "remediation": "Set color to #737373 …",
                 "source": { "file": "src/x.tsx", "line": 42, "component": "Card" },
                 "snapshotIndex": 4,
                 "cropBase64": "data:image/png;base64,…",
                 "evidence": { "contrast": { "ratio": 1.99, "fg": "#b4b4b4", "bg": "#fafafa",
                                             "suggestedFg": "#737373", "suggestedRatio": 4.54,
                                             "verified": true, "verifiedRatio": 4.54 } } } ],
  "routes": ["/"],
  "pages": [ { "route": "/", "screenshot": "screenshots/index.png",
               "screenshotFull": "screenshots/index@full.png",
               "darkScreenshot": "screenshots/index--dark.png",
               "screenshotMarked": "screenshots/index@marked.png",
               "zoomShots": [{ "zoom": 2, "screenshot": "screenshots/index@200.png" }],
               "status": 200, "controlCount": 9, "probedControls": 8, "skippedControls": 0 } ],
  "groups": [ { "key": "src:src/theme.css:8", "count": 3, "bucket": "defect",
                "severity": "high", "types": ["low-contrast"], "title": "…",
                "remediation": "Set color to #737373 …",
                "source": { "file": "src/theme.css", "line": 8 },
                "fingerprints": ["…", "…", "…"] } ],
  "diff": { "runA": "run_…", "runB": "run_…", "fixed": [], "regressions": [], "persistent": [] }
}
```

`groups` is the work plan: actions that share a fix site (`src:file:line`, else type +
remediation), so fifty hits from one CSS variable read as one edit with a count.
`actions` still carries every finding; `fingerprints` expands any group back to members.
Iterate `groups` worst-first, not `actions` in order.

**For a vision-capable agent:** `pages[].screenshot` and `actions[].cropBase64` are the
pixels. `pages[].screenshot` is always present; paths are relative to the report
directory (`--out`, default `./ui-crawl-out`). `cropBase64` requires `--crops` /
`captureCrops`.

Over MCP (`ui_open`, `ui_act`, `ui_audit`) the same pixels arrive as native `image`
content blocks after the JSON text, so a model sees them without touching the filesystem.
`ui_audit` strips a crop's base64 from the JSON once its image block is attached — one
delivery, in the native format — but keeps the `crop` file path either way.

Pixel delivery, per surface:

| Surface | Page renders | Per-finding crops |
|---|---|---|
| CLI / `AgentPayload` JSON | `pages[].screenshot` (+`screenshotFull`, `darkScreenshot`) paths | `cropBase64` inline + `crop` file path |
| MCP `ui_audit` | `image` blocks (+ paths in JSON) | `image` blocks (+ `crop` paths; base64 stripped) |
| MCP `ui_open` / `ui_act` | `image` block of the resulting state (+ `screenshot` path) | — |

`screenshot` is the viewport-sized render — the size a model can actually read.
`screenshotFull` is the whole document and exists only when the document exceeds the
viewport (a tall full-page image downscaled to model input is illegible, so the two are
kept separate). `darkScreenshot` exists only with `themeSweep`, and `dark-mode-contrast`
crops are photographed against that dark render, never the light one.
`screenshotMarked` (audit, with `--crops`) and every session screenshot carry numbered
set-of-marks badges grounding `[n]` to pixels; the clean `screenshot` always exists
alongside, because badges occlude.

An action with `snapshotIndex: n` names the badge its element wears: badge `n` in the
marked render, control `[n]` in the snapshot text, and the action are three views of one
element. The index is measured on the pristine render (insertions shift positions, so it
is carried, never re-derived). Elements outside the snapshot pool — plain text, lone
images — wear no badge and carry no index, which is honest, not missing.

**For a text-only agent:** `evidence.contrast.suggestedFg` is a ready-to-paste colour with
a measured ratio. `verified: true` means the suggestion was applied in the live DOM and
re-measured there — the fix provably clears the bar on that page. `verified: false`
means it does not (usually a stylesheet `!important` or `-webkit-text-fill-color`), and
the remediation names the edit that will work instead. `source` is a `file:line` when
the target is a React, Vue, or Svelte component or carries `data-source-file`; it is
absent for plain HTML, which is not an error.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean, or `taste` only. |
| `1` | One or more `defect` findings. |
| `2` | Misconfiguration or missing arguments. |

---

## 5. Findings

| Type | Bucket | Root cause | Remediation |
|---|---|---|---|
| `page-load-error` | defect | Navigation failed or HTTP ≥ 400 | Fix the route |
| `console-error` | defect | Uncaught exception on load | Fix the stack in `evidence.consoleText` |
| `broken-asset` | defect | Asset returned 4xx/5xx | Fix the path or endpoint |
| `dead-button` | defect | Control with a destination did nothing | Attach the handler |
| `button-threw` | defect | Click threw | Fix the handler |
| `broken-link` | defect | Link resolved, no effect | Fix the href or route |
| `layout-overlap` | defect | In-flow siblings collide | `flex-wrap: wrap`, grid, margins |
| `text-overlap` | defect | Leaf text renders on top of other text | Reposition or add spacing |
| `text-line-collision` | defect | Cramped line-height, ink collides | `line-height: 1.2`–`1.4` |
| `text-border-collision` | defect | Descenders hit a border or rule | Add padding inside the container |
| `container-overflow` | defect | Child escapes the container bottom | `height: auto`, `min-height`, margins |
| `sibling-overlap` | defect | Vertical in-flow blocks collide | Increase margin, drop negative offsets |
| `viewport-overflow` | defect | Horizontal blowout, side scrollbar | `max-width: 100%`, wrap flex rows |
| `pointer-intercepted` | defect | Overlay eats the click | `pointer-events: none` or fix `z-index` |
| `low-contrast` | defect / taste | Below 4.5:1 (3.0:1 for large text) | Use `evidence.contrast.suggestedFg` |
| `dark-mode-contrast` | defect | Passes light, fails dark | Same, against the dark background |
| `missing-accessible-name` | defect | Visible control has no name | Add text or `aria-label` |
| `keyboard-inaccessible` | defect | Cannot receive focus | Make it focusable, or use a control |
| `missing-image-alt` | defect | Informative image has no `alt` | Add `alt`, or `alt=""` if decorative |
| `invalid-aria-reference` | defect | ARIA points at a missing id | Fix the id, or drop the attribute |
| `invalid-aria-state` | defect | ARIA state has an invalid value | Use a legal value |
| `dialog-missing-label` | defect | Visible dialog has no accessible name | `aria-label` or `aria-labelledby` |
| `clipped-text` | taste | Truncated, no ellipsis or clamp | `min-width`, or `text-overflow: ellipsis` |
| `small-touch-target` | taste | Under 24×24 px | Padding or `min-width`/`min-height` |
| `tight-target` | taste | Adjacent controls under 4 px apart | Add spacing |
| `missing-affordance` | taste | No hover/focus change, no pointer cursor | Add `:hover` and `cursor: pointer` |
| `maybe-contextual-button` | taste | Did nothing — dead, or needs input first? | Investigate; not a verdict |
| `redundant-control` | taste | Two controls, one destination | Consolidate |
| `zoom-clip` / `zoom-overlap` | taste | Overlaps or clips at zoom | Usually acceptable reflow; look at the screenshot |
| `stale-selector` | taste | Control vanished after re-navigation | Usually a race, not a bug |
| `vertical-rhythm-drift` | taste | Irregular gaps between sections | Tighten to a spacing scale |
| `viewport-scale-imbalance` | taste | Hero heading eats the fold | Reduce heading size or count |
| `unanchored-divider-bleed` | taste | Rule wider than the content column | Constrain to the grid |
| `adjacent-wordmark-echo` | taste | Wordmark repeated in the hero subhead | Reword |
| `robots-blocked` | taste | robots.txt disallowed it; not fetched | Not our call |
| `bot-challenge` | taste | WAF interstitial; the app never rendered | Not a pass — the page was not audited |

---

## 6. Closed-loop remediation

**Start with `ui_fix_plan` (or `--plan`).** It reads the last run from the database — no
re-crawl, no browser — and returns the work order already grouped, ordered, and located,
so you do not spend tokens re-deriving any of it. `ui_audit` also accepts `planOnly: true`
to return the same shape straight from a fresh crawl.

```json
{
  "done": false,
  "exitCriteria": "10 defect root causes remaining. Re-run after each edit; complete when done is true.",
  "summary": { "defects": 10, "taste": 8, "remainingGroups": 10, "pagesCrawled": 4, "truncated": 0 },
  "steps": [
    { "step": 1, "key": "src:src/theme.css:8", "count": 3,
      "do": "Fix on src/theme.css:8: Set color to #737373 — same hue, darkened, 4.54:1 against #fafafa",
      "file": "src/theme.css", "line": 8, "types": ["low-contrast"], "route": "/",
      "screenshot": "screenshots/index.png", "crop": "crops/index_0.png", "snapshotIndex": 6,
      "helpUrl": "https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html",
      "tags": ["wcag2aa"] }
  ],
  "fixed": 2,
  "tasteQuestions": [ { "type": "clipped-text", "route": "/", "title": "…" } ]
}
```

Rules the plan encodes for you:

- **One step per root cause, not per finding.** `count` is how many findings that single
  edit clears. Fifty contrast hits from one CSS variable are one step.
- **`done: true` is the stopping condition.** It is true only when no *defect* group
  remains; taste questions never block.
- **Taste is deliberately excluded from `steps`** and reported separately, because a
  judgement call is not an edit to make unilaterally.
- **`regressions` and `fixed`** come from the diff against the previous stored run, so
  "what did I just break" needs no second crawl.

`--plan` exits `0` when `done` and `1` while defects remain, so it works in a CI gate.

---

## 7. Closed-loop remediation (raw payload path)

```
run --dir ./dist
  │
  ├─ exit 0 ───────────────────────────────────────────► done
  │
  └─ exit 1 (has_defects)
        │
        ├─ parse groups[] from stdout (worst-first), expanding to actions[] by fingerprint
        ├─ for each group, in severity order:
        │     1. open source.file at source.line, if present
        │     2. look at cropBase64 (vision) or pages[].screenshot
        │     3. apply the remediation once — it fixes every member
        │
        └─ re-run, then check diff:
              diff.fixed       → confirmed repaired
              diff.regressions → you broke something; fix it before continuing
              diff.persistent  → not fixed; re-read the evidence
              repeat until summary.defects == 0
```

Findings are fingerprinted by content, not position: inserting a control above another
does not rename either finding, so a repair diff reads as repairs, not churn. (One
exception: fingerprints minted before content-based identity re-baseline once.)

The database keeps the complete finding set even when the payload is capped, so a
finding dropped from view never reads as "fixed" in the next diff. `summary.truncated`
tells you the payload is a partial view; the diff is always over whole runs.

Use `--rerun-defects` to re-audit only the routes that failed. Use `--defects-only` to keep
stdout small when you only care about breakage.

---

## 7. Verification

```bash
npm run build      # compile src/ to dist/
npm test           # hermetic suite
npm run test:live  # + real-browser session/interaction/parallel suites
npm run typecheck
```
