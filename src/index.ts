import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Page, Browser } from 'playwright';
import { resolveConfig, type CrawlConfig } from './config.js';
import type { CrawlResult, DetectorFailure, PageReport, RawFinding, ColorPalette, Box } from './types.js';
import { toRouteTemplate } from './routeTemplate.js';
import { openSession, closeSession, newPage, buildContext } from './browser.js';
import { gotoRoute, attachCollectors, dedupeRequests } from './capture.js';
import { enumerateControls, sweepControls } from './interactions.js';
import { auditPageAccessibility } from './accessibility.js';
import { auditPageStates } from './state.js';
import { zoomPass } from './zoom.js';
import { discoverRoutes, planSeedList } from './discover.js';
import { fetchGuidance, guidanceArtifacts, type GuidancePack } from './guidance.js';
import { isChallengePage, challengeSeverity, isChallengeSubresource } from './challenge.js';
import { auditPageColors, contrastRatio, relativeLuminance, parseColor, type ColorAuditResult } from './colors.js';
import { setDetectorErrorHandler, reportDetectorFailure } from './detectorErrors.js';

const EMPTY_COLOR_AUDIT: ColorAuditResult = {
  rawFindings: [],
  palette: undefined,
  textDigest: undefined,
  textLength: undefined,
};
import { auditPageSpacing, edgeDistance } from './spacing.js';
import { auditPageAffordance } from './affordance.js';
import { auditPageLayout, boxIntersection } from './layout.js';
import { auditPageHitTest } from './hitTest.js';
import { resolveSourceForSelector } from './source.js';
import { markControls } from './snapshot.js';
import { resolveEvidence, scrollTargetIntoView, primeDeepPools, type EvidenceTarget } from './locate.js';
import { openDatabase, saveRun, getDiff, hasRun } from './db.js';
import {
  auditTabPanels,
  autoFillFormInputs,
  detectOpenModal,
  auditOpenModal,
  dismissOpenModal,
  type AppStateAuditResult,
} from './appState.js';
import { triageRaw } from './triage.js';
import { PolitenessGate } from './policy.js';
import { buildFindingsJson, buildAgentPayload, capFindings } from './report.js';
import { FilesystemSink } from './sink.js';
import type { ReportArtifact } from './sink.js';
import type { ApiCall, GuidanceSummary } from './types.js';

export type { CrawlConfig, ResolvedConfig, Viewport, StorageStateData } from './config.js';
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
export { buildSnapshot, formatSnapshot, relocateControl, markControls } from './snapshot.js';
export { auditPageAccessibility } from './accessibility.js';
export { auditPageStates } from './state.js';
export { SELECTOR, SNAPSHOT_SELECTOR } from './selectors.js';
export { isChallengePage, challengeSeverity, isChallengeSubresource } from './challenge.js';
export {
  fetchGuidance,
  guidanceArtifacts,
  seedsFromGuidance,
  parseSitemapLocs,
  parseLlmsLinks,
  parseLlmsHeadings,
} from './guidance.js';
export { crawlUserAgent, UI_CRAWL_UA_PREFIX } from './config.js';
export { isApiRequest, apiUrlKey } from './capture.js';
export type { ApiCall, GuidanceSummary } from './types.js';
export type { GuidancePack } from './guidance.js';
export { type ReportSink, type ReportArtifact, FilesystemSink } from './sink.js';
export { classifyChange } from './changeDetect.js';
export { detectReflow } from './reflow.js';
export { findRedundant } from './redundancy.js';
export { auditPageColors, contrastRatio, relativeLuminance, parseColor, suggestAccessibleColor, verifyContrastFixes, type ColorSuggestion, type ContrastVerification } from './colors.js';
export { auditPageSpacing, edgeDistance } from './spacing.js';
export { auditPageAffordance } from './affordance.js';
export { auditPageLayout, boxIntersection } from './layout.js';
export { triageRaw } from './triage.js';
export { toRouteTemplate } from './routeTemplate.js';
export { planVisits, planSeedList } from './discover.js';
export { buildFindingsJson, buildAgentPayload, summarize, capFindings, buildGroups, type AgentPayload, type AgentAction, type AgentGroup } from './report.js';
export { startMcpServer, handleMcpMessage, MCP_TOOLS, type JsonRpcRequest, type JsonRpcResponse } from './mcp.js';
export { serveStatic, discoverHtmlRoutes, type StaticServer } from './serve.js';
export { snapshotUrl, type SnapshotOptions } from './snapshot.js';
export { auditPageHitTest, isTouchTargetSmall, isHitOccluded } from './hitTest.js';
export { extractElementSource, resolveSourceForSelector } from './source.js';
export { openDatabase, saveRun, getDiff, getRunHistory, getFindingById, type RunRecord } from './db.js';
export {
  auditTabPanels,
  autoFillFormInputs,
  detectOpenModal,
  auditOpenModal,
  dismissOpenModal,
  type AppStateAuditResult,
} from './appState.js';
export {
  UiSession,
  SessionRegistry,
  describeAction,
  type AnySession,
  type SessionAction,
  type SnapshotMode,
  type SessionOptions,
  type SessionTarget,
  type ActionState,
} from './session.js';
export {
  TuiSession,
  keyToAnsi,
  describeTuiAction,
  type TuiSessionOptions,
  type TuiAction,
} from './tuiSession.js';
export {
  TuiBuffer,
  type TuiCell,
  type TuiControl,
  type TuiContrastFinding,
} from './tuiBuffer.js';
export {
  TuiProcess,
  type TuiProcessOptions,
} from './tuiProcess.js';
export {
  auditTui,
  type TuiAuditOptions,
} from './tuiAudit.js';
export { resolveEvidence, selectorCandidates, type EvidenceTarget } from './locate.js';
export { getDefectRoutes, hasRun } from './db.js';


