import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ResolvedConfig } from './config.js';
import { crawlUserAgent } from './config.js';

export interface Session {
  browser: Browser;
  context: BrowserContext;
  /** UA actually sent on this session (undefined = Chromium default on loopback). */
  userAgent?: string;
}

/**
 * Build a context with the crawl's standing policy: viewport, storage state, seeded
 * storage, timeouts, honest User-Agent on non-loopback, and the two safety rails —
 * downloads refused, and top-level navigations to a different origin aborted (so an
 * external link or a logout-to-SSO can't carry the crawl off-site).
 */
async function buildContext(
  browser: Browser,
  cfg: ResolvedConfig,
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; userAgent?: string }> {
  const userAgent = crawlUserAgent(cfg.origin, cfg.userAgent);
  const context = await browser.newContext({
    viewport,
    storageState: cfg.storageState,
    acceptDownloads: false,
    ...(userAgent ? { userAgent } : {}),
  });
  context.setDefaultNavigationTimeout(cfg.navTimeoutMs);
  context.setDefaultTimeout(cfg.navTimeoutMs);

  if (cfg.seedStorage) {
    let seedData: { localStorage?: Record<string, unknown>; sessionStorage?: Record<string, unknown> } | null = null;
    try {
      if (typeof cfg.seedStorage === 'string') {
        seedData = JSON.parse(await readFile(cfg.seedStorage, 'utf8'));
      } else {
        seedData = cfg.seedStorage;
      }
    } catch {
      /* ignore read errors */
    }
    if (seedData) {
      await context.addInitScript((data) => {
        try {
          if (data.localStorage) {
            for (const [k, v] of Object.entries(data.localStorage)) {
              window.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
            }
          }
          if (data.sessionStorage) {
            for (const [k, v] of Object.entries(data.sessionStorage)) {
              window.sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
            }
          }
        } catch {
          /* ignore */
        }
      }, seedData);
    }
  }

  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.resourceType() === 'document' && req.isNavigationRequest()) {
      try {
        if (new URL(req.url()).origin !== cfg.origin) {
          void route.abort('blockedbyclient');
          return;
        }
      } catch {
        /* fall through */
      }
    }
    void route.continue();
  });

  return { context, userAgent };
}

export async function openSession(
  cfg: ResolvedConfig,
  viewport: { width: number; height: number },
): Promise<Session> {
  const browser = await chromium.launch({ headless: cfg.headless });
  const { context, userAgent } = await buildContext(browser, cfg, viewport);
  return { browser, context, userAgent };
}

/**
 * Close the context and the browser.
 *
 * A long crawl bounds its own memory by closing each route's page (see `crawl`), not by
 * recycling this context: measured peak RSS was identical (~371MB over 25 routes) whether
 * the context was replaced per route or kept for the whole run.
 */
export async function closeSession(s: Session): Promise<void> {
  await s.context.close().catch(() => {});
  await s.browser.close().catch(() => {});
}

export async function newPage(s: Session): Promise<Page> {
  return s.context.newPage();
}
