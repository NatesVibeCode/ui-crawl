import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { crawl } from '../src/index.js';

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

describe.skipIf(!LIVE)('parallel execution engine', () => {
  it('crawls multiple routes and viewports concurrently with deterministic ordering', async () => {
    const outDir = path.join(os.tmpdir(), `ui-crawl-parallel-${process.pid}`);
    const routes = ['/index.html', '/contrast.html', '/accessibility.html', '/page2.html'];
    const viewports = [
      { width: 1280, height: 800, label: 'desktop' },
      { width: 390, height: 844, label: 'mobile' },
    ];

    // Run parallel with concurrency 4
    const parallelResult = await crawl({
      baseUrl,
      routes,
      viewports,
      concurrency: 4,
      skipZoom: true,
      skipInteractionSweep: true,
      guidance: false,
      networkInventory: false,
      outDir,
      headless: true,
    });

    expect(parallelResult.pages).toHaveLength(8);
    // Deterministic order: Desktop index, contrast, accessibility, page2; then Mobile index, contrast, accessibility, page2
    const pageOrder = parallelResult.pages.map((p) => `${p.route}:${p.viewport?.label}`);
    expect(pageOrder).toEqual([
      '/index.html:desktop',
      '/contrast.html:desktop',
      '/accessibility.html:desktop',
      '/page2.html:desktop',
      '/index.html:mobile',
      '/contrast.html:mobile',
      '/accessibility.html:mobile',
      '/page2.html:mobile',
    ]);
  }, 120_000);

  it('resiliently handles a 404 route without crashing other concurrent workers', async () => {
    const outDir = path.join(os.tmpdir(), `ui-crawl-parallel-resilience-${process.pid}`);
    const routes = ['/index.html', '/nonexistent.html', '/contrast.html'];

    const result = await crawl({
      baseUrl,
      routes,
      concurrency: 3,
      skipZoom: true,
      skipInteractionSweep: true,
      guidance: false,
      networkInventory: false,
      outDir,
      headless: true,
    });

    expect(result.pages).toHaveLength(3);
    const nonExistent = result.pages.find((p) => p.route === '/nonexistent.html');
    expect(nonExistent).toBeDefined();
    expect(nonExistent?.status).toBe(404);

    const indexPage = result.pages.find((p) => p.route === '/index.html');
    expect(indexPage?.status).toBe(200);
  }, 120_000);
});
