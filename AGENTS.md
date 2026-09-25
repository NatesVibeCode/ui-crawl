# AGENTS.md — ui-crawl Agent Manual

`ui-crawl` is an agent-native UI auditing and layout inspection harness designed for LLMs and autonomous coding agents.

It assumes **no human is in the loop**. There are no visual galleries, no HTML reports, and no video screen recordings. All outputs are deterministic, structured JSON payloads, token-efficient indexed DOM snapshots, exact CSS/DOM remediation instructions, framework component source-locations, and run-over-run differential tracking.

---

## 1. Golden Rules & Constraints

1. **Stdout is Pure Data**: stdout is strictly reserved for machine consumption (JSON payloads or formatted snapshot lines). Never log debug greetings, progress bars, or conversational messages to stdout. Informational logs go to stderr.
2. **Zero Dependencies in `src/`**: `src/**` imports ONLY Node built-ins (`node:*`), local relative modules, and `playwright`. Never add third-party npm packages to `src/` (enforced by `test/importIndependence.test.ts`). Native SQLite uses Node 22+'s built-in `node:sqlite`.
3. **No Standalone Chrome Invocations**: Never launch Chrome/Chromium directly via the bash tool (it wedges headless environments). All browser automation runs through Playwright.
4. **Vanilla Node Execution**: Consuming agents can run `node bin/ui-crawl.js` directly with standard Node.js without needing `tsx`, `ts-node`, or global TypeScript installed.
5. **Defect vs Taste Invariance**:
   - `defect`: Mechanical brokenness (exit code `1`). Agents must prioritize fixing these.
   - `taste`: Style or ergonomic suggestions (exit code `0`). Informational; should not fail builds.

---

## 2. Integration Modes

### A. Model Context Protocol (MCP) Server
`ui-crawl` implements a zero-dependency JSON-RPC 2.0 / MCP stdio server.

Launch via stdio:
```bash
node bin/ui-crawl.js --mcp
```

#### MCP Tools Provided:
- `ui_audit`: Deterministic visual, layout, and interaction audit.
  - Parameters:
    - `baseUrl` (string, optional): Running server URL (e.g. `http://localhost:3000`).
    - `dir` (string, optional): Local directory to serve statically and audit.
    - `file` (string, optional): Local HTML file to serve statically and audit.
    - `routes` (string[], optional): Route list to audit (e.g. `["/"]`).
    - `maxPages` (number, optional): Crawl page cap (default: 20).
    - `maxProbesPerPage` (number, optional): Button sweep limit per page (default: 25).
    - `themeSweep` (boolean, optional): Audit both light and dark modes.
    - `captureCrops` (boolean, optional): Capture base64 micro-crops for visual defects.
    - `dbPath` (string, optional): SQLite DB path (default: `.ui-crawl.db`).
    - `diff` (boolean, optional): Compute differential against previous run.
    - `full` (boolean, optional): Return raw `findings.json` instead of concise `AgentPayload`.
- `ui_diff`: Compare two runs from SQLite to identify resolved issues, persistent issues, and regressions.
  - Parameters: `dbPath` (optional), `runA` (baseline run ID), `runB` (current run ID).
- `ui_history`: Query past runs and defect counts from the SQLite database.
  - Parameters: `dbPath` (optional), `limit` (optional).
- `ui_snapshot`: Extract a high-density, low-token snapshot of interactive controls on a page.
  - Parameters: `url` / `dir` / `file`, `cap` (default: 80), `format` ("text" | "json").

---

### B. Command-Line Interface (CLI)

#### 1. Audit a Running Dev Server or Static Directory
```bash
# Audit a live app
node bin/ui-crawl.js --base-url http://localhost:3000 --routes /

# Audit a static build output directory (auto-discovers all HTML routes)
node bin/ui-crawl.js --dir ./dist

# High-throughput parallel audit across 4 workers (default: 4)
node bin/ui-crawl.js --dir ./dist --concurrency 4
# or short flag:
node bin/ui-crawl.js --dir ./dist -c 8

# Fast visual sweep with WebKit and mechanical defects only
node bin/ui-crawl.js --dir ./dist --quick --browser webkit --defects-only

# Re-audit only the routes that had defects on the last crawl
node bin/ui-crawl.js --dir ./dist --rerun-defects

# Audit with dark-mode theme sweep and differential tracking against previous run
node bin/ui-crawl.js --dir ./dist --theme-sweep --diff
```

#### 2. Embedded Web Dashboard & Server Mode
```bash
# Start embedded zero-dependency web dashboard on http://127.0.0.1:49152
node bin/ui-crawl.js --ui

# With custom port
node bin/ui-crawl.js --ui 8080
```

#### 3. Screenshots & Snapshots
```bash
# Capture full page or element screenshot
node bin/ui-crawl.js --shot preview.png --dir ./dist
node bin/ui-crawl.js --shot modal.png --dir ./dist --selector "dialog#lead-modal"

# Compact numbered DOM snapshot for LLMs
node bin/ui-crawl.js --snapshot --file ./index.html

# Raw JSON snapshot array
node bin/ui-crawl.js --snapshot --file ./index.html --json
```

