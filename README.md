# @aidev/ui-crawl

A standalone Playwright harness that drives a running dev server and sorts what it finds
into two buckets:

- **defect** — objectively broken: a control that threw, a link that goes nowhere, a page
  that 500'd, a layout that clips/overlaps at zoom. Positive evidence of brokenness.
- **taste** — a human decision: a button that did nothing (dead, or needs prior input?),
  two controls to the same place, a borderline layout. **Silence is always taste, never a defect.**

It imports zero application code. Its only contract is a base URL. Point it at any running
app. The deterministic core (v1) uses **no models** — every finding is trustworthy.

## Use

```bash
# one-time
npm install
npx playwright install chromium

# crawl a running dev server
npm run crawl -- --base-url http://localhost:3000 --routes /,/campaigns,/guests
# or with a config file
npm run crawl -- --config ./my-app.crawl.json

# record a live page into an inspiration bundle
npm run capture -- \
  --url https://example.com \
  --slug example \
  --out ./articles/2026-07-10-ui-inspiration-capture \
  --manifest ./articles/2026-07-10-ui-inspiration-capture/manifest.json
```

Outputs `gallery.html` (a self-contained review queue, defects red / taste amber) and
`findings.json` into `--out` (default `./ui-crawl-out`).

`gallery.html` is for crawl defects/taste findings. It is **not** the UI Fieldwork
reader. Inspiration capture review lives in the cumulative digital booklet built by
the `daily-ui-inspiration-capture` skill:

```bash
node ~/.codex/skills/daily-ui-inspiration-capture/scripts/build-ui-fieldwork-booklet.mjs
# → articles/ui-fieldwork-booklet/index.html
```

The motion capture command records a scripted four-beat scroll using Playwright's
open-source browser video support, converts the result to MP4 with `ffmpeg`, extracts
four PNG motion frames, and updates the matching manifest item when `--manifest` is
provided. Use `--headed` when you need to watch the capture.

### Config

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "routes": ["/", "/campaigns", "/guests"], // or "discover" to follow links from /
  "outDir": "./.ui-crawl-out",
  "zoomLevels": [1, 1.5, 2],
  "skipInteractionSweep": false,
  "skipZoom": false
}
```

CLI flags override the file: `--base-url`, `--out`, `--routes a,b,c`, `--max-pages N`,
`--no-zoom`, `--no-clicks`, `--headed`.

## Safety

It clicks real controls, so against a live dev DB it: dismisses confirm dialogs, refuses
downloads, blocks cross-origin top-level navigation, and aborts mutating requests (POST/PUT/
PATCH/DELETE) from controls whose label looks destructive (delete/remove/sign out/pay).

## Tests

```bash
npm test            # pure, hermetic — no browser
npm run test:live   # spins a fixture site + real chromium (UI_CRAWL_LIVE=1)
```

## Injected models (v2, optional)

`crawl()` accepts `vision: VisionPort` and `text: TextTriagePort`. Both default to Noop, so
the bucketing is identical with nothing wired. v2 binds a VLM (ambiguous-zoom judgment) and a
cheap text model (no-op-button triage, i18n copy review) — and a model can only refine a
finding, never silently invent a defect.
