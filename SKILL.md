---
name: ui-crawl
description: Inspect and fix web UI with Playwright. Use when asked to audit, check, review, or visually verify a web page or app — finding visual/layout/contrast/accessibility/interaction defects, verifying a change didn't break the UI, or driving a page step by step to see what a control does. Also use for "does my UI look right", "check accessibility", "find dead buttons", "audit the site", or when given a URL or dev server and asked what looks broken.
---

# ui-crawl

An instrument for looking at a web page and fixing what is wrong with it. There is no
human in the loop: every output is JSON, a screenshot, or a file you can read.

## The one thing to understand first

Findings land in exactly two buckets, and the distinction is the whole contract:

| Bucket | Meaning | Your job |
|---|---|---|
| **`defect`** | Positive evidence of something is broken | **Fix it.** |
| **`taste`** | A judgement call — ambiguous, or a decision, not a fault | Report it, don't unilaterally change it. |

**Silence is never a defect.** A control that did nothing when clicked is `taste`, not
"broken" — unless it had a real destination, in which case it is `broken-link`. If you
disagree with a bucketing, say so in prose and leave the bucket alone. Never promote a
`taste` finding to a `defect` in your own output.

## Pick the right tool

| Your situation | Use |
|---|---|
| "What's broken across this app?" | `ui_audit`, then `ui_fix_plan` |
| "Evaluate / audit a local TUI or CLI app" | `ui_tui_audit` / `--tui <cmd>` |
| "Look at this page, click *that*, tell me what changed" | `ui_open` + `ui_act` |
| "Drive a local TUI step by step (keys, input, click)" | `ui_tui_open` + `ui_tui_act` / `ui_open {tui}` |
| "Did my change break anything?" | re-run `ui_audit`, then `ui_fix_plan` |
| A page needs auth | `ui_login` once, pass `storageState` onward |
| "Which controls exist?" | `ui_snapshot` / `ui_selectors` |

## The default workflow (follow this)

```
1. ui_audit        → verdict + findings
2. ui_fix_plan     → ordered work order, worst root cause first, with exitCriteria
3. for each step:
     a. open source.file at source.line
     b. LOOK at the crop / screenshot (or read the evidence if you can't see images)
     c. make the edit
     d. re-run ui_audit
     e. ui_fix_plan again
4. stop when done == true
```

**Step 2 exists so you don't have to group, order, or prioritise findings yourself.**
Read `steps[]` in order. `count` is how many findings that one edit clears. `done: true`
is your stopping condition — stop when it's true, don't keep hunting.

## Reading the numbers you get back

- **`verdict`**: `clean` · `has_defects` (fix these) · `has_taste_questions` (decisions)
- **`summary.truncated > 0`** → the payload is a partial view; some findings are counted
  but not shown. Not a clean run.
- **Exit codes**: `0` clean/taste-only · `1` defects present · `2` you passed a bad argument
- **`evidence.contrast.suggestedFg`** → a ready-to-paste colour with a measured ratio.
  `verified: true` means it was applied in the live DOM and re-measured, so it provably
  works. `verified: false` + a note means a stylesheet overrides it — the note names the
  edit that will work instead. **Prefer the suggested colour over computing your own.**
- **`source: {file, line}`** → the exact fix site. Absent for plain HTML, which is fine.
- **`helpUrl`** → ground truth (WCAG) to check a remediation against. Don't guess past it.
- **`tags`** → `wcag2aa` / `wcag22aa` (published criteria) · `usability` · `best-practice` ·
  `reliability` · `internal` (about our crawl, not the page — robots, challenges). Filter
  on these when someone asks for "WCAG issues" or "real bugs, not opinions".

## Controlling token cost

You are probably paying per token. Spend deliberately:

- **`snapshot: changed`** on `ui_act` after the first step — sends only what moved
  (`+` added, `~` changed, `-` gone). Huge saving over long loops. `full` is the default
  and is what you need before addressing an index. `none` when only the verdict and the
  picture matter.
- **`includeTaste: false`** on `ui_fix_plan` when the user asked for bugs, not opinions.
- **`--defects-only`** / skip flags in the CLI when you only care about breakage.
- **Don't request `full: true`** (full findings.json) unless you need the raw dump —
  `ui_fix_plan` is the ergonomic view.
- **Do use `captureCrops: true` if you can see images.** The crops are the fastest route
  to "what does this actually look like".

## Addressing controls (live sessions)

Controls are addressed by the `[n]` index in the snapshot. **Never guess a CSS selector.**

- The index is the element's position in the snapshot's selector set, so
  `click {index: 3}` hits exactly what `[3]` described.
- **An index you haven't seen will fail loudly** with an error naming it. That is by
  design: it will not click something adjacent. Re-snapshot and use a listed index.
- `snapshotIndex` on a finding is the same number the marked screenshot badges show, so
  `screenshotMarked` + `snapshotIndex` ground a finding to pixels.

## What counts as "it worked" in a session

`verdict` from `ui_act` is measured, not assumed:

- **`ACTED`** — a positive signal: navigation, network, real DOM mutation, dialog, popup.
- **`NOOP`** — nothing happened. **Report this as observed, not as a defect.** A control
  that needs prior input will do this legitimately.
- **`INCONCLUSIVE`** — the click couldn't be dispatched (detached, obscured).

Three `NOOP`s in a row usually means a blocking modal, or you need to scroll. Reload and
re-snapshot before concluding anything is broken.

## Things that will waste your time if you don't know them

- **No arbitrary `eval`.** There is deliberately no "run JS" tool. If you think you need
  one, you probably want `ui_act` with `press`, or a session action.
- **`ui_login` COMMITS.** It really submits the form. Dev targets only, never production.
- **The audit sweep never commits a mutating request**, so a destructive-looking button
  is never actually clicked for real. But `ui_login` is the exception.
- **A `bot-challenge` or `robots-blocked` finding means the page was never audited.** It
  is `taste`, not a pass. Say so; don't report it as "no issues found".
- **Duplicate viewport labels get dimensions appended** automatically — your screenshots
  won't silently overwrite each other.
- **Web components work.** Controls inside open shadow roots appear in the snapshot, get
  numbered badges, and are clickable by index. If a control is missing from a snapshot
  entirely, it is most likely in a closed shadow root — which is genuinely opaque.
- **Findings are fingerprinted by content, not DOM position.** Inserting an element does
  not rename its neighbours' findings, so a repair diff reads as repairs, not churn.

## CLI equivalents (when you have no MCP)

```bash
node bin/ui-crawl.js --base-url http://localhost:3000 --routes / --crops
node bin/ui-crawl.js --dir ./dist --defects-only
node bin/ui-crawl.js --plan                      # work order for the last run, no re-crawl
node bin/ui-crawl.js --session --steps steps.json --dir ./dist
node bin/ui-crawl.js --login steps.json --login-route /login --dir ./dist
```

**A full machine contract lives in the repo's `AGENTS.md`.** Read it if you need the exact
payload schema, every finding type, or the closed-loop remediation procedure.


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
