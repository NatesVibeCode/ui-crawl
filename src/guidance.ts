import type { APIRequestContext } from 'playwright';
import { parseRobots, type RobotsRules } from './policy.js';
import type { ReportArtifact } from './sink.js';

/**
 * Site guidance pack: robots.txt, sitemap.xml, and llms.txt fetched once at crawl
 * start. Read-only GETs; every source fails soft (missing file is normal).
 *
 * Loopback targets still get guidance (dev servers often ship llms.txt); robots
 * *gating* stays loopback-exempt inside PolitenessGate.
 */

export interface GuidanceSource {
  path: string;
  status: number;
  text: string;
}

export interface SitemapInfo {
  status: number;
  text: string;
  /** Page URLs from urlset (absolute). Empty for a pure sitemap index. */
  urls: string[];
  /** Child sitemap locations discovered from a sitemapindex. */
  childSitemaps: string[];
}

export interface LlmsInfo {
  status: number;
  /** Which path answered: /llms.txt or /llms-full.txt. */
  path: string;
  text: string;
  /** Same-origin markdown links (hrefs) from the document. */
  links: string[];
  /** `# heading` lines (title + sections). */
  headings: string[];
}

export interface GuidancePack {
  origin: string;
  fetchedAt: string;
  robots?: GuidanceSource & { rules: RobotsRules };
  sitemap?: SitemapInfo;
  llms?: LlmsInfo;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CHILD_SITEMAPS = 5;
const MAX_SITEMAP_BYTES = 512 * 1024;
const MAX_LLMS_BYTES = 256 * 1024;

/** Pure: pull every `<loc>` value from sitemap/urlset XML. */
export function parseSitemapLocs(xml: string): { urls: string[]; childSitemaps: string[]; isIndex: boolean } {
  const isIndex = /<\s*sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1].trim();
    if (raw) locs.push(raw);
  }
  if (isIndex) return { urls: [], childSitemaps: locs, isIndex: true };
  return { urls: locs, childSitemaps: [], isIndex: false };
}

/** Pure: markdown links (`[text](href)`) and same-origin-ish path hrefs. */
export function parseLlmsLinks(md: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(md)) !== null) {
    const href = m[1].trim();
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('mailto:')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

/** Pure: markdown headings (`# …`) as guidance section titles. */
export function parseLlmsHeadings(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (m) out.push(m[2].trim());
  }
  return out;
}

/**
 * Pure: map guidance URLs to same-origin seed routes (pathname+search).
 * Absolute other-origin URLs and non-http schemes are dropped; hash stripped.
 */
export function seedsFromGuidance(pack: GuidancePack | undefined, origin: string): string[] {
  if (!pack) return [];
  const candidates: string[] = [];
  if (pack.sitemap) candidates.push(...pack.sitemap.urls);
  if (pack.llms) candidates.push(...pack.llms.links);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    let path: string | null = null;
    try {
      const u = new URL(raw, `${origin}/`);
      if (u.origin !== origin) continue;
      path = `${u.pathname}${u.search}` || '/';
    } catch {
      if (raw.startsWith('/')) path = raw.split('#')[0];
      else continue;
    }
    if (!path) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

async function getText(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
  maxBytes: number,
): Promise<{ status: number; text: string } | null> {
  try {
    const res = await request.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      failOnStatusCode: false,
      headers,
    });
    const status = res.status();
    if (status !== 200) return { status, text: '' };
    const body = await res.body();
    const text = body.subarray(0, maxBytes).toString('utf8');
    return { status, text };
  } catch {
    return null;
  }
}

export interface FetchGuidanceOptions {
  /** Honest UA so server logs match the browser session. */
  userAgent?: string;
  /**
   * Optional pre-warmed robots fetch (PolitenessGate). When provided and it
   * returns text, we do not re-GET /robots.txt.
   */
  robotsText?: string | null;
}

