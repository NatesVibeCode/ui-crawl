import type { Page } from 'playwright';
import type { ResolvedConfig } from './config.js';
import type { GuidancePack } from './guidance.js';
import { seedsFromGuidance } from './guidance.js';
import { toRouteTemplate } from './routeTemplate.js';

/**
 * Pure BFS over a known link graph, deduping by route TEMPLATE and bounded by maxPages.
 * Extracted so dedupe/bounding are unit-testable with no browser.
 */
export function planVisits(graph: Record<string, string[]>, seeds: string[], maxPages: number): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue = [...seeds];
  while (queue.length && order.length < maxPages) {
    const route = queue.shift() as string;
    const tmpl = toRouteTemplate(route);
    if (visited.has(tmpl)) continue;
    visited.add(tmpl);
    order.push(route);
    for (const child of graph[route] ?? []) {
      if (!visited.has(toRouteTemplate(child))) queue.push(child);
    }
  }
  return order;
}

/** Resolve an explicit seed list: normalize, dedupe by template, bound by maxPages. */
export function planSeedList(routes: string[], maxPages: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of routes) {
    const route = normalizeSeedRoute(r);
    if (!route) continue;
    const tmpl = toRouteTemplate(route);
    if (seen.has(tmpl)) continue;
    seen.add(tmpl);
    out.push(route);
    if (out.length >= maxPages) break;
  }
  return out;
}

function normalizeSeedRoute(route: string): string | null {
  const trimmed = route.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const normalized = `${url.pathname}${url.search}${url.hash}`;
    return normalized || '/';
  } catch {
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }
}

/**
 * Live discovery: guidance seeds (sitemap/llms) first, then BFS over same-origin
 * links from '/', bounded + template-deduped. After each load, a deterministic
 * hover-expand pass opens menus/disclosures so links that only exist after
 * interaction still enter the queue.
 */
export async function discoverRoutes(
  page: Page,
  cfg: ResolvedConfig,
  guidance?: GuidancePack,
): Promise<string[]> {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = ['/'];
  for (const seed of seedsFromGuidance(guidance, cfg.origin)) {
    if (seed !== '/') queue.push(seed);
  }

  const collectHrefs = async (): Promise<string[]> =>
    page.$$eval('a[href]', (els) =>
      els
        .map((e) => {
          try {
            return new URL(e.getAttribute('href') || '', document.baseURI).href;
          } catch {
            return '';
          }
        })
        .filter(Boolean),
    );

  const EXPAND_SELECTOR =
    '[aria-haspopup], [aria-expanded="false"], nav button, header button, nav [role="button"], header [role="button"], [role="menuitem"]';
  const EXPAND_CAP = 12;

  while (queue.length && order.length < cfg.maxPages) {
    const route = queue.shift() as string;
    const tmpl = toRouteTemplate(route);
    if (visited.has(tmpl)) continue;
    visited.add(tmpl);
    order.push(route);

    try {
      await page.goto(cfg.baseUrl + route, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
      await page.waitForTimeout(150);
      let hrefs = await collectHrefs();

      // Deterministic expand: hover likely disclosure controls, re-collect, no model.
      try {
        const expandables = await page.$$(EXPAND_SELECTOR);
        const limit = Math.min(expandables.length, EXPAND_CAP);
        for (let i = 0; i < limit; i++) {
          try {
            await expandables[i].hover({ timeout: 400 });
            await page.waitForTimeout(60);
            hrefs = hrefs.concat(await collectHrefs());
          } catch {
            /* not hoverable — keep going */
          }
        }
      } catch {
        /* expand pass is best-effort */
      }

      for (const href of hrefs) {
        try {
          const u = new URL(href);
          if (u.origin !== cfg.origin) continue;
          if (!visited.has(toRouteTemplate(u.pathname))) queue.push(u.pathname);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* unreachable route — keep it recorded as a page (load error captured later) */
    }
  }
  return order;
}
