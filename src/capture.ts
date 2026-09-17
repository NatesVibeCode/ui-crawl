import type { Page } from 'playwright';

/** Per-page load + passive collectors (console errors, failed requests). Browser I/O. */

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
  /**
   * Drop everything collected so far. A navigation attempt that got a retryable status
   * answered with throttle noise (a 503 console error, the failed document request), not
   * with the page's own behavior — keeping it would report a recovered throttle as a
   * page full of defects.
   */
  reset(): void;
  dispose(): void;
}

export function attachCollectors(page: Page): Collectors {
  const consoleErrors: string[] = [];
  const failedRequests: { url: string; status?: number; failure?: string }[] = [];

  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  };
  const onRequestFailed = (req: { url(): string; failure(): { errorText: string } | null }) => {
    const f = req.failure();
    // blockedbyclient is our own cross-origin guard, not a defect.
    if (f && /blockedbyclient/i.test(f.errorText)) return;
    failedRequests.push({ url: req.url(), failure: f?.errorText });
  };
  const onResponse = (resp: { status(): number; url(): string }) => {
    if (resp.status() >= 400) failedRequests.push({ url: resp.url(), status: resp.status() });
  };

  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  return {
    consoleErrors,
    failedRequests,
    reset() {
      consoleErrors.length = 0;
      failedRequests.length = 0;
    },
    dispose() {
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
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