function slug(route: string): string {
  const s = route.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'index';
}

async function shoot(page: Page, outDir: string, relName: string, fullPage = false): Promise<string> {
  const rel = path.join('screenshots', `${relName}.png`);
  const abs = path.join(outDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await page.screenshot({ path: abs, fullPage }).catch(() => {});
  return rel;
}

/**
 * Whether the document is taller than the viewport — i.e. whether a full-page screenshot
 * shows anything the viewport shot does not. Short pages skip the duplicate file.
 */
async function hasBelowFold(page: Page): Promise<boolean> {
  return page
    .evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1)
    .catch(() => false);
}

/** Padding in CSS px around a finding's box when cropping evidence. */
const CROP_PAD = 20;

export interface CropResult {
  /** PNG path relative to `outDir`, so a harness with filesystem access can read it. */
  crop?: string;
  /** The same PNG inline, so a harness without filesystem access still sees pixels. */
  cropBase64?: string;
}

/** Read the page's scroll position, so a crop pass can leave the page as it found it. */
async function readScroll(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => null);
}

/**
 * Photograph one finding: a padded region around its element, written to `crops/` and
 * returned both as a path and inline.
 *
 * The photograph is always taken from a FRESH measurement. Detector boxes come from
 * `getBoundingClientRect()`, which is viewport-relative at measure time, while
 * `page.screenshot({ clip })` only accepts coordinates inside the CURRENT viewport image.
 * Any scroll in between — the sweep navigates, the reload-for-crops resets to zero —
 * silently turns a carried box into coordinates outside the image, and Playwright answers
 * with "Clipped area is either empty or outside". So: scroll the element into view, then
 * read where it is, then shoot. Findings below the fold get real pictures this way;
 * without it they got none, ever.
 *
 * When no element resolves (hit-test bounds, multi-box groups), the carried box is
 * centered with pure scroll math, which is correct by construction. When nothing is
 * photographable from here, the finding honestly carries no image rather than a wrong one.
 */
async function cropOne(
  page: Page,
  outDir: string,
  relBase: string,
  selector: string | undefined,
  fallbackBox: Box | undefined,
): Promise<CropResult> {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };

  let rect: { x: number; y: number; w: number; h: number } | null = null;
  if (selector) {
    const fresh = await scrollTargetIntoView(page, selector).catch(() => null);
    if (fresh) rect = fresh;
  }
  if (!rect && fallbackBox && fallbackBox.w > 0 && fallbackBox.h > 0) {
    const sc = await readScroll(page);
    if (!sc) return {};
    const docX = fallbackBox.x + sc.x;
    const docY = fallbackBox.y + sc.y;
    await page
      .evaluate(
        ({ x, y }) => window.scrollTo(Math.max(0, x - window.innerWidth / 2), Math.max(0, y - window.innerHeight / 2)),
        { x: docX + fallbackBox.w / 2, y: docY + fallbackBox.h / 2 },
      )
      .catch(() => {});
    const sc2 = await readScroll(page);
    if (!sc2) return {};
    rect = { x: docX - sc2.x, y: docY - sc2.y, w: fallbackBox.w, h: fallbackBox.h };
  }
  if (!rect || rect.w <= 0 || rect.h <= 0) return {};

  // Clamp to the viewport image. A sticky header or a short page can still leave part of
  // the region outside what the renderer captured; photograph what is there.
  const x = Math.max(0, Math.min(rect.x - CROP_PAD, vp.width - 1));
  const y = Math.max(0, Math.min(rect.y - CROP_PAD, vp.height - 1));
  const width = Math.max(0, Math.min(rect.x + rect.w + CROP_PAD, vp.width) - x);
  const height = Math.max(0, Math.min(rect.y + rect.h + CROP_PAD, vp.height) - y);
  if (width < 8 || height < 8) return {};

  const buffer = await page.screenshot({ clip: { x, y, width, height } }).catch(() => null);
  if (!buffer) return {};

  const result: CropResult = { cropBase64: `data:image/png;base64,${buffer.toString('base64')}` };
  const rel = path.join('crops', `${relBase}.png`);
  const abs = path.join(outDir, rel);
  try {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, buffer);
    result.crop = rel;
  } catch {
    /* the inline bytes already succeeded; a file is a bonus, never a failure */
  }
  return result;
}