/** Fetch robots + sitemap (+ child sitemaps) + llms.txt. Never throws. */
export async function fetchGuidance(
  request: APIRequestContext,
  origin: string,
  opts: FetchGuidanceOptions = {},
): Promise<GuidancePack> {
  const headers: Record<string, string> = {};
  if (opts.userAgent) headers['user-agent'] = opts.userAgent;

  const pack: GuidancePack = { origin, fetchedAt: new Date().toISOString() };

  // robots.txt — prefer the gate's cached text when supplied.
  if (typeof opts.robotsText === 'string') {
    pack.robots = {
      path: '/robots.txt',
      status: 200,
      text: opts.robotsText,
      rules: parseRobots(opts.robotsText),
    };
  } else {
    const robots = await getText(request, `${origin}/robots.txt`, headers, MAX_SITEMAP_BYTES);
    if (robots && robots.status === 200 && robots.text) {
      pack.robots = { path: '/robots.txt', status: 200, text: robots.text, rules: parseRobots(robots.text) };
    }
  }

  // sitemap.xml — follow up to 5 same-origin child sitemaps on sitemapindex.
  const sm = await getText(request, `${origin}/sitemap.xml`, headers, MAX_SITEMAP_BYTES);
  if (sm && sm.status === 200 && sm.text) {
    const parsed = parseSitemapLocs(sm.text);
    const urls: string[] = [...parsed.urls];
    const childSitemaps = parsed.childSitemaps.slice(0, MAX_CHILD_SITEMAPS);
    for (const childUrl of childSitemaps) {
      try {
        const childOrigin = new URL(childUrl).origin;
        if (childOrigin !== origin) continue;
      } catch {
        continue;
      }
      const child = await getText(request, childUrl, headers, MAX_SITEMAP_BYTES);
      if (child && child.status === 200 && child.text) {
        const childParsed = parseSitemapLocs(child.text);
        urls.push(...childParsed.urls);
      }
    }
    pack.sitemap = {
      status: 200,
      text: sm.text,
      urls: dedupeStrings(urls),
      childSitemaps: parsed.childSitemaps,
    };
  }

  // llms.txt, then llms-full.txt fallback.
  const llms = await getText(request, `${origin}/llms.txt`, headers, MAX_LLMS_BYTES);
  if (llms && llms.status === 200 && llms.text) {
    pack.llms = {
      status: 200,
      path: '/llms.txt',
      text: llms.text,
      links: parseLlmsLinks(llms.text),
      headings: parseLlmsHeadings(llms.text),
    };
  } else {
    const full = await getText(request, `${origin}/llms-full.txt`, headers, MAX_LLMS_BYTES);
    if (full && full.status === 200 && full.text) {
      pack.llms = {
        status: 200,
        path: '/llms-full.txt',
        text: full.text,
        links: parseLlmsLinks(full.text),
        headings: parseLlmsHeadings(full.text),
      };
    }
  }

  return pack;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Raw guidance files + a typed summary under guidance/. */
export function guidanceArtifacts(pack: GuidancePack): ReportArtifact[] {
  const artifacts: ReportArtifact[] = [];
  if (pack.robots?.text) {
    artifacts.push({ name: 'guidance/robots.txt', content: pack.robots.text });
  }
  if (pack.sitemap?.text) {
    artifacts.push({ name: 'guidance/sitemap.xml', content: pack.sitemap.text });
  }
  if (pack.llms?.text) {
    const fileName = pack.llms.path === '/llms-full.txt' ? 'llms-full.txt' : 'llms.txt';
    artifacts.push({ name: `guidance/${fileName}`, content: pack.llms.text });
  }

  const summary = {
    origin: pack.origin,
    fetchedAt: pack.fetchedAt,
    robots: pack.robots
      ? {
          status: pack.robots.status,
          allow: pack.robots.rules.allow,
          disallow: pack.robots.rules.disallow,
        }
      : null,
    sitemap: pack.sitemap
      ? {
          status: pack.sitemap.status,
          urlCount: pack.sitemap.urls.length,
          childSitemapCount: pack.sitemap.childSitemaps.length,
          urls: pack.sitemap.urls.slice(0, 200),
        }
      : null,
    llms: pack.llms
      ? {
          status: pack.llms.status,
          path: pack.llms.path,
          headings: pack.llms.headings.slice(0, 40),
          links: pack.llms.links.slice(0, 100),
          excerpt: pack.llms.text.slice(0, 500),
        }
      : null,
  };
  artifacts.push({ name: 'guidance/summary.json', content: JSON.stringify(summary, null, 2) });
  return artifacts;
}
