import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { Page, Browser } from 'playwright';
import { resolveConfig, type CrawlConfig } from './config.js';
import type { CrawlResult, PageReport, RawFinding, ColorPalette } from './types.js';
import { toRouteTemplate } from './routeTemplate.js';
import { openSession, closeSession, newPage, buildContext } from './browser.js';
import { gotoRoute, attachCollectors, dedupeRequests } from './capture.js';
import { enumerateControls, sweepControls } from './interactions.js';
import { auditPageAccessibility } from './accessibility.js';
import { auditPageStates } from './state.js';
import { observeExtraControls } from './observe.js';
import { NoopTextTriagePort } from './ports.js';
import { zoomPass } from './zoom.js';
import { discoverRoutes, planSeedList } from './discover.js';
import { fetchGuidance, guidanceArtifacts, type GuidancePack } from './guidance.js';
import { isChallengePage, challengeSeverity } from './challenge.js';
import { auditPageColors, contrastRatio, relativeLuminance, parseColor } from './colors.js';
import { auditPageSpacing, edgeDistance } from './spacing.js';
import { auditPageAffordance } from './affordance.js';
import { auditPageLayout, boxIntersection } from './layout.js';
import { auditPageHitTest } from './hitTest.js';
import { resolveSourceForSelector } from './source.js';
import { openDatabase, saveRun, getDiff } from './db.js';
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
import { buildFindingsJson, buildAgentPayload } from './report.js';
import { FilesystemSink } from './sink.js';
import type { ReportArtifact } from './sink.js';
import type { ApiCall, GuidanceSummary } from './types.js';

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
export { observeExtraControls, parseObserveReply, observedControls, buildObservePrompt } from './observe.js';
export { buildSnapshot, formatSnapshot, relocateControl } from './snapshot.js';
export { auditPageAccessibility } from './accessibility.js';
export { auditPageStates } from './state.js';
export { SELECTOR, SNAPSHOT_SELECTOR } from './selectors.js';
export { isChallengePage, challengeSeverity } from './challenge.js';
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
export { auditPageColors, contrastRatio, relativeLuminance, parseColor } from './colors.js';
export { auditPageSpacing, edgeDistance } from './spacing.js';
export { auditPageAffordance } from './affordance.js';
export { auditPageLayout, boxIntersection } from './layout.js';
export { triageRaw } from './triage.js';
export { toRouteTemplate } from './routeTemplate.js';
export { planVisits, planSeedList } from './discover.js';
export { buildFindingsJson, buildAgentPayload, type AgentPayload, type AgentAction } from './report.js';
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
export { startUiServer, broadcastEvent, type UiServer, type UiServerOptions } from './server.js';


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

