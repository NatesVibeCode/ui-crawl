import * as os from 'node:os';
import type { ReportSink } from './sink.js';

export interface Viewport {
  width: number;
  height: number;
  label?: string;
}

/**
 * Playwright storage state: cookies plus per-origin localStorage. Structurally identical
 * to what `BrowserContext.storageState()` returns and what `newContext` accepts, spelled
 * out here so `src/` never imports Playwright types beyond the automation surface.
 */
export interface StorageStateData {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface CrawlConfig {
  /** The only required field. Base URL of a running dev server, e.g. http://localhost:3000. */
  baseUrl: string;
  /** Seed route list to visit, or 'discover' to start from '/' and follow same-origin links. */
  routes?: string[] | 'discover';
  /** Hard cap on visited route templates. Default 25. */
  maxPages?: number;
  /** Zoom factors to screenshot + reflow-check. Default [1, 1.5, 2]. */
  zoomLevels?: number[];
  /** Viewports to render. Default one desktop. */
  viewports?: Viewport[];
  /**
   * Authenticated context for gated targets: a storageState path, or the state object
   * itself (as produced by a --login flow). Omit for open/dev-bypass local targets.
   */
  storageState?: string | StorageStateData;
  /** Seed data file path or object containing localStorage / sessionStorage to pre-seed before loads. */
  seedStorage?: string | { localStorage?: Record<string, string>; sessionStorage?: Record<string, string> };
  /** Where artifacts are written. Default FilesystemSink(outDir). */
  sink?: ReportSink;
  /** Output directory. Default './ui-crawl-out'. */
  outDir?: string;
  /** Quiet window (ms) to observe change after a click. Default 1500. */
  interactionTimeoutMs?: number;
  /** Navigation timeout (ms). Default 15000. */
  navTimeoutMs?: number;
  /** Attempts per route navigation on 429/502/503/504 or a network error. Default 3. */
  navRetries?: number;
  /** Honour robots.txt. Default true. Loopback hosts are exempt either way. */
  respectRobots?: boolean;
  /** Minimum gap between navigations to the same non-loopback origin, in ms. Default 250. */
  perHostDelayMs?: number;
  /** Skip the dead-button interaction sweep. Default false. */
  skipInteractionSweep?: boolean;
  /**
   * Cap on controls click-probed per page. Default 40. A page with more controls is
   * still crawled, but the excess is counted in the report rather than probed — the
   * sweep is the only phase whose cost scales with page content, so this is what keeps
   * a control-dense page from running unbounded.
   */
  maxProbesPerPage?: number;
  /**
   * Cap on findings kept per route. Default 200. One pathological page must not be able
   * to drown the report (and the screenshot budget) in hundreds of same-style hits;
   * defects outrank taste when the cap binds, and the dropped count is reported as
   * `truncated` rather than swallowed.
   */
  maxFindingsPerPage?: number;
  /** Skip the zoom-reflow pass. Default false. */
  skipZoom?: boolean;
  /** Skip WCAG contrast ratio auditing. Default false. */
  skipContrast?: boolean;
  /** Skip hover/focus affordance checks. Default false. */
  skipAffordance?: boolean;
  /** Skip touch target & spacing checks. Default false. */
  skipSpacing?: boolean;
  /** Skip pointer hit-testing and touch target size checks. Default false. */
  skipHitTest?: boolean;
  /** Skip layout collision, multiline typography, and text clipping checks. Default false. */
  skipLayout?: boolean;
  /**
   * Fetch robots.txt / sitemap.xml / llms.txt once at start, save under
   * outDir/guidance/, and seed discovery from sitemap+llms links. Default true
   * (GET-only; disable with --no-guidance).
   */
  guidance?: boolean;
  /**
   * Record same-origin XHR/fetch calls per page (PageReport.apiCalls + apiIndex
   * rollup). Default true. Disable with --no-network.
   */
  networkInventory?: boolean;
  /** Override the honest crawl User-Agent (non-loopback default: ui-crawl/…). */
  userAgent?: string;
  /** Run the browser headless. Default true. */
  headless?: boolean;
  /** SQLite database path for run persistence and differential auditing. Default '.ui-crawl.db'. Set null to disable. */
  dbPath?: string | null;
  /** Compute differential against previous run (or specified run ID). Default false. */
  diff?: boolean | string;
  /** Run dual-theme sweep (both light and dark mode). Default false. */
  themeSweep?: boolean;
  /** Capture 200x200 micro-crop base64 PNGs for visual/layout defects. Default false. */
  captureCrops?: boolean;
  /** Browser engine to launch: chromium, webkit (Safari), or firefox. Default chromium. */
  browser?: 'chromium' | 'webkit' | 'firefox';
  /** Fast visual sweep mode (skips button clicking sweeps and zoom reflow loops). Default false. */
  quick?: boolean;
  /** Number of concurrent page visit workers. Default 4 (or available parallelism). */
  concurrency?: number;
  /** Progress callback invoked during crawl execution. */
  onProgress?: (event: { phase: string; route?: string; pageIndex?: number; totalPages?: number; message?: string }) => void;
}

export interface ResolvedConfig {
  baseUrl: string;
  origin: string;
  routes: string[] | 'discover';
  maxPages: number;
  zoomLevels: number[];
  viewports: Viewport[];
  storageState?: string | StorageStateData;
  seedStorage?: string | { localStorage?: Record<string, string>; sessionStorage?: Record<string, string> };
  outDir: string;
  interactionTimeoutMs: number;
  navTimeoutMs: number;
  navRetries: number;
  respectRobots: boolean;
  perHostDelayMs: number;
  skipInteractionSweep: boolean;
  maxProbesPerPage: number;
  maxFindingsPerPage: number;
  skipZoom: boolean;
  skipContrast: boolean;
  skipAffordance: boolean;
  skipSpacing: boolean;
  skipHitTest: boolean;
  skipLayout: boolean;
  guidance: boolean;
  networkInventory: boolean;
  userAgent?: string;
  headless: boolean;
  dbPath?: string | null;
  diff?: boolean | string;
  themeSweep: boolean;
  captureCrops: boolean;
  browser: 'chromium' | 'webkit' | 'firefox';
  quick: boolean;
  concurrency: number;
  onProgress?: (event: { phase: string; route?: string; pageIndex?: number; totalPages?: number; message?: string }) => void;
}

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800, label: 'desktop' };

