import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { Page } from 'playwright';
import { resolveConfig, type CrawlConfig } from './config.js';
import type { CrawlResult, PageReport, RawFinding, ColorPalette } from './types.js';
import { toRouteTemplate } from './routeTemplate.js';
import { openSession, closeSession, newPage } from './browser.js';
import { gotoRoute, attachCollectors, dedupeRequests } from './capture.js';
import { enumerateControls, sweepControls } from './interactions.js';
import { zoomPass } from './zoom.js';
import { discoverRoutes, planSeedList } from './discover.js';
import { auditPageColors, contrastRatio, relativeLuminance, parseColor } from './colors.js';
import { auditPageSpacing, edgeDistance } from './spacing.js';
import { auditPageAffordance } from './affordance.js';
import { triageRaw } from './triage.js';
import { PolitenessGate } from './policy.js';
import { buildGalleryHtml, buildFindingsJson } from './report.js';
import { FilesystemSink } from './sink.js';

export type { CrawlConfig, ResolvedConfig, Viewport } from './config.js';
export type {
  Finding,
  RawFinding,
  PageReport,
  CrawlResult,
  Control,
  Signals,
  Box,
  Bucket,
  Severity,
  FindingType,
  ColorPalette,
} from './types.js';
export { type VisionPort, type TextTriagePort, NoopVisionPort, NoopTextTriagePort } from './ports.js';
export { type ReportSink, type ReportArtifact, FilesystemSink } from './sink.js';
export { classifyChange } from './changeDetect.js';
export { detectReflow } from './reflow.js';
export { findRedundant } from './redundancy.js';
export { auditPageColors, contrastRatio, relativeLuminance, parseColor } from './colors.js';
export { auditPageSpacing, edgeDistance } from './spacing.js';
export { auditPageAffordance } from './affordance.js';
export { triageRaw } from './triage.js';
export { toRouteTemplate } from './routeTemplate.js';
export { planVisits, planSeedList } from './discover.js';
export { buildGalleryHtml, buildFindingsJson } from './report.js';

function slug(route: string): string {
  const s = route.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'index';
}

