import { describe, it, expect } from 'vitest';
import { planVisits, planSeedList } from '../src/discover.js';

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
