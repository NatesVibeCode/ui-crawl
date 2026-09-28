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

describe('computeFingerprint stability', () => {
  it('identifies a control by content, not by its position in the page', async () => {
    const { computeFingerprint } = await import('../src/db.js');
    const before = computeFingerprint({
      route: '/index.html',
      type: 'broken-link',
      selector: 'a:nth(4) "Dead link"',
      evidence: { accessibleName: 'Dead link', url: 'http://x/gone?x=1' },
    });
    // One insertion above renumbers every control below it; the identity must not move.
    const after = computeFingerprint({
      route: '/index.html',
      type: 'broken-link',
      selector: 'a:nth(5) "Dead link"',
      evidence: { accessibleName: 'Dead link', url: 'http://x/gone?x=1' },
    });
    expect(after).toBe(before);
  });

  it('still distinguishes same-named controls with different destinations', async () => {
    const { computeFingerprint } = await import('../src/db.js');
    const a = computeFingerprint({
      route: '/', type: 'dead-button', selector: 'button:nth(1) "Go"',
      evidence: { accessibleName: 'Go', url: 'http://x/a' },
    });
    const b = computeFingerprint({
      route: '/', type: 'dead-button', selector: 'button:nth(2) "Go"',
      evidence: { accessibleName: 'Go', url: 'http://x/b' },
    });
    expect(a).not.toBe(b);
  });

  it('keeps selector identity for stable (non-positional) selectors', async () => {
    const { computeFingerprint } = await import('../src/db.js');
    expect(
      computeFingerprint({ route: '/', type: 'low-contrast', selector: 'p#faint' }),
    ).toBe('/::low-contrast::p#faint');
  });

  it('falls back to the selector when a positional finding names nothing', async () => {
    const { computeFingerprint } = await import('../src/db.js');
    expect(
      computeFingerprint({ route: '/', type: 'missing-image-alt', selector: 'img:nth(0)' }),
    ).toBe('/::missing-image-alt::img:nth(0)');
  });
});

describe('computeFingerprint loopback normalization', () => {
  it('ignores ephemeral static-server ports on loopback', async () => {
    const { computeFingerprint } = await import('../src/db.js');
    const a = computeFingerprint({
      route: '/index.html', type: 'broken-link', selector: 'a:nth(4) "Dead link"',
      evidence: { accessibleName: 'Dead link', url: 'http://127.0.0.1:51234/gone?x=1' },
    });
    const b = computeFingerprint({
      route: '/index.html', type: 'broken-link', selector: 'a:nth(5) "Dead link"',
      evidence: { accessibleName: 'Dead link', url: 'http://127.0.0.1:52341/gone?x=1' },
    });
    expect(b).toBe(a);
  });

  it('keeps real hosts exact, port included', async () => {
    const { computeFingerprint } = await import('../src/db.js');
    const a = computeFingerprint({
      route: '/', type: 'broken-link', selector: 'a:nth(0) "x"',
      evidence: { accessibleName: 'x', url: 'https://cdn.example.com:8443/a' },
    });
    const b = computeFingerprint({
      route: '/', type: 'broken-link', selector: 'a:nth(0) "x"',
      evidence: { accessibleName: 'x', url: 'https://cdn.example.com:9443/a' },
    });
    expect(a).not.toBe(b);
  });
});

describe('getDiff unknown runs', () => {
  it('returns null for a run id that names nothing, instead of reporting a clean sweep', async () => {
    const { openDatabase, saveRun, getDiff } = await import('../src/db.js');
    const db = openDatabase(':memory:');
    const runId = saveRun(db, {
      baseUrl: 'http://localhost:3000',
      startedAt: '2026-06-21T00:00:00.000Z',
      finishedAt: '2026-06-21T00:01:00.000Z',
      pages: [{ route: '/', template: '/', status: 200, consoleErrors: [], failedRequests: [], controlCount: 1 }],
      findings: [
        { route: '/', type: 'dead-button', bucket: 'defect', severity: 'high', title: 'x', evidence: {} },
      ],
    });
    expect(getDiff(db, 'no-such-run')).toBeNull();
    expect(getDiff(db, runId, 'no-such-baseline')).toBeNull();
    // A lone run has nothing to compare against — also null, not an empty diff.
    expect(getDiff(db, runId)).toBeNull();
  });
});

describe('schema migration', () => {
  it('adds the artifact/tag columns to a pre-existing database without losing data', async () => {
    const { createRequire } = await import('node:module');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openDatabase, getRunHistory, getRunResult } = await import('../src/db.js');

    const dir = mkdtempSync(join(tmpdir(), 'uic-mig-'));
    const file = join(dir, 'old.db');
    try {
      // Exactly the pre-migration schema, with one run and one finding already in it.
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require('node:sqlite');
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
          base_url TEXT NOT NULL, routes_json TEXT NOT NULL, verdict TEXT NOT NULL,
          defects_count INTEGER NOT NULL, taste_count INTEGER NOT NULL, pages_count INTEGER NOT NULL,
          summary_json TEXT NOT NULL);
        CREATE TABLE findings (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, route TEXT NOT NULL,
          type TEXT NOT NULL, bucket TEXT NOT NULL, severity TEXT NOT NULL, selector TEXT,
          title TEXT NOT NULL, remediation TEXT, fingerprint TEXT NOT NULL, source_file TEXT,
          source_line INTEGER, source_component TEXT, evidence_json TEXT NOT NULL);
      `);
      old.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        'run_old', '2026-01-01', '2026-01-01', 'http://x', '["/"]', 'has_defects', 1, 0, 1, '{}');
      old.prepare('INSERT INTO findings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        'f1', 'run_old', '/', 'dead-button', 'defect', 'high', 'button#x', 'Dead', null,
        '/::dead-button::button#x', null, null, null, '{}');
      old.close();

      // Opening with the new code must add the columns and keep the old rows.
      const db = openDatabase(file);
      const runCols = (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((r) => r.name);
      const findCols = (db.prepare('PRAGMA table_info(findings)').all() as Array<{ name: string }>).map((r) => r.name);
      expect(runCols).toContain('pages_json');
      expect(findCols).toContain('help_url');
      expect(findCols).toContain('tags_json');
      expect(getRunHistory(db)).toHaveLength(1);
      expect(getRunResult(db, 'run_old')?.findings).toHaveLength(1);

      // Idempotent: opening again must not throw or duplicate anything.
      db.close();
      const again = openDatabase(file);
      expect(getRunHistory(again)).toHaveLength(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
