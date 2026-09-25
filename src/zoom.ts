import type { Page } from 'playwright';
import type { Box, RawFinding } from './types.js';
import type { ResolvedConfig } from './config.js';
import { detectReflow } from './reflow.js';

/** Structural elements whose collision/overflow at zoom is a real layout break. */
const STRUCTURAL =
  'header, nav, [role="banner"], [role="navigation"], [role="toolbar"], .toolbar, [data-toolbar], main > *';

export interface ZoomResult {
  raw: RawFinding[];
  shots: { zoom: number; screenshot: string }[];
}

/**
 * Reflow each zoom level on the live document and run the deterministic heuristic.
 * Boxes and the viewport are both measured in-page (same coordinate system) so the
 * comparison stays valid under CSS zoom.
 *
 * `shoot(label)` writes a screenshot and returns its path relative to outDir; zoom 1
 * reuses `baseShot`, the route's already-captured render at that same viewport.
 */
export async function zoomPass(
  page: Page,
  route: string,
  cfg: ResolvedConfig,
  shoot: (label: string) => Promise<string>,
  baseShot: string,
): Promise<ZoomResult> {
  const raw: RawFinding[] = [];
  const shots: { zoom: number; screenshot: string }[] = [];

  // The crawl may be running this pass for any configured viewport. Read the page's
  // actual size instead of always falling back to the first (usually desktop) viewport.
  const current = page.viewportSize();
  const base = current ?? cfg.viewports[0];
  for (const zoom of cfg.zoomLevels) {
    // Emulate browser zoom by narrowing the layout viewport, so the page reflows
    // responsively the way it does under real zoom — CSS `zoom` only scales the render
    // and manufactures horizontal overflow that a user never actually sees.
    const w = Math.max(320, Math.round(base.width / zoom));
    const h = Math.max(400, Math.round(base.height / zoom));

    // Zoom 1 is the render the route's base screenshot already captured — same viewport,
    // already loaded. Reuse it instead of navigating and re-shooting identical pixels.
    if (w === base.width && h === base.height) {
      shots.push({ zoom, screenshot: baseShot });
      continue;
    }

    // Real browser zoom reflows the live document; it does not reload it. Resizing the
    // layout viewport reproduces that, so this needs no second navigation — which also
    // stops the pass from re-running page scripts once per zoom level.
    await page.setViewportSize({ width: w, height: h }).catch(() => {});
    await page.waitForTimeout(250);

    const screenshot = await shoot(`@${Math.round(zoom * 100)}`);
    shots.push({ zoom, screenshot });

    const measured = await page
      .evaluate((sel) => {
        const vp = { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
        const els = Array.from(document.querySelectorAll(sel)).slice(0, 40);
        const boxes = els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
          };
        });
        return { vp, boxes };
      }, STRUCTURAL)
      .catch(() => ({ vp: { w: 0, h: 0 }, boxes: [] as Box[] }));

    if (zoom === 1 || measured.vp.w === 0) continue; // baseline render is not a reflow defect

    const issues = detectReflow({ viewport: measured.vp, boxes: measured.boxes, zoom });
    for (const issue of issues) {
      raw.push({
        route,
        kind: issue.kind,
        ambiguous: issue.ambiguous,
        evidence: {
          zoom,
          screenshot,
          selector: issue.otherSelector ? `${issue.selector} ∩ ${issue.otherSelector}` : issue.selector,
          boxes: measured.boxes,
        },
      });
    }
  }

  await page.setViewportSize({ width: base.width, height: base.height }).catch(() => {});
  return { raw, shots };
}