/** The viewport stamp every finding carries, so a finding is only ever claimed about one render. */
type ViewportEvidence = {
  width: number;
  height: number;
  label?: string;
  /**
   * Device pixels per CSS pixel at capture time. Boxes are CSS px; screenshot pixels are
   * CSS px × this. A harness overlaying boxes on screenshots without it is doing
   * uncalibrated math.
   */
  deviceScaleFactor?: number;
};

/**
 * Attach the two things an agent needs to actually act on a finding: a `file:line` to
 * edit, and a picture of the defect.
 *
 * One page round-trip per finding resolves the element the finding names and yields both
 * its box and its framework source. Neither used to work for most finding types — the crop
 * required a layout/hit-test box and the source required plain CSS, and no interaction or
 * contrast detector emits either. Findings that cannot be resolved carry neither, which is
 * the honest outcome; a wrong box or a guessed file would be worse than nothing.
 */
async function enrichEvidence(
  page: Page,
  outDir: string,
  findings: RawFinding[],
  viewport: ViewportEvidence,
  captureCrops: boolean,
): Promise<void> {
  // Cropping scrolls the page to each finding in turn; leave the scroll where it was so
  // later phases (and any future reader of this function) never depend on crop order.
  const scrollBefore = await readScroll(page);
  // Stage pierced element pools once so findings inside shadow roots can be resolved.
  await primeDeepPools(page);
  try {
    for (let i = 0; i < findings.length; i++) {
      const finding = findings[i];
      finding.evidence.viewport = viewport;

      const target: EvidenceTarget = finding.evidence.selector
        ? await resolveEvidence(page, finding.evidence.selector).catch(() => ({}))
        : {};
      if (target.source && !finding.evidence.source) {
        finding.evidence.source = target.source;
      }
      if (target.snapshotIndex !== undefined && finding.evidence.snapshotIndex === undefined) {
        finding.evidence.snapshotIndex = target.snapshotIndex;
      }

      const box = finding.evidence.layout?.box || finding.evidence.hitTest?.bounds || target.box;
      if (captureCrops && !finding.evidence.cropBase64 && (finding.evidence.selector || box)) {
        const shot = await cropOne(page, outDir, `${slug(finding.route)}_${i}`, finding.evidence.selector, box).catch(
          () => ({} as CropResult),
        );
        if (shot.cropBase64) finding.evidence.cropBase64 = shot.cropBase64;
        if (shot.crop) finding.evidence.crop = shot.crop;
      }
    }
  } finally {
    if (scrollBefore) {
      await page.evaluate(({ x, y }) => window.scrollTo(x, y), scrollBefore).catch(() => {});
    }
  }
}

const API_CALL_CAP = 100;

function summarizeGuidance(pack: GuidancePack): GuidanceSummary {
  const summary: GuidanceSummary = { fetchedAt: pack.fetchedAt };
  if (pack.robots) {
    summary.robots = {
      status: pack.robots.status,
      allow: pack.robots.rules.allow,
      disallow: pack.robots.rules.disallow,
    };
  }
  if (pack.sitemap) {
    summary.sitemap = {
      urlCount: pack.sitemap.urls.length,
      samplePaths: pack.sitemap.urls.slice(0, 30).map((u) => {
        try {
          return new URL(u).pathname;
        } catch {
          return u;
        }
      }),
    };
  }
  if (pack.llms) {
    summary.llms = {
      path: pack.llms.path,
      headings: pack.llms.headings.slice(0, 40),
      excerpt: pack.llms.text.slice(0, 500),
    };
  }
  return summary;
}

