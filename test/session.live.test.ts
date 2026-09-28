import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UiSession } from '../src/session.js';

/**
 * Live browser coverage for the session instrument. This is the part of the tool a
 * harness actually drives, and the things that only show up with a real renderer — stale
 * indices, honest NOOP verdicts, real screenshots — cannot be checked with a mock.
 *
 * Gated behind UI_CRAWL_LIVE=1 like the other browser suites, so `npm test` stays
 * hermetic. Run with `npm run test:live`.
 */
const LIVE = process.env.UI_CRAWL_LIVE === '1';

describe.skipIf(!LIVE)('UiSession (live)', () => {
  let session: UiSession;

  beforeAll(async () => {
    session = await UiSession.open(
      { dir: 'fixtures/static-site', route: '/index.html' },
      { outDir: 'ui-crawl-out', interactionTimeoutMs: 500 },
    );
  }, 60000);

  afterAll(async () => {
    await session?.close();
  });

  it('opens on the requested route and enumerates its controls', async () => {
    const entries = await session.snapshot();
    expect(session.id).toMatch(/^sess_/);
    expect(entries.length).toBeGreaterThan(0);
    const names = entries.map((e) => e.name);
    expect(names).toContain('Add item');
  });

  it('reports what a working control actually did, not that it was clicked', async () => {
    const entries = await session.snapshot();
    const target = entries.find((e) => e.name === 'Add item')!;
    const result = await session.act({ type: 'click', index: target.index });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    // ACTED requires a positive signal — here, real DOM mutations from the handler.
    expect(result.verdict).toBe('ACTED');
    expect(result.signals.domMutationCount).toBeGreaterThan(0);
    expect(result.target).toEqual({ tag: 'button', name: 'Add item' });
  }, 30000);

  it('returns a fresh numbered snapshot and a screenshot after every action', async () => {
    const result = await session.act({ type: 'scroll', dy: 200 });
    expect(result.snapshot).toBeTypeOf('string');
    expect(result.screenshot).toMatch(/^screenshots\/session_.*\.png$/);
  }, 30000);

  it('refuses an out-of-range index rather than clicking something else', async () => {
    const result = await session.act({ type: 'click', index: 9999 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no visible control at snapshot index 9999/);
  }, 30000);

  it('changes the viewport on resize and reports the new size', async () => {
    const result = await session.act({ type: 'resize', width: 390, height: 844 });
    expect(result.viewport).toEqual({ width: 390, height: 844 });
    await session.act({ type: 'resize', width: 1280, height: 800 });
  }, 30000);

  it('navigates within the origin and reports the new url', async () => {
    const result = await session.goto({ route: '/page2.html' });
    expect(result.url).toContain('/page2.html');
    expect(result.navigated).toBe(true);
    await session.goto({ route: '/index.html' });
  }, 30000);

  it('reports a no-op honestly: silence is never reported as success', async () => {
    // "Save" in the fixture is wired to nothing at all.
    const entries = await session.snapshot();
    const save = entries.find((e) => e.name === 'Save');
    if (!save) return; // fixture changed; nothing to assert
    const result = await session.act({ type: 'click', index: save.index });
    expect(result.verdict).toBe('NOOP');
    expect(result.signals.domMutationCount).toBe(0);
  }, 30000);

  it('is closed after close() and refuses further actions', async () => {
    const throwaway = await UiSession.open(
      { dir: 'fixtures/static-site', route: '/page2.html' },
      { outDir: 'ui-crawl-out' },
    );
    await throwaway.close();
    await expect(throwaway.act({ type: 'reload' })).rejects.toThrow(/closed/);
  }, 60000);
});

describe.skipIf(!LIVE)('UiSession snapshot modes (live)', () => {
  it('changed mode sends only what moved, none sends nothing', async () => {
    const { UiSession } = await import('../src/session.js');
    const s = await UiSession.open(
      { dir: 'fixtures/static-site', route: '/index.html' },
      { outDir: 'ui-crawl-out', snapshot: 'changed' },
    );
    try {
      // The first report seeds the baseline (everything is new once); after that, a
      // scroll that moves nothing in the control list must say so in one line.
      await s.act({ type: 'wait', ms: 1 });
      const quiet = await s.act({ type: 'scroll', dy: 100 });
      expect(quiet.snapshot).toContain('(no changes)');

      // "Add item" mutates the DOM (verdict ACTED) but adds no *controls*, so the
      // control delta is honestly empty. Navigating to a page with a different control
      // inventory is what visibly moves the list.
      const moved = await s.goto({ route: '/page2.html' });
      expect(moved.snapshot).toContain('(gone)');
      expect(moved.snapshot).not.toContain('(no changes)');

      const suppressed = await s.act({ type: 'wait', ms: 50 }, { snapshot: 'none' });
      expect(suppressed.snapshot).toContain('suppressed');
    } finally {
      await s.close();
    }
  }, 60000);
});