/** Honest UA for non-loopback targets so logs and robots groups can identify us. */
export const UI_CRAWL_UA_PREFIX = 'ui-crawl/';

export function crawlUserAgent(origin: string, override?: string): string | undefined {
  if (override) return override;
  try {
    const host = new URL(origin).hostname;
    const loopback =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '0.0.0.0' ||
      /^127\./.test(host);
    if (loopback) return undefined;
  } catch {
    return `${UI_CRAWL_UA_PREFIX}0.1 (+${origin})`;
  }
  return `${UI_CRAWL_UA_PREFIX}0.1 (+${origin})`;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Pure: fill defaults and validate. Throws on a missing/invalid baseUrl. */
export function resolveConfig(c: CrawlConfig): ResolvedConfig {
  if (!c.baseUrl || typeof c.baseUrl !== 'string') {
    throw new Error('ui-crawl: config.baseUrl is required (e.g. "http://localhost:3000")');
  }
  let origin: string;
  try {
    origin = new URL(c.baseUrl).origin;
  } catch {
    throw new Error(`ui-crawl: config.baseUrl is not a valid URL: ${c.baseUrl}`);
  }
  const zoomLevels = c.zoomLevels && c.zoomLevels.length ? c.zoomLevels : [1, 1.5, 2];
  for (const z of zoomLevels) {
    if (!isPositiveFiniteNumber(z)) throw new Error(`ui-crawl: invalid zoom level ${z}`);
  }
  if (c.maxPages !== undefined && (!Number.isInteger(c.maxPages) || c.maxPages <= 0)) {
    throw new Error(`ui-crawl: invalid maxPages ${c.maxPages}`);
  }
  if (c.maxProbesPerPage !== undefined && (!Number.isInteger(c.maxProbesPerPage) || c.maxProbesPerPage <= 0)) {
    throw new Error(`ui-crawl: invalid maxProbesPerPage ${c.maxProbesPerPage}`);
  }
  if (c.maxFindingsPerPage !== undefined && (!Number.isInteger(c.maxFindingsPerPage) || c.maxFindingsPerPage <= 0)) {
    throw new Error(`ui-crawl: invalid maxFindingsPerPage ${c.maxFindingsPerPage}`);
  }
  if (c.interactionTimeoutMs !== undefined && !isPositiveFiniteNumber(c.interactionTimeoutMs)) {
    throw new Error(`ui-crawl: invalid interactionTimeoutMs ${c.interactionTimeoutMs}`);
  }
  if (c.navTimeoutMs !== undefined && !isPositiveFiniteNumber(c.navTimeoutMs)) {
    throw new Error(`ui-crawl: invalid navTimeoutMs ${c.navTimeoutMs}`);
  }
  if (c.navRetries !== undefined && (!Number.isInteger(c.navRetries) || c.navRetries <= 0)) {
    throw new Error(`ui-crawl: invalid navRetries ${c.navRetries}`);
  }
  if (c.perHostDelayMs !== undefined && (!Number.isFinite(c.perHostDelayMs) || c.perHostDelayMs < 0)) {
    throw new Error(`ui-crawl: invalid perHostDelayMs ${c.perHostDelayMs}`);
  }
  const viewports = c.viewports && c.viewports.length ? c.viewports : [DEFAULT_VIEWPORT];
  for (const viewport of viewports) {
    if (!isPositiveFiniteNumber(viewport.width) || !isPositiveFiniteNumber(viewport.height)) {
      throw new Error(`ui-crawl: invalid viewport ${viewport.label ?? `${viewport.width}x${viewport.height}`}`);
    }
  }
  // Screenshot filenames derive from the label. Two viewports sharing one would silently
  // overwrite each other's renders, so collisions get dimensions appended. Labels stay
  // untouched when the input is unambiguous.
  const labelCounts = new Map<string, number>();
  for (const v of viewports) {
    const base = v.label ?? `${v.width}x${v.height}`;
    labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
  }
  const dedupedViewports = viewports.map((v) => {
    const base = v.label ?? `${v.width}x${v.height}`;
    if ((labelCounts.get(base) ?? 0) <= 1) return v;
    return { ...v, label: `${base}-${v.width}x${v.height}` };
  });

  return {
    baseUrl: c.baseUrl.replace(/\/+$/, ''),
    origin,
    routes: c.routes ?? 'discover',
    maxPages: c.maxPages ?? 25,
    zoomLevels,
    viewports: dedupedViewports,
    storageState: c.storageState,
    seedStorage: c.seedStorage,
    outDir: c.outDir ?? './ui-crawl-out',
    interactionTimeoutMs: c.interactionTimeoutMs ?? 1500,
    navTimeoutMs: c.navTimeoutMs ?? 15000,
    navRetries: c.navRetries ?? 3,
    respectRobots: c.respectRobots ?? true,
    perHostDelayMs: c.perHostDelayMs ?? 250,
    skipInteractionSweep: c.quick ? true : (c.skipInteractionSweep ?? false),
    maxProbesPerPage: c.quick ? 0 : (c.maxProbesPerPage ?? 40),
    maxFindingsPerPage: c.maxFindingsPerPage ?? 200,
    skipZoom: c.quick ? true : (c.skipZoom ?? false),
    skipContrast: c.skipContrast ?? false,
    skipAffordance: c.skipAffordance ?? false,
    skipSpacing: c.skipSpacing ?? false,
    skipHitTest: c.skipHitTest ?? false,
    skipLayout: c.skipLayout ?? false,
    guidance: c.guidance ?? true,
    networkInventory: c.networkInventory ?? true,
    userAgent: c.userAgent,
    headless: c.headless ?? true,
    dbPath: c.dbPath !== undefined ? c.dbPath : '.ui-crawl.db',
    diff: c.diff,
    themeSweep: c.themeSweep ?? false,
    captureCrops: c.captureCrops ?? false,
    browser: c.browser ?? 'chromium',
    quick: c.quick ?? false,
    concurrency: c.concurrency !== undefined
      ? Math.max(1, Math.floor(c.concurrency))
      : Math.min(4, Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4)),
    onProgress: c.onProgress,
  };
}