#### 4. Query Differential & History
```bash
# Show differential against the latest baseline run
node bin/ui-crawl.js --diff

# Query run history
node bin/ui-crawl.js --history --limit 5
```

#### CLI Output Schema (`AgentPayload` JSON):
```json
{
  "runId": "run_1790285831742_a146e4",
  "verdict": "has_defects",
  "summary": {
    "defects": 1,
    "taste": 0,
    "pagesCrawled": 1,
    "byType": {
      "layout-overlap": 1
    }
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
      "source": {
        "file": "src/components/CardHeader.tsx",
        "line": 42,
        "component": "CardHeader"
      },
      "cropBase64": "data:image/png;base64,iVBORw0KGgo...",
      "evidence": {
        "layout": {
          "otherSelector": ".research-badge",
          "overlapFrac": 0.35
        }
      }
    }
  ],
  "routes": ["/"],
  "diff": {
    "runA": "run_1790285828330_654b6a",
    "runB": "run_1790285831742_a146e4",
    "fixed": [
      { "fingerprint": "/::low-contrast::p#faint", "title": "Low text contrast..." }
    ],
    "regressions": [],
    "persistent": [
      { "fingerprint": "/::layout-overlap::.card-index", "title": "In-flow elements collide" }
    ]
  }
}
```

Exit Codes:
- `0`: No defects detected (`clean` or `has_taste_questions`).
- `1`: One or more mechanical defects detected (`has_defects`).
- `2`: Misconfiguration / missing arguments.

---

## 3. Findings Taxonomy & Remediation

| Finding Type | Bucket | Root Cause | Remediation Strategy |
|---|---|---|---|
| `container-overflow` | `defect` | Child elements escape container bottom boundary (> 4px) | Adjust container `height: auto`, `min-height`, or check child margins. |
| `sibling-overlap` | `defect` | Vertical in-flow block siblings collide (> 4px) | Increase vertical margin or remove negative positioning. |
| `layout-overlap` | `defect` | In-flow sibling elements collide in screen coordinates | Check container `flex-wrap: wrap`, grid columns, or margins. |
| `text-line-collision` | `defect` | Line-height is too cramped for font ascender/descender ink | Increase `line-height` (minimum `1.2` to `1.4`). |
| `clipped-text` | `defect` | Text truncated without ellipsis or hidden overflow | Adjust `min-width`, remove fixed height, or add `text-overflow: ellipsis`. |
| `viewport-overflow` | `defect` | Child elements blow out horizontal viewport causing side scroll | Add `max-width: 100%`, fix rigid absolute widths, or wrap flex containers. |
| `pointer-intercepted`| `defect` | Control click occluded by floating overlay or modal backdrop | Add `pointer-events: none` to overlay or fix `z-index`. |
| `dark-mode-contrast` | `defect` | Text fails WCAG AA contrast under dark mode theme | Follow suggested color in `remediation` field for dark mode. |
| `low-contrast` | `defect` | Contrast ratio < 4.5:1 (normal text) or < 3.0:1 (large text) | Follow suggested color in `remediation` field. |
| `dead-button` | `defect` | Button click triggered 0 DOM mutations, network requests, or navigations | Attach missing event listener, fix broken state, or disable button if pending. |
| `console-error` | `defect` | Uncaught JavaScript exception in browser | Fix source error indicated in evidence stack. |
| `failed-request` | `defect` | Network asset or API returned 4xx/5xx | Fix route endpoint or asset path. |
| `small-touch-target` | `taste` | Clickable control smaller than WCAG 24x24px minimum | Increase element padding or min-width/min-height. |
| `missing-affordance` | `taste` | Clickable element missing `cursor: pointer` or hover styles | Add `:hover` style transition and `cursor: pointer`. |
| `redundant-navigation` | `taste` | Multiple adjacent links targeting identical URL | Consolidate duplicate navigation controls. |

---

## 4. Closed-Loop Agent Remediation Workflow

When an autonomous agent is assigned to fix UI bugs:

```
[Agent] Run `node bin/ui-crawl.js --dir ./build --diff`
   │
   ├─► Exit Code 0 (verdict: "clean") ──► Task Complete
   │
   └─► Exit Code 1 (verdict: "has_defects")
         │
         ├─► Parse JSON `actions[]` from stdout
         │
         ├─► For each action:
         │     1. Open file at `action.source.file` at line `action.source.line`
         │     2. Inspect `action.cropBase64` (if multimodal model)
         │     3. Apply suggested `action.remediation`
         │
         └─► Re-run `node bin/ui-crawl.js --dir ./build --diff`
               ├─► Check `diff.fixed`: verifies bug resolved
               ├─► Check `diff.regressions`: verifies no accidental breakage
               └─► Loop until defect count reaches 0
```

---

## 5. Verification Commands

Run inside the `ui-crawl` checkout:
```bash
npm run build      # Compile src/ to dist/
npm test           # Hermetic test suite (158 tests, < 1s)
npm run test:live  # Live browser interaction tests
npm run typecheck  # Full TypeScript typecheck
```
