import { describe, it, expect } from 'vitest';
import { openDatabase, saveRun, getDiff, getRunHistory, getFindingById } from '../src/db.js';
import type { CrawlResult } from '../src/types.js';

describe('SQLite run tracking & differential engine', () => {
  it('creates in-memory database and saves a crawl run', () => {
    const db = openDatabase(':memory:');
    const result: CrawlResult = {
      baseUrl: 'http://localhost:3000',
      startedAt: '2026-06-21T00:00:00.000Z',
      finishedAt: '2026-06-21T00:01:00.000Z',
      pages: [
        {
          route: '/',
          template: '/',
          status: 200,
          consoleErrors: [],
          failedRequests: [],
          controlCount: 5,
        },
      ],
      findings: [
        {
          route: '/',
          type: 'low-contrast',
          bucket: 'defect',
          severity: 'high',
          title: 'Low contrast on heading',
          evidence: { selector: 'h1' },
          source: { file: 'src/Header.tsx', line: 12, component: 'Header' },
        },
        {
          route: '/',
          type: 'layout-overlap',
          bucket: 'defect',
          severity: 'high',
          title: 'Overlap on card',
          evidence: { selector: '.card-index', layout: { otherSelector: '.badge' } },
        },
      ],
    };

    const runId = saveRun(db, result);
    expect(runId).toMatch(/^run_/);
    expect(result.runId).toBe(runId);

    const history = getRunHistory(db);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(runId);
    expect(history[0].defects_count).toBe(2);
    expect(history[0].verdict).toBe('has_defects');

    const firstFinding = result.findings[0];
    expect(firstFinding.id).toBeDefined();
    const fetched = getFindingById(db, firstFinding.id!);
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe('Low contrast on heading');
    expect(fetched?.source?.file).toBe('src/Header.tsx');
    expect(fetched?.source?.line).toBe(12);
    expect(fetched?.source?.component).toBe('Header');
  });

  it('computes differential between two runs (fixed, persistent, regressions)', () => {
    const db = openDatabase(':memory:');

    // Run 1: has low-contrast and layout-overlap
    const run1Result: CrawlResult = {
      baseUrl: 'http://localhost:3000',
      startedAt: '2026-06-21T00:00:00.000Z',
      finishedAt: '2026-06-21T00:01:00.000Z',
      pages: [{ route: '/', template: '/', status: 200, consoleErrors: [], failedRequests: [], controlCount: 5 }],
      findings: [
        {
          route: '/',
          type: 'low-contrast',
          bucket: 'defect',
          severity: 'high',
          title: 'Low contrast',
          evidence: { selector: 'p#faint' },
        },
        {
          route: '/',
          type: 'layout-overlap',
          bucket: 'defect',
          severity: 'high',
          title: 'Overlap on card',
          evidence: { selector: '.card-index', layout: { otherSelector: '.badge' } },
        },
      ],
    };
    const run1Id = saveRun(db, run1Result, 'run_1');

    // Run 2: fixed p#faint, kept layout-overlap, introduced clipped-text
    const run2Result: CrawlResult = {
      baseUrl: 'http://localhost:3000',
      startedAt: '2026-06-21T00:02:00.000Z',
      finishedAt: '2026-06-21T00:03:00.000Z',
      pages: [{ route: '/', template: '/', status: 200, consoleErrors: [], failedRequests: [], controlCount: 5 }],
      findings: [
        {
          route: '/',
          type: 'layout-overlap',
          bucket: 'defect',
          severity: 'high',
          title: 'Overlap on card',
          evidence: { selector: '.card-index', layout: { otherSelector: '.badge' } },
        },
        {
          route: '/',
          type: 'clipped-text',
          bucket: 'defect',
          severity: 'high',
          title: 'Clipped text in header',
          evidence: { selector: '.header-title' },
        },
      ],
    };
    const run2Id = saveRun(db, run2Result, 'run_2');

    const diff = getDiff(db, run2Id);
    expect(diff).not.toBeNull();
    expect(diff?.runA).toBe(run1Id);
    expect(diff?.runB).toBe(run2Id);

    // Fixed: p#faint is no longer present
    expect(diff?.fixed).toHaveLength(1);
    expect(diff?.fixed[0].type).toBe('low-contrast');
    expect(diff?.fixed[0].evidence.selector).toBe('p#faint');

    // Persistent: layout-overlap is in both
    expect(diff?.persistent).toHaveLength(1);
    expect(diff?.persistent[0].type).toBe('layout-overlap');
    expect(diff?.persistent[0].evidence.selector).toBe('.card-index');

    // Regressions: clipped-text is new in run 2
    expect(diff?.regressions).toHaveLength(1);
    expect(diff?.regressions[0].type).toBe('clipped-text');
    expect(diff?.regressions[0].evidence.selector).toBe('.header-title');
  });
});
