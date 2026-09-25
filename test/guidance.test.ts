import { describe, it, expect } from 'vitest';
import {
  parseSitemapLocs,
  parseLlmsLinks,
  parseLlmsHeadings,
  seedsFromGuidance,
  guidanceArtifacts,
  type GuidancePack,
} from '../src/guidance.js';

describe('parseSitemapLocs', () => {
  it('parses urlset page URLs', () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/</loc></url>
        <url><loc>https://example.com/campaigns</loc></url>
      </urlset>`;
    const r = parseSitemapLocs(xml);
    expect(r.isIndex).toBe(false);
    expect(r.urls).toEqual(['https://example.com/', 'https://example.com/campaigns']);
    expect(r.childSitemaps).toEqual([]);
  });

  it('parses sitemapindex children', () => {
    const xml = `<sitemapindex>
      <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
    </sitemapindex>`;
    const r = parseSitemapLocs(xml);
    expect(r.isIndex).toBe(true);
    expect(r.urls).toEqual([]);
    expect(r.childSitemaps).toHaveLength(2);
  });

  it('returns empty for garbage', () => {
    expect(parseSitemapLocs('not xml')).toEqual({ urls: [], childSitemaps: [], isIndex: false });
  });
});

describe('parseLlmsLinks / headings', () => {
  it('extracts markdown links and headings, skipping anchors/mailto', () => {
    const md = `# Product Docs
## Getting started
See [Setup](/setup) and [API](https://example.com/api).
[Ignore](#top) and [mail](mailto:x@y.z) and [ext](https://other.com/x).
`;
    expect(parseLlmsHeadings(md)).toEqual(['Product Docs', 'Getting started']);
    expect(parseLlmsLinks(md)).toEqual(['/setup', 'https://example.com/api', 'https://other.com/x']);
  });
});

describe('seedsFromGuidance', () => {
  const origin = 'https://example.com';
  const pack: GuidancePack = {
    origin,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    sitemap: {
      status: 200,
      text: '',
      urls: ['https://example.com/', 'https://example.com/campaigns', 'https://other.com/x', 'https://example.com/campaigns'],
      childSitemaps: [],
    },
    llms: {
      status: 200,
      path: '/llms.txt',
      text: '# Hi\n[Guide](/guide)',
      links: ['/guide', '/campaigns', 'https://cdn.example.com/nope'],
      headings: ['Hi'],
    },
  };

  it('keeps same-origin paths, drops other origins, dedupes', () => {
    expect(seedsFromGuidance(pack, origin)).toEqual(['/', '/campaigns', '/guide']);
  });

  it('returns [] without pack', () => {
    expect(seedsFromGuidance(undefined, origin)).toEqual([]);
  });
});

describe('guidanceArtifacts', () => {
  it('writes raw files plus summary.json', () => {
    const pack: GuidancePack = {
      origin: 'https://example.com',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      robots: { path: '/robots.txt', status: 200, text: 'User-agent: *\nDisallow: /admin\n', rules: { allow: [], disallow: ['/admin'] } },
      llms: { status: 200, path: '/llms.txt', text: '# Title\n[Docs](/docs)', links: ['/docs'], headings: ['Title'] },
    };
    const names = guidanceArtifacts(pack).map((a) => a.name);
    expect(names).toContain('guidance/robots.txt');
    expect(names).toContain('guidance/llms.txt');
    expect(names).toContain('guidance/summary.json');
    const summary = guidanceArtifacts(pack).find((a) => a.name === 'guidance/summary.json')!;
    const parsed = JSON.parse(String(summary.content));
    expect(parsed.robots.disallow).toEqual(['/admin']);
    expect(parsed.llms.excerpt).toContain('# Title');
  });
});
