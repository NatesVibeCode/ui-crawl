import type { Page, Request, Response } from 'playwright';
import type { ApiCall } from './types.js';

/** Per-page load + passive collectors (console errors, failed requests, API calls). Browser I/O. */

export interface PageLoad {
  status: number | null;
  loadError?: string;
}

export interface GotoOptions {
  /** Total attempts for a retryable failure (429/502/503/504 or a network error). Default 1. */
  attempts?: number;
  /** Awaited before every navigation attempt — the politeness gate. */
  beforeAttempt?: () => Promise<void> | void;
  /** Called when an attempt is about to be retried, so a failed attempt's noise can be dropped. */
  onRetry?: () => void;
}

/** A throttled or briefly-down server is not a broken page. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_CAP_MS = 30_000;

function retryAfterMs(header: string | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_CAP_MS);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), RETRY_CAP_MS)) : null;
}

export async function gotoRoute(
  page: Page,
  url: string,
  navTimeoutMs: number,
  opts: GotoOptions = {},
): Promise<PageLoad> {
  const attempts = Math.max(1, opts.attempts ?? 1);
  let last: PageLoad = { status: null };

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.beforeAttempt) await opts.beforeAttempt();
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
      const status = resp ? resp.status() : null;
      if (status !== null && RETRYABLE_STATUS.has(status) && attempt < attempts - 1) {
        const wait = retryAfterMs(resp?.headers()['retry-after']) ?? Math.min(250 * 2 ** attempt, 5000);
        if (opts.onRetry) opts.onRetry();
        await page.waitForTimeout(wait);
        continue;
      }
      await page.waitForTimeout(300); // let client-side render settle
      return { status };
    } catch (e) {
      last = { status: null, loadError: (e as Error).message };
      if (attempt >= attempts - 1) return last;
      if (opts.onRetry) opts.onRetry();
      await page.waitForTimeout(Math.min(250 * 2 ** attempt, 5000));
    }
  }
  return last;
}

export interface Collectors {
  consoleErrors: string[];
  failedRequests: { url: string; status?: number; failure?: string }[];
  /** XHR/fetch inventory (always collected; PageReport caps when serializing). */
  apiCalls: ApiCall[];
  /**
   * Drop everything collected so far. A navigation attempt that got a retryable status
   * answered with throttle noise (a 503 console error, the failed document request), not
   * with the page's own behavior — keeping it would report a recovered throttle as a
   * page full of defects.
   */
  reset(): void;
  dispose(): void;
}

/** Resource types that constitute a scraping-relevant API surface. */
export function isApiRequest(resourceType: string, method: string): boolean {
  if (resourceType === 'xhr' || resourceType === 'fetch') return true;
  // Non-GET document requests are form/API navigations worth inventorying.
  if (resourceType === 'document' && method !== 'GET' && method !== 'HEAD') return true;
  return false;
}

/** Stable inventory key: same-origin → path+query; else absolute URL. */
export function apiUrlKey(url: string, origin: string): string {
  try {
    const u = new URL(url);
    if (u.origin === origin) return `${u.pathname}${u.search}`;
    return u.href;
  } catch {
    return url;
  }
}

export function attachCollectors(page: Page, origin?: string): Collectors {
  const consoleErrors: string[] = [];
  const failedRequests: { url: string; status?: number; failure?: string }[] = [];
  const apiCalls: ApiCall[] = [];
  const apiSeen = new Set<string>();
  const selfOrigin = origin ?? '';

  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  };
  const onRequestFailed = (req: { url(): string; failure(): { errorText: string } | null }) => {
    const f = req.failure();
    // blockedbyclient is our own cross-origin guard, not a defect.
    if (f && /blockedbyclient/i.test(f.errorText)) return;
    failedRequests.push({ url: req.url(), failure: f?.errorText });
  };
  const onApiRequest = (req: Request) => {
    if (!isApiRequest(req.resourceType(), req.method())) return;
    const key = `${req.method()} ${apiUrlKey(req.url(), selfOrigin)}`;
    if (apiSeen.has(key)) return;
    apiSeen.add(key);
    apiCalls.push({
      method: req.method(),
      url: apiUrlKey(req.url(), selfOrigin),
      resourceType: req.resourceType(),
    });
  };
  const onApiResponse = (resp: Response) => {
    if (resp.status() >= 400) failedRequests.push({ url: resp.url(), status: resp.status() });
    const req = resp.request();
    if (!isApiRequest(req.resourceType(), req.method())) return;
    const key = `${req.method()} ${apiUrlKey(req.url(), selfOrigin)}`;
    const hit = apiCalls.find(
      (c) => `${c.method} ${c.url}` === key,
    );
    if (hit) {
      hit.status = resp.status();
      const ct = resp.headers()['content-type'];
      if (ct) hit.contentType = ct;
    }
  };

  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);
  page.on('request', onApiRequest);
  page.on('response', onApiResponse);

  return {
    consoleErrors,
    failedRequests,
    apiCalls,
    reset() {
      consoleErrors.length = 0;
      failedRequests.length = 0;
      apiCalls.length = 0;
      apiSeen.clear();
    },
    dispose() {
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
      page.off('request', onApiRequest);
      page.off('response', onApiResponse);
    },
  };
}

export function dedupeRequests(
  reqs: { url: string; status?: number; failure?: string }[],
): { url: string; status?: number; failure?: string }[] {
  const seen = new Set<string>();
  const out: typeof reqs = [];
  for (const r of reqs) {
    const key = `${r.status ?? ''}|${r.url}|${r.failure ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