function buildApiIndex(pages: PageReport[]): { method: string; url: string; pages: string[]; statuses: number[] }[] {
  const map = new Map<string, { method: string; url: string; pages: string[]; statuses: number[] }>();
  for (const p of pages) {
    for (const call of p.apiCalls ?? []) {
      const key = `${call.method} ${call.url}`;
      let entry = map.get(key);
      if (!entry) {
        entry = { method: call.method, url: call.url, pages: [], statuses: [] };
        map.set(key, entry);
      }
      if (!entry.pages.includes(p.route)) entry.pages.push(p.route);
      if (call.status !== undefined && !entry.statuses.includes(call.status)) entry.statuses.push(call.status);
    }
  }
  return [...map.values()].sort((a, b) => a.url.localeCompare(b.url));
}

interface VisitTask {
  index: number;
  route: string;
  viewport: import('./config.js').Viewport;
}

interface VisitResult {
  taskIndex: number;
  page: PageReport;
  rawFindings: RawFinding[];
}

/**
 * Run one detector, and record it if it throws.
 *
 * Returning the fallback keeps the crawl going, but the failure is reported rather than
 * swallowed: a detector that dies must not be indistinguishable from a detector that
 * found nothing, because that turns a tool bug into a false "clean" verdict.
 */
async function runDetector<T>(
  route: string,
  detector: string,
  failures: DetectorFailure[],
  run: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ route, detector, message });
    process.stderr.write(`[ui-crawl] detector "${detector}" failed on ${route}: ${message}\n`);
    return fallback;
  }
}

