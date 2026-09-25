import { describe, it, expect } from 'vitest';
import { planVisits, planSeedList } from '../src/discover.js';
import { seedsFromGuidance, type GuidancePack } from '../src/guidance.js';

describe('planVisits', () => {
  it('dedupes by route template and is bounded by maxPages', () => {
    const graph: Record<string, string[]> = {
      '/': ['/guests/1', '/guests/2', '/campaigns'],
      '/guests/1': ['/'],
      '/campaigns': ['/campaigns/9'],
    };
    const visited = planVisits(graph, ['/'], 25);
    // /guests/2 collapses to /guests/[id] (already visited via /guests/1) -> skipped.
    expect(visited).toEqual(['/', '/guests/1', '/campaigns', '/campaigns/9']);
  });

  it('respects maxPages', () => {
    const graph: Record<string, string[]> = { '/': ['/a', '/b', '/c'] };
    expect(planVisits(graph, ['/'], 2)).toEqual(['/', '/a']);
  });
});

describe('planSeedList', () => {
  it('normalizes leading slash, dedupes by template, bounds by maxPages', () => {
    expect(planSeedList(['campaigns', '/campaigns', '/guests/1', '/guests/2'], 25)).toEqual([
      '/campaigns',
      '/guests/1',
    ]);
  });

  it('trims blanks and normalizes pasted absolute urls', () => {
    expect(
      planSeedList(['   ', ' https://example.com/campaigns?tab=moments ', 'guests'], 25),
    ).toEqual([
      '/campaigns?tab=moments',
      '/guests',
    ]);
  });
});

describe('guidance seeds feed discovery', () => {
  it('sitemap + llms paths become BFS seeds (same-origin only)', () => {
    const pack: GuidancePack = {
      origin: 'https://example.com',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      sitemap: {
        status: 200,
        text: '',
        urls: ['https://example.com/docs', 'https://evil.com/x'],
        childSitemaps: [],
      },
      llms: {
        status: 200,
        path: '/llms.txt',
        text: '[API](/api)',
        links: ['/api', '/docs'],
        headings: [],
      },
    };
    const seeds = seedsFromGuidance(pack, 'https://example.com');
    expect(seeds).toEqual(['/docs', '/api']);
    // BFS graph from '/' with guidance seeds prepended after '/':
    const graph: Record<string, string[]> = { '/': [] };
    const order = planVisits(graph, ['/', ...seeds], 25);
    expect(order).toEqual(['/', '/docs', '/api']);
  });
});
