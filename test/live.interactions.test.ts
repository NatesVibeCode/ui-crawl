import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { crawl } from '../src/index.js';

// Opt-in: needs a real chromium (`npx playwright install chromium`). Run with `npm run test:live`.
const LIVE = process.env.UI_CRAWL_LIVE === '1';
const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/static-site');

let server: Server | undefined;
let baseUrl = '';

beforeAll(async () => {
  if (!LIVE) return;
  server = createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    try {
      const buf = await readFile(path.join(SITE, rel));
      res.setHeader('content-type', rel.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

describe.skipIf(!LIVE)('live interaction sweep', () => {
  it('separates broken controls from working ones', async () => {
    const outDir = path.join(os.tmpdir(), `ui-crawl-test-${process.pid}`);
    const result = await crawl({
      baseUrl,
      routes: ['/index.html'],
      skipZoom: true,
      outDir,
      interactionTimeoutMs: 500,
      headless: true,
    });

    const types = new Set(result.findings.map((f) => f.type));
    expect(types.has('button-threw')).toBe(true); // #throws
    expect(types.has('broken-link')).toBe(true); // #deadlink
    expect(types.has('maybe-contextual-button')).toBe(true); // #bare
    expect(types.has('redundant-control')).toBe(true); // #acct1 + #acct2

    const broken = result.findings
      .filter((f) => f.type === 'broken-link' || f.type === 'button-threw')
      .map((f) => f.evidence.accessibleName);
    expect(broken).not.toContain('Add item'); // works
    expect(broken).not.toContain('Load data'); // net
    expect(broken).not.toContain('Real link'); // reallink
  }, 120_000);

  it('quotes finding text against a page text index that is stable across crawls', async () => {
    const outDir = path.join(os.tmpdir(), `ui-crawl-contrast-${process.pid}`);
    const run = () =>
      crawl({ baseUrl, routes: ['/contrast.html'], skipZoom: true, skipInteractionSweep: true, outDir, headless: true });

    const first = await run();
    const second = await run();

    const contrast = first.findings.find((f) => f.type === 'low-contrast');
    expect(contrast, 'fixture should produce a low-contrast finding').toBeDefined();
    const c = contrast!.evidence.contrast!;
    const page = first.pages[0];

    // The offsets must describe the sample, and must land inside the page text they index.
    expect(typeof c.textStart).toBe('number');
    expect(c.textEnd! - c.textStart!).toBe(c.textSample!.length);
    expect(c.textEnd!).toBeLessThanOrEqual(page.textLength!);
    expect(c.textStart!).toBeGreaterThanOrEqual(0);

    // Same page, same digest and same offsets — the index is deterministic, not incidental.
    const again = second.findings.find((f) => f.type === 'low-contrast')!;
    expect(page.textDigest).toBe(second.pages[0].textDigest);
    expect(again.evidence.contrast!.textStart).toBe(c.textStart);
    expect(again.evidence.contrast!.textEnd).toBe(c.textEnd);
  }, 120_000);
});
