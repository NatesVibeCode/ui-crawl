import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { auditPageSvg } from '../src/svg.js';

// Opt-in because this test uses the installed real Chromium renderer.
const LIVE = process.env.UI_CRAWL_LIVE === '1';

describe.skipIf(!LIVE)('SVG detector in Chromium', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('detects clipped geometry, transposed boxes, label collisions and scaled text without shape-label false alarms', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(`<!doctype html>
        <svg id="flow" viewBox="0 0 46 422" width="412" height="200">
          <rect x="0" y="10" width="300" height="40" fill="#f0eadc"/>
          <text x="10" y="35" font-size="11" fill="#080b08">revise</text>
          <rect x="320" y="10" width="120" height="40" fill="#f0eadc"/>
          <text x="330" y="35" font-size="11" fill="#080b08">submit</text>
        </svg>
        <svg id="negative" viewBox="0 0 100 100" width="100" height="100">
          <line x1="-20" y1="40" x2="60" y2="40" stroke="#111" stroke-width="2"/>
          <text x="20" y="80" font-size="11">axis</text>
        </svg>
        <svg id="collide" viewBox="0 0 100 100" width="100" height="100">
          <text x="10" y="40" font-size="14">revise</text>
          <text x="30" y="44" font-size="14">submit</text>
        </svg>
        <svg id="scaled" viewBox="0 0 100 30" width="780" height="234">
          <text x="5" y="20" font-size="11">blown up</text>
        </svg>
        <svg id="bars" viewBox="0 0 100 100" width="100" height="100">
          <rect x="10" y="40" width="40" height="0" fill="#2a4d3a"/>
        </svg>
        <svg id="heat" viewBox="0 0 100 60" width="100" height="60">
          <rect x="0" y="0" width="100" height="60" fill="#3a3a3a"/>
          <text x="10" y="35" font-size="14" fill="#5a5a5a">0.2</text>
        </svg>
        <svg id="visible" viewBox="0 0 100 100" width="100" height="100" style="overflow:visible">
          <rect x="-20" y="10" width="50" height="40" fill="#f0eadc"/>
          <text x="20" y="80" font-size="11">intentional bleed</text>
        </svg>`);

      const findings = await auditPageSvg(page, '/svg');
      const has = (kind: string, svgId: string) =>
        findings.some((f) => f.kind === kind && f.evidence.svg?.svgSelector === 'svg#' + svgId);

      expect(has('svg-viewbox-aspect-mismatch', 'flow')).toBe(true);
      expect(has('svg-geometry-outside-viewbox', 'negative')).toBe(true);
      expect(has('svg-text-overlap', 'collide')).toBe(true);
      expect(has('svg-text-scaled', 'scaled')).toBe(true);
      expect(has('svg-degenerate-geometry', 'bars')).toBe(true);
      expect(has('low-contrast', 'heat')).toBe(true);

      expect(has('svg-text-scaled', 'flow')).toBe(false);
      expect(has('svg-text-overlap', 'flow')).toBe(false);
      expect(has('svg-geometry-outside-viewbox', 'visible')).toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);
});