async function executeVisit(
  browser: Browser,
  cfg: import('./config.js').ResolvedConfig,
  gate: PolitenessGate,
  task: VisitTask,
  totalVisits: number,
  detectorFailures: DetectorFailure[],
): Promise<VisitResult> {
  const { index, route, viewport } = task;
  const viewportEvidence: ViewportEvidence = { width: viewport.width, height: viewport.height, label: viewport.label };
  const viewportSuffix = cfg.viewports.length > 1 ? `--${slug(viewport.label ?? `${viewport.width}x${viewport.height}`)}` : '';
  const vpLabel = viewport.label ?? `${viewport.width}x${viewport.height}`;

  const progressMsg = `[ui-crawl] [${index}/${totalVisits}] ${route} (${vpLabel})...`;
  process.stderr.write(progressMsg + '\n');
  cfg.onProgress?.({ phase: 'page-start', route, pageIndex: index, totalPages: totalVisits, message: progressMsg });

  const rawFindings: RawFinding[] = [];
  const url = cfg.baseUrl + route;

  if (!(await gate.allowed(url))) {
    rawFindings.push({ route, kind: 'robots-blocked', evidence: { url, viewport: viewportEvidence } });
    return {
      taskIndex: index,
      page: {
        route,
        template: toRouteTemplate(route),
        viewport: viewportEvidence,
        status: null,
        consoleErrors: [],
        failedRequests: [],
        controlCount: 0,
      },
      rawFindings,
    };
  }

  const { context } = await buildContext(browser, cfg, { width: viewport.width, height: viewport.height });
  const page = await context.newPage();

  try {
    const collectors = attachCollectors(page, cfg.origin);
    const load = await gotoRoute(page, url, cfg.navTimeoutMs, {
      attempts: cfg.navRetries,
      beforeAttempt: () => gate.pace(url),
      onRetry: () => collectors.reset(),
    });
    const artifactSlug = `${slug(route)}${viewportSuffix}`;
    // devicePixelRatio is read from the live page, not assumed: headed runs on hidpi
    // displays capture at 2x, and every box-to-pixel conversion downstream needs it.
    const deviceScaleFactor = await page
      .evaluate(() => window.devicePixelRatio || 1)
      .catch(() => 1);
    if (deviceScaleFactor !== 1) viewportEvidence.deviceScaleFactor = deviceScaleFactor;
    // The audit's eyes. `baseShot` is the viewport render — the size a vision model can
    // actually read. `fullShot` is the whole document, captured only when the document is
    // taller than the viewport; a 1280x8000 tall image downscaled to model input is
    // illegible, so the two serve different purposes and are named for it.
    const baseShot = await shoot(page, cfg.outDir, artifactSlug);
    const fullShot = (await hasBelowFold(page)) ? await shoot(page, cfg.outDir, `${artifactSlug}@full`, true) : undefined;

    // Bot-challenge interstitial: app never rendered — swap the load finding and skip audits.
    let challenged = false;
    try {
      const title = await page.title();
      const bodyTextSample = await page
        .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 2000))
        .catch(() => '');
      const mainRespHeaders: Record<string, string> = {};
      challenged = isChallengePage({
        status: load.status,
        url,
        title,
        bodyTextSample,
        headers: mainRespHeaders,
      });
    } catch {
      challenged = false;
    }

    let controls: Awaited<ReturnType<typeof enumerateControls>> = [];
    if (!challenged) {
      controls = await enumerateControls(page).catch((err: unknown) => {
        reportDetectorFailure(route, 'enumerate-controls', err instanceof Error ? err.message : String(err));
        return [];
      });
    }

    // Stage pierced element pools once, early, so every later phase (accessibility
    // images, evidence resolution) can read them. Guarded and idempotent: the first
    // call pays four round trips, every later one is a single boolean check.
    await primeDeepPools(page);

    // Set-of-marks render for vision callers: badge n sits on control [n]. Only with
    // captureCrops (the "a vision model is watching" flag), only on real app renders,
    // and always alongside — never instead of — the clean screenshot.
    let markedShot: string | undefined;
    if (!challenged && cfg.captureCrops) {
      const marks = await markControls(page).catch((err: unknown) => {
        reportDetectorFailure(route, 'mark-controls', err instanceof Error ? err.message : String(err));
        return null;
      });
      if (marks && marks.count > 0) {
        try {
          markedShot = await shoot(page, cfg.outDir, `${artifactSlug}@marked`);
        } finally {
          await marks.cleanup();
        }
      } else {
        await marks?.cleanup();
      }
    }

    let apiCalls: ApiCall[] | undefined;
    let apiCallsOverflow: number | undefined;
    if (cfg.networkInventory) {
      const all = collectors.apiCalls;
      apiCallsOverflow = Math.max(0, all.length - API_CALL_CAP);
      apiCalls = all.slice(0, API_CALL_CAP);
    }
    collectors.dispose();

    if (challenged) {
      rawFindings.push({
        route,
        kind: 'bot-challenge',
        evidence: {
          url,
          screenshot: baseShot,
          consoleText: [`HTTP ${load.status ?? 'challenge'}${challengeSeverity(load.status) === 'high' ? ' (hard block)' : ''}`],
        },
      });
    } else {
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
        if (fr.url === url || isChallengeSubresource(fr.url)) continue;
        rawFindings.push({
          route,
          kind: 'broken-asset',
          evidence: {
            url: fr.url,
            consoleText: [fr.status ? `HTTP ${fr.status}` : (fr.failure ?? 'Failed')],
          },
        });
      }
    }
    const dedupedFailed = challenged ? [] : dedupeRequests(collectors.failedRequests);

    let palette: ColorPalette | undefined;
    let textDigest: number | undefined;
    let textLength: number | undefined;
    if (!challenged && !cfg.skipContrast) {
      const colorAudit = await runDetector(
        route,
        'contrast',
        detectorFailures,
        () => auditPageColors(page, route),
        EMPTY_COLOR_AUDIT,
      );
      rawFindings.push(...colorAudit.rawFindings);
      palette = colorAudit.palette;
      textDigest = colorAudit.textDigest;
      textLength = colorAudit.textLength;
    }

    if (!challenged && !cfg.skipSpacing) {
      const spacingFindings = await runDetector(route, 'spacing', detectorFailures, () => auditPageSpacing(page, route), []);
      rawFindings.push(...spacingFindings);
    }

    if (!challenged && !cfg.skipLayout) {
      const layoutFindings = await runDetector(
        route, 'layout', detectorFailures, () => auditPageLayout(page, route, { viewport: viewportEvidence }), []);
      rawFindings.push(...layoutFindings);
      const tabFindings = await runDetector(route, 'tab-panels', detectorFailures, () => auditTabPanels(page, route), []);
      rawFindings.push(...tabFindings);
    }

    if (!challenged && !cfg.skipAffordance) {
      const affordanceFindings = await runDetector(
        route, 'affordance', detectorFailures, () => auditPageAffordance(page, route, controls), []);
      rawFindings.push(...affordanceFindings);
    }

    if (!challenged && !cfg.skipHitTest && !cfg.skipSpacing) {
      const hitTestFindings = await runDetector(
        route, 'hit-test', detectorFailures, () => auditPageHitTest(page, route, { viewport: viewportEvidence }), []);
      rawFindings.push(...hitTestFindings);
    }

    if (!challenged) {
      const accessibilityFindings = await runDetector(
        route, 'accessibility', detectorFailures, () => auditPageAccessibility(page, route, { viewport: viewportEvidence }), []);
      rawFindings.push(...accessibilityFindings);
      const stateFindings = await runDetector(
        route, 'aria-state', detectorFailures, () => auditPageStates(page, route, { viewport: viewportEvidence }), []);
      rawFindings.push(...stateFindings);
    }

    let darkShot: string | undefined;
    if (!challenged && cfg.themeSweep) {
      await page.emulateMedia({ colorScheme: 'dark' }).catch(() => {});
      await page.evaluate(() => document.documentElement.classList.add('dark')).catch(() => {});
      const darkStart = rawFindings.length;
      const darkAudit = await runDetector(
        route, 'dark-contrast', detectorFailures, () => auditPageColors(page, route),
        EMPTY_COLOR_AUDIT,
      );
      for (const df of darkAudit.rawFindings) {
        df.kind = 'dark-mode-contrast';
        df.evidence.theme = 'dark';
        rawFindings.push(df);
      }
      // A dark-mode failure photographed in light mode is a misleading picture. Capture
      // the dark render once, and crop the dark findings against it while it is loaded.
      darkShot = await shoot(page, cfg.outDir, `${artifactSlug}--dark`);
      if (cfg.captureCrops) {
        const scrollBefore = await readScroll(page);
        try {
          for (let i = darkStart; i < rawFindings.length; i++) {
            const df = rawFindings[i];
            const shot = await cropOne(
              page,
              cfg.outDir,
              `${artifactSlug}--dark_${i - darkStart}`,
              df.evidence.selector,
              df.evidence.layout?.box,
            ).catch(() => ({} as CropResult));
            if (shot.cropBase64) df.evidence.cropBase64 = shot.cropBase64;
            if (shot.crop) df.evidence.crop = shot.crop;
          }
        } finally {
          if (scrollBefore) {
            await page.evaluate(({ x, y }) => window.scrollTo(x, y), scrollBefore).catch(() => {});
          }
        }
      }
      await page.emulateMedia({ colorScheme: 'light' }).catch(() => {});
      await page.evaluate(() => document.documentElement.classList.remove('dark')).catch(() => {});
    }

    let zoomShots: { zoom: number; screenshot: string }[] = [];
    if (!challenged && !cfg.skipZoom) {
      const z = await zoomPass(page, route, cfg, (label) => shoot(page, cfg.outDir, `${artifactSlug}${label}`), baseShot);
      rawFindings.push(...z.raw);
      zoomShots = z.shots;
    }

    // Resolve selector-addressed evidence while the DOM is still the audited render.
    //
    // This MUST run before the interaction sweep. That sweep clicks links, so by the time
    // it finishes the page is often a different document entirely — resolving
    // `button#disabledBtn` after it silently finds nothing, which is why crops and source
    // locations were missing for most finding types. Last read-only moment on this page.
    await enrichEvidence(page, cfg.outDir, rawFindings, viewportEvidence, cfg.captureCrops);

    let probedControls: number | undefined;
    let skippedControls: number | undefined;
    if (!challenged && !cfg.skipInteractionSweep) {
      await autoFillFormInputs(page).catch((err: unknown) => {
        reportDetectorFailure(route, 'auto-fill-form', err instanceof Error ? err.message : String(err));
        return 0;
      });
      const sweep = await sweepControls(page, route, url, controls, cfg, () => gate.pace(url));
      rawFindings.push(...sweep.findings);
      probedControls = sweep.probed;
      skippedControls = sweep.skipped;
    }

    // The sweep contributes findings of its own, and it clicks links — so by now the page
    // may be showing a different document. Cropping at the audited route's coordinates
    // while a DIFFERENT page is rendered would attach a picture of the wrong thing, which
    // is worse than attaching none.
    //
    // Every control's box was measured on the pristine render and travels with the
    // finding, so one reload of the same URL restores those coordinates to a valid
    // context. Geometry is reproducible for a GET, so the boxes still line up. That buys
    // real images for the interaction findings at the cost of a single navigation, and
    // only on the pages where the sweep actually navigated away.
    const pendingCrops = cfg.captureCrops
      ? rawFindings
          .map((f, i) => ({ f, i }))
          .filter(
            ({ f }) =>
              !f.evidence.cropBase64 &&
              (f.evidence.selector || f.evidence.layout?.box || f.evidence.hitTest?.bounds || f.evidence.boxes?.[0]),
          )
      : [];

    if (pendingCrops.length && page.url() !== url) {
      await page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs })
        .catch(() => {});
    }

    if (pendingCrops.length) {
      const scrollBefore = await readScroll(page);
      try {
        for (const { f: finding, i } of pendingCrops) {
          finding.evidence.viewport = finding.evidence.viewport ?? viewportEvidence;
          const box = finding.evidence.layout?.box || finding.evidence.hitTest?.bounds || finding.evidence.boxes?.[0];
          const shot = await cropOne(
            page,
            cfg.outDir,
            `${slug(finding.route)}_sweep_${i}`,
            finding.evidence.selector,
            box,
          ).catch(() => ({} as CropResult));
          if (shot.cropBase64) finding.evidence.cropBase64 = shot.cropBase64;
          if (shot.crop) finding.evidence.crop = shot.crop;
        }
      } finally {
        if (scrollBefore) {
          await page.evaluate(({ x, y }) => window.scrollTo(x, y), scrollBefore).catch(() => {});
        }
      }
    }

    for (const finding of rawFindings) {
      finding.evidence.viewport = finding.evidence.viewport ?? viewportEvidence;
    }

    const pageReport: PageReport = {
      route,
      template: toRouteTemplate(route),
      viewport: viewportEvidence,
      status: load.status,
      loadError: load.loadError,
      challenged: challenged || undefined,
      screenshot: baseShot,
      ...(fullShot ? { screenshotFull: fullShot } : {}),
      ...(darkShot ? { darkScreenshot: darkShot } : {}),
      ...(markedShot ? { screenshotMarked: markedShot } : {}),
      zoomShots,
      consoleErrors: challenged ? [] : collectors.consoleErrors,
      failedRequests: dedupedFailed,
      ...(cfg.networkInventory ? { apiCalls, apiCallsOverflow } : {}),
      controlCount: controls.length,
      probedControls,
      skippedControls,
      textDigest,
      textLength,
      palette,
    };

    return {
      taskIndex: index,
      page: pageReport,
      rawFindings,
    };
  } catch (err) {
    rawFindings.push({
      route,
      kind: 'page-load-error',
      evidence: {
        url,
        viewport: viewportEvidence,
        consoleText: [err instanceof Error ? err.message : String(err)],
      },
    });
    return {
      taskIndex: index,
      page: {
        route,
        template: toRouteTemplate(route),
        viewport: viewportEvidence,
        status: null,
        consoleErrors: [err instanceof Error ? err.message : String(err)],
        failedRequests: [],
        controlCount: 0,
      },
      rawFindings,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function crawl(config: CrawlConfig): Promise<CrawlResult> {
  const cfg = resolveConfig(config);
  const startedAt = new Date().toISOString();

  const initialViewport = { width: cfg.viewports[0].width, height: cfg.viewports[0].height };
  const session = await openSession(cfg, initialViewport);
  const gate = new PolitenessGate(session.context.request, cfg.perHostDelayMs, cfg.respectRobots, session.userAgent);

  const pages: PageReport[] = [];
  const rawFindings: RawFinding[] = [];
  const detectorFailures: DetectorFailure[] = [];
  // Plumbing outside `runDetector` (modal detection, control enumeration, badge marking,
  // form auto-fill) reports here too, so a crash there is never indistinguishable from
  // "nothing to report".
  setDetectorErrorHandler((route, detector, message) => {
    detectorFailures.push({ route, detector, message });
    process.stderr.write(`[ui-crawl] ${detector} failed on ${route || '(unknown route)'}: ${message}\n`);
  });
  let guidancePack: GuidancePack | undefined;


  try {
    // Site guidance pack (robots/sitemap/llms) — GET-only, fail-soft, before discovery.
    if (cfg.guidance) {
      const robotsText = await gate.peekRobots(cfg.origin).catch(() => null);
      guidancePack = await fetchGuidance(session.context.request, cfg.origin, {
        userAgent: session.userAgent,
        robotsText,
      }).catch(() => undefined);
    }

    // Discovery gets a page of its own; it is closed before the crawl proper starts.
    let routes: string[];
    if (cfg.routes === 'discover') {
      const scout = await newPage(session);
      routes = await discoverRoutes(scout, cfg, guidancePack);
      await scout.close().catch(() => {});
    } else {
      routes = planSeedList(cfg.routes, cfg.maxPages);
    }

    const tasks: VisitTask[] = [];
    let taskIdx = 0;
    for (const viewport of cfg.viewports) {
      for (const route of routes) {
        tasks.push({ index: ++taskIdx, route, viewport });
      }
    }
    const totalVisits = tasks.length;

    const workerCount = Math.min(cfg.concurrency, tasks.length);
    let taskCursor = 0;
    let completedCount = 0;
    const visitResults: VisitResult[] = [];

    async function worker(): Promise<void> {
      while (true) {
        const task = tasks[taskCursor++];
        if (!task) break;

        const res = await executeVisit(session.browser, cfg, gate, task, totalVisits, detectorFailures);
        visitResults.push(res);

        completedCount++;
        const doneMsg = `[ui-crawl] [${completedCount}/${totalVisits}] ${task.route} done (${res.rawFindings.length} findings)`;
        process.stderr.write(doneMsg + '\n');
        cfg.onProgress?.({
          phase: 'page-done',
          route: task.route,
          pageIndex: completedCount,
          totalPages: totalVisits,
          message: doneMsg,
        });
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Deterministic sort: preserve initial route and viewport order
    visitResults.sort((a, b) => a.taskIndex - b.taskIndex);
    for (const r of visitResults) {
      pages.push(r.page);
      rawFindings.push(...r.rawFindings);
    }
  } finally {
    await closeSession(session);
  }

  const triaged = rawFindings.map((r) => triageRaw(r));
  // Refine bot-challenge severity from HTTP status (still taste — never a defect).
  for (const f of triaged) {
    if (f.type === 'bot-challenge') {
      const statusMatch = /HTTP (\d+)/.exec(f.evidence.consoleText?.[0] ?? '');
      const status = statusMatch ? Number(statusMatch[1]) : null;
      f.severity = challengeSeverity(status);
    }
  }
  // Bound the report before anything is persisted: the DB, the payload, and the diff
  // must all agree on the same finding set, and a dropped finding is counted, not hidden.
  const { findings, truncated } = capFindings(triaged, cfg.maxFindingsPerPage);

  const finishedAt = new Date().toISOString();
  setDetectorErrorHandler(null);
  const result: CrawlResult = { baseUrl: cfg.baseUrl, startedAt, finishedAt, pages, findings };
  if (truncated > 0) result.truncated = truncated;
  if (detectorFailures.length > 0) result.detectorFailures = detectorFailures;
  if (guidancePack) result.guidance = summarizeGuidance(guidancePack);
  if (cfg.networkInventory) result.apiIndex = buildApiIndex(pages);

  // The database is the system of record: it persists the FULL triaged set, because a
  // capped finding that vanished from the payload would otherwise read as "fixed" in
  // the next diff. The payload and findings.json carry the capped working view; every
  // object is shared by reference, so ids and fingerprints assigned here land on both.
  const fullResult: CrawlResult = { ...result, findings: triaged };
  if (truncated > 0) fullResult.truncated = truncated;

  if (cfg.dbPath !== null) {
    try {
      const db = openDatabase(cfg.dbPath);
      const runId = saveRun(db, fullResult, undefined, cfg.outDir);
      result.runId = runId;
      if (cfg.diff) {
        const baselineId = typeof cfg.diff === 'string' ? cfg.diff : undefined;
        const diffRes = getDiff(db, result.runId!, baselineId);
        if (diffRes) result.diff = diffRes;
      }
    } catch {
      /* non-fatal DB write failure */
    }
  }

  const sink = config.sink ?? new FilesystemSink();
  const reportArtifacts: ReportArtifact[] = [
    { name: 'findings.json', content: buildFindingsJson(fullResult) },
    { name: 'payload.json', content: JSON.stringify(buildAgentPayload(result), null, 2) },
  ];
  if (guidancePack) reportArtifacts.push(...guidanceArtifacts(guidancePack));
  result.reportPath = await sink.write({
    outDir: cfg.outDir,
    artifacts: reportArtifacts,
  });

  const defects = result.findings.filter((f) => f.bucket === 'defect').length;
  const taste = result.findings.filter((f) => f.bucket === 'taste').length;
  const truncatedNote = truncated > 0 ? `, ${truncated} truncated by --max-findings` : '';
  const finishMsg = `[ui-crawl] Completed crawl of ${result.pages.length} page(s) (${defects} defects, ${taste} taste${truncatedNote})`;
  process.stderr.write(finishMsg + '\n');
  cfg.onProgress?.({ phase: 'crawl-done', totalPages: result.pages.length, message: finishMsg });

  return result;
}