async function shoot(page: Page, outDir: string, relName: string): Promise<string> {
  const rel = path.join('screenshots', `${relName}.png`);
  const abs = path.join(outDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await page.screenshot({ path: abs, fullPage: true }).catch(() => {});
  return rel;
}

export async function crawl(config: CrawlConfig): Promise<CrawlResult> {
  const cfg = resolveConfig(config);
  const startedAt = new Date().toISOString();

  const viewport = { width: cfg.viewports[0].width, height: cfg.viewports[0].height };
  const session = await openSession(cfg, viewport);
  const gate = new PolitenessGate(session.context.request, cfg.perHostDelayMs, cfg.respectRobots);

  const pages: PageReport[] = [];
  const rawFindings: RawFinding[] = [];

  try {
    // Discovery gets a page of its own; it is closed before the crawl proper starts.
    let routes: string[];
    if (cfg.routes === 'discover') {
      const scout = await newPage(session);
      routes = await discoverRoutes(scout, cfg);
      await scout.close().catch(() => {});
    } else {
      routes = planSeedList(cfg.routes, cfg.maxPages);
    }

    for (const route of routes) {
      // One page per route, closed at the end of it. This is what bounds memory: a page
      // reused for a whole crawl accumulates everything the click sweep does to it, and
      // peak RSS grew to 857MB over 25 routes. With a page per route it stays ~371MB.
      const page = await newPage(session);
      const url = cfg.baseUrl + route;

      if (!(await gate.allowed(url))) {
        // Not crawled, and not a defect: the site asked us not to look. Recording it
        // beats skipping silently, which would read as a clean page in the report.
        rawFindings.push({ route, kind: 'robots-blocked', evidence: { url } });
        pages.push({
          route,
          template: toRouteTemplate(route),
          status: null,
          consoleErrors: [],
          failedRequests: [],
          controlCount: 0,
        });
        await page.close().catch(() => {});
        continue;
      }

      const collectors = attachCollectors(page);
      const load = await gotoRoute(page, url, cfg.navTimeoutMs, {
        attempts: cfg.navRetries,
        beforeAttempt: () => gate.pace(url),
        onRetry: () => collectors.reset(),
      });
      const baseShot = await shoot(page, cfg.outDir, slug(route));
      const controls = await enumerateControls(page).catch(() => []);
      collectors.dispose();

      if (load.status && load.status >= 400) {
        rawFindings.push({ route, kind: 'page-load-error', evidence: { url, screenshot: baseShot } });
      }
      if (load.loadError) {
        rawFindings.push({ route, kind: 'page-load-error', evidence: { url, screenshot: baseShot, consoleText: [load.loadError] } });
      }
      for (const ce of collectors.consoleErrors) {
        rawFindings.push({ route, kind: 'console-error', evidence: { url, screenshot: baseShot, consoleText: [ce] } });
      }
      const dedupedFailed = dedupeRequests(collectors.failedRequests);
      for (const fr of dedupedFailed) {
        if (fr.url === url) continue; // Root document load failure is already captured as page-load-error
        rawFindings.push({
          route,
          kind: 'broken-asset',
          evidence: {
            url: fr.url,
            consoleText: [fr.status ? `HTTP ${fr.status}` : (fr.failure ?? 'Failed')],
          },
        });
      }

      let palette: ColorPalette | undefined;
      let textDigest: number | undefined;
      let textLength: number | undefined;
      if (!cfg.skipContrast) {
        const colorAudit = await auditPageColors(page, route).catch(() => ({ rawFindings: [], palette: undefined, textDigest: undefined, textLength: undefined }));
        rawFindings.push(...colorAudit.rawFindings);
        palette = colorAudit.palette;
        textDigest = colorAudit.textDigest;
        textLength = colorAudit.textLength;
      }

      if (!cfg.skipSpacing) {
        const spacingFindings = await auditPageSpacing(page, route).catch(() => []);
        rawFindings.push(...spacingFindings);
      }

      if (!cfg.skipAffordance) {
        const affordanceFindings = await auditPageAffordance(page, route, controls).catch(() => []);
        rawFindings.push(...affordanceFindings);
      }

      let zoomShots: { zoom: number; screenshot: string }[] = [];
      if (!cfg.skipZoom) {
        const z = await zoomPass(page, route, cfg, (label) => shoot(page, cfg.outDir, `${slug(route)}${label}`), baseShot);
        rawFindings.push(...z.raw);
        zoomShots = z.shots;
      }

      let probedControls: number | undefined;
      let skippedControls: number | undefined;
      if (!cfg.skipInteractionSweep) {
        const sweep = await sweepControls(page, route, url, controls, cfg, () => gate.pace(url));
        rawFindings.push(...sweep.findings);
        probedControls = sweep.probed;
        skippedControls = sweep.skipped;
      }

      pages.push({
        route,
        template: toRouteTemplate(route),
        status: load.status,
        loadError: load.loadError,
        screenshot: baseShot,
        zoomShots,
        consoleErrors: collectors.consoleErrors,
        failedRequests: dedupedFailed,
        controlCount: controls.length,
        probedControls,
        skippedControls,
        textDigest,
        textLength,
        palette,
      });
      await page.close().catch(() => {});
    }
  } finally {
    await closeSession(session);
  }

  const findings = rawFindings.map((r) => triageRaw(r, { vision: cfg.vision, text: cfg.text }));
  const finishedAt = new Date().toISOString();
  const result: CrawlResult = { baseUrl: cfg.baseUrl, startedAt, finishedAt, pages, findings };

  const sink = config.sink ?? new FilesystemSink();
  result.reportPath = await sink.write({
    outDir: cfg.outDir,
    artifacts: [
      { name: 'gallery.html', content: buildGalleryHtml(result) },
      { name: 'findings.json', content: buildFindingsJson(result) },
    ],
  });

  return result;
}
