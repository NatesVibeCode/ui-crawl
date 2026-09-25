import type { APIRequestContext } from 'playwright';

/**
 * Crawl politeness: robots.txt and per-host pacing.
 *
 * Both are no-ops for loopback. A dev server on localhost is not a third party, and
 * pacing it would spend the sweep's whole performance budget for nobody's benefit. The
 * moment `--base-url` points at a real host, both start applying.
 */

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

/** Longest-match Allow/Disallow, the convention every crawler uses. */
export function parseRobots(text: string): RobotsRules {
  const allow: string[] = [];
  const disallow: string[] = [];
  let applies = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      applies = value === '*';
      continue;
    }
    if (!applies) continue;
    if (field === 'allow') allow.push(value);
    else if (field === 'disallow') disallow.push(value);
  }
  return { allow: allow.filter(Boolean), disallow: disallow.filter(Boolean) };
}

function longestPrefix(prefixes: string[], path: string): number {
  let best = -1;
  for (const p of prefixes) if (path.startsWith(p) && p.length > best) best = p.length;
  return best;
}

export class PolitenessGate {
  private robots = new Map<string, RobotsRules>();
  private robotsText = new Map<string, string | null>();
  private lastNav = new Map<string, number>();

  constructor(
    private readonly request: APIRequestContext,
    private readonly minIntervalMs: number,
    private readonly respectRobots: boolean,
    private readonly userAgent?: string,
  ) {}

  /**
   * Fetch and cache raw robots.txt for an origin (null when missing/unreachable).
   * Used by the guidance pack so we do not GET /robots.txt twice.
   */
  async peekRobots(origin: string): Promise<string | null> {
    if (this.robotsText.has(origin)) return this.robotsText.get(origin) ?? null;
    let text: string | null = null;
    try {
      const headers = this.userAgent ? { 'user-agent': this.userAgent } : undefined;
      const res = await this.request.get(`${origin}/robots.txt`, {
        timeout: 10_000,
        failOnStatusCode: false,
        ...(headers ? { headers } : {}),
      });
      if (res.status() === 200) text = await res.text();
    } catch {
      text = null;
    }
    this.robotsText.set(origin, text);
    if (text !== null) this.robots.set(origin, parseRobots(text));
    return text;
  }

  /** False when robots.txt forbids this URL. Fails open: an unreachable robots.txt allows. */
  async allowed(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return true;
    }
    if (!this.respectRobots || isLoopbackHost(parsed.hostname)) return true;

    const origin = parsed.origin;
    if (!this.robots.has(origin)) {
      // Warm via peekRobots (shared UA + cache with the guidance pack).
      await this.peekRobots(origin);
      if (!this.robots.has(origin)) this.robots.set(origin, { allow: [], disallow: [] });
    }
    const rules = this.robots.get(origin) as RobotsRules;
    const path = parsed.pathname || '/';
    const allowLen = longestPrefix(rules.allow, path);
    const denyLen = longestPrefix(rules.disallow, path);
    return denyLen < 0 || allowLen >= denyLen;
  }

  /** Keep at least `minIntervalMs` between navigations to the same origin. */
  async pace(url: string): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (isLoopbackHost(parsed.hostname)) return;
    const origin = parsed.origin;
    const wait = this.minIntervalMs - (Date.now() - (this.lastNav.get(origin) ?? 0));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastNav.set(origin, Date.now());
  }
}
