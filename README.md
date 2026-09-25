# @aidev/ui-crawl

An agent-native Playwright UI auditing harness that drives a running web app or static directory, detects mechanical visual and layout defects, and outputs machine-consumable JSON payloads, indexed DOM snapshots, framework source-locations, and actionable CSS remediations.

It assumes **no human is in the loop**. All outputs are deterministic, structured JSON payloads, token-efficient indexed DOM snapshots, and actionable CSS/DOM remediation instructions.

---

## Capabilities

- **Zero-Dependency Native SQLite Engine**: Tracks crawl runs, defect trends, and run-over-run diffs (`--db`, `--diff`, `--history`).
- **Differential Auditing (`--diff`, `--rerun-defects`)**: Instantly categorizes findings into `fixed` (verifies agent repairs), `regressions` (detects accidental breakage), and `persistent`. Re-audit only previously failed routes with `--rerun-defects`.
- **Zero-Dependency Web Console & REST/SSE Server (`--ui [port]`)**: Launch an embedded real-time web dashboard and SSE progress stream for live monitoring and interactive inspection.
- **Fast Visual Sweep Mode (`--quick`)**: High-speed visual/contrast/layout audit skipping heavy control clicks.
- **Multi-Engine Browser Support (`--browser`)**: Run audits against Chromium, WebKit (Safari), or Firefox.
- **Interactive App UI Auditing**: Detects open dialogs/modals, verifies focus traps and viewport fit, tests dismissibility and restores state, unrolls tab panels/steppers, and safely auto-fills benign form inputs.
- **Container Escapes & Sibling Collisions**: Detects elements overflowing container bounds (`container-overflow`) and vertical in-flow collisions (`sibling-overlap`).
- **Framework Source-to-DOM Grounding**: Inspects React Fiber (`_debugSource`), Vue (`__vnode`), Svelte (`__svelte_meta`), and data attributes, telling agents the exact `.tsx`/`.vue` file, line number, and component name.
- **Pointer Physics & Hit-Testing**: Verifies `document.elementFromPoint` to catch ghost overlays, transparent interceptors (`pointer-intercepted`), and small touch targets (`small-touch-target`).
- **Dual-Theme Dark Mode Sweep (`--theme-sweep`)**: Emulates dark mode to catch inverted contrast collapses and dark theme breakage.
- **Multimodal Micro-Crops (`--crops`)**: Captures targeted $200\times200\text{px}$ base64 bounding-box PNG crops for visual/layout defects.
- **Native Screenshot Utility (`--shot`)**: Fast full-page or selector-targeted PNG captures.
- **DOM Layout Collision**: Detects in-flow sibling element overlaps, collision bounds, and container wrapping failures (`layout-overlap`).
- **Typography Clash**: Detects descender/ascender ink collisions where line-height ratio is cramped (< 1.15) (`text-line-collision`).
- **Clipped Text**: Identifies silent overflow truncation where `scrollWidth > clientWidth` (`clipped-text`).
- **Viewport Blowout**: Catches horizontal layout blowout causing unwanted page scrollbars (`viewport-overflow`).
- **WCAG Contrast**: High-precision luminance contrast checks with computed remediation recommendations (`low-contrast`).
- **Interaction Probing**: Safe synthetic clicks on interactive controls verifying DOM mutations, network requests, and navigations (`dead-button`), ignoring off-screen skip links.
- **LLM Semantic Snapshots**: High-density, token-efficient DOM snapshots with stable numbered indices for fast agent reasoning (`ui_snapshot`).
- **Model Context Protocol (MCP)**: Native stdio JSON-RPC 2.0 server exposing `ui_audit`, `ui_diff`, `ui_history`, and `ui_snapshot` tools to coding agents.

---

## Quickstart

### 1. Install & Build
```bash
npm install
npm run build
```

### 2. Run Audit via CLI
Stdout emits pure, parseable JSON (`AgentPayload`):
```bash
# Audit a live dev server
node bin/ui-crawl.js --base-url http://localhost:3000 --routes /

# Audit a static build output directory (auto-discovers all HTML routes)
node bin/ui-crawl.js --dir ./dist

# High-throughput parallel audit across 4 concurrent workers (default: 4)
node bin/ui-crawl.js --dir ./dist --concurrency 4
# or short flag:
node bin/ui-crawl.js --dir ./dist -c 8

# Fast visual sweep with WebKit (Safari) and only output mechanical defects
node bin/ui-crawl.js --dir ./dist --quick --browser webkit --defects-only

# Re-audit only the routes that failed on the last crawl
node bin/ui-crawl.js --dir ./dist --rerun-defects

# Audit with dark-mode theme sweep and differential tracking against previous run
node bin/ui-crawl.js --dir ./dist --theme-sweep --diff
```

### 3. Launch Local Web Console & REST/SSE Dashboard
```bash
# Start embedded UI dashboard on http://127.0.0.1:49152
node bin/ui-crawl.js --ui

# Custom port
node bin/ui-crawl.js --ui 8080
```

### 4. Capture Screenshots or Page Snapshots
```bash
# Fast full-page screenshot
node bin/ui-crawl.js --shot preview.png --dir ./dist

# Screenshot specific element selector
node bin/ui-crawl.js --shot modal.png --dir ./dist --selector "dialog#modal"

# Compact numbered DOM snapshot for LLMs
node bin/ui-crawl.js --snapshot --file ./index.html

# Raw JSON snapshot array
node bin/ui-crawl.js --snapshot --file ./index.html --json
```

### 5. Query Differential & Run History
```bash
# Show differential against the latest baseline run
node bin/ui-crawl.js --diff

# Query run history
node bin/ui-crawl.js --history --limit 5
```

### 5. Run as MCP Server
```bash
node bin/ui-crawl.js --mcp
```

Add to your agent or IDE config (e.g. `claude_desktop_config.json` or `.gemini`):
```json
{
  "mcpServers": {
    "ui-crawl": {
      "command": "node",
      "args": ["/Users/nate/Public Repos/ui-crawl/bin/ui-crawl.js", "--mcp"]
    }
  }
}
```

---

## Output Schema (`AgentPayload`)

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

### Exit Codes:
- `0`: Clean run or taste questions only.
- `1`: Mechanical defects detected (`has_defects`).
- `2`: Configuration or runtime argument error.

---

## Agent Integration Guide

See [`AGENTS.md`](./AGENTS.md) for full machine contracts, MCP schemas, closed-loop remediation workflows, and agent execution policies.

---

## Development & Testing

```bash
npm run build      # Compile TypeScript to dist/
npm test           # Hermetic test suite (< 1s)
npm run test:live  # Live browser test suite (requires Chromium)
npm run typecheck  # TypeScript strict type checking
```