async function executeVisit(
  browser: Browser,
  cfg: import('./config.js').ResolvedConfig,
  gate: PolitenessGate,
  task: VisitTask,
  totalVisits: number,
): Promise<VisitResult> {
  const { index, route, viewport } = task;
  const viewportEvidence = { width: viewport.width, height: viewport.height, label: viewport.label };
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
    const baseShot = await shoot(page, cfg.outDir, artifactSlug);

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
      controls = await enumerateControls(page).catch(() => []);
      if (cfg.observeControls && !(cfg.text instanceof NoopTextTriagePort)) {
        const extras = await observeExtraControls(page, cfg.text);
        if (extras.length) controls = [...controls, ...extras];
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
        if (fr.url === url) continue;
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
      const colorAudit = await auditPageColors(page, route).catch(() => ({ rawFindings: [], palette: undefined, textDigest: undefined, textLength: undefined }));
      rawFindings.push(...colorAudit.rawFindings);
      palette = colorAudit.palette;
      textDigest = colorAudit.textDigest;
      textLength = colorAudit.textLength;
    }

    if (!challenged && !cfg.skipSpacing) {
      const spacingFindings = await auditPageSpacing(page, route).catch(() => []);
      rawFindings.push(...spacingFindings);
    }

    if (!challenged && !cfg.skipLayout) {
      const layoutFindings = await auditPageLayout(page, route, { viewport: viewportEvidence }).catch(() => []);
      rawFindings.push(...layoutFindings);
      const tabFindings = await auditTabPanels(page, route).catch(() => []);
      rawFindings.push(...tabFindings);
    }

    if (!challenged && !cfg.skipAffordance) {
      const affordanceFindings = await auditPageAffordance(page, route, controls).catch(() => []);
      rawFindings.push(...affordanceFindings);
    }

    if (!challenged && !cfg.skipHitTest && !cfg.skipSpacing) {
      const hitTestFindings = await auditPageHitTest(page, route, { viewport: viewportEvidence }).catch(() => []);
      rawFindings.push(...hitTestFindings);
    }

    if (!challenged) {
      const accessibilityFindings = await auditPageAccessibility(page, route, { viewport: viewportEvidence }).catch(() => []);
      rawFindings.push(...accessibilityFindings);
      const stateFindings = await auditPageStates(page, route, { viewport: viewportEvidence }).catch(() => []);
      rawFindings.push(...stateFindings);
    }

    if (!challenged && cfg.themeSweep) {
      await page.emulateMedia({ colorScheme: 'dark' }).catch(() => {});
      await page.evaluate(() => document.documentElement.classList.add('dark')).catch(() => {});
      const darkAudit = await auditPageColors(page, route).catch(() => ({ rawFindings: [] }));
      for (const df of darkAudit.rawFindings) {
        df.kind = 'dark-mode-contrast';
        df.evidence.theme = 'dark';
        rawFindings.push(df);
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

    let probedControls: number | undefined;
    let skippedControls: number | undefined;
    if (!challenged && !cfg.skipInteractionSweep) {
      await autoFillFormInputs(page).catch(() => 0);
      const sweep = await sweepControls(page, route, url, controls, cfg, () => gate.pace(url));
      rawFindings.push(...sweep.findings);
      probedControls = sweep.probed;
      skippedControls = sweep.skipped;
    }

    for (const finding of rawFindings) {
      finding.evidence.viewport = viewportEvidence;
      if (finding.evidence.selector && !finding.evidence.source) {
        const src = await resolveSourceForSelector(page, finding.evidence.selector).catch(() => undefined);
        if (src) finding.evidence.source = src;
      }
      if (cfg.captureCrops && !finding.evidence.cropBase64) {
        const b = finding.evidence.layout?.box || finding.evidence.hitTest?.bounds;
        if (b && b.w > 0 && b.h > 0) {
          const pad = 20;
          const clip = {
            x: Math.max(0, b.x - pad),
            y: Math.max(0, b.y - pad),
            width: Math.min(viewport.width, b.w + pad * 2),
            height: Math.min(viewport.height, b.h + pad * 2),
          };
          const buffer = await page.screenshot({ clip }).catch(() => null);
          if (buffer) {
            finding.evidence.cropBase64 = `data:image/png;base64,${buffer.toString('base64')}`;
          }
        }
      }
    }

    const pageReport: PageReport = {
      route,
      template: toRouteTemplate(route),
      viewport: viewportEvidence,
      status: load.status,
      loadError: load.loadError,
      challenged: challenged || undefined,
      screenshot: baseShot,
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

        const res = await executeVisit(session.browser, cfg, gate, task, totalVisits);
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

  const findings = await Promise.all(
    rawFindings.map((r) => triageRaw(r, { vision: cfg.vision, text: cfg.text })),
  );
  // Refine bot-challenge severity from HTTP status (still taste — never a defect).
  for (const f of findings) {
    if (f.type === 'bot-challenge') {
      const statusMatch = /HTTP (\d+)/.exec(f.evidence.consoleText?.[0] ?? '');
      const status = statusMatch ? Number(statusMatch[1]) : null;
      f.severity = challengeSeverity(status);
    }
  }

  const finishedAt = new Date().toISOString();
  const result: CrawlResult = { baseUrl: cfg.baseUrl, startedAt, finishedAt, pages, findings };
  if (guidancePack) result.guidance = summarizeGuidance(guidancePack);
  if (cfg.networkInventory) result.apiIndex = buildApiIndex(pages);

  if (cfg.dbPath !== null) {
    try {
      const db = openDatabase(cfg.dbPath);
      saveRun(db, result);
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
    { name: 'findings.json', content: buildFindingsJson(result) },
    { name: 'payload.json', content: JSON.stringify(buildAgentPayload(result), null, 2) },
  ];
  if (guidancePack) reportArtifacts.push(...guidanceArtifacts(guidancePack));
  result.reportPath = await sink.write({
    outDir: cfg.outDir,
    artifacts: reportArtifacts,
  });

  const defects = result.findings.filter((f) => f.bucket === 'defect').length;
  const taste = result.findings.filter((f) => f.bucket === 'taste').length;
  const finishMsg = `[ui-crawl] Completed crawl of ${result.pages.length} page(s) (${defects} defects, ${taste} taste)`;
  process.stderr.write(finishMsg + '\n');
  cfg.onProgress?.({ phase: 'crawl-done', totalPages: result.pages.length, message: finishMsg });

  return result;
}
