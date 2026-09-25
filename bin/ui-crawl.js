#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(__dirname, '../dist/index.js');

let mod;
if (existsSync(distEntry)) {
  mod = await import('../dist/index.js');
} else {
  try {
    mod = await import('../src/index.js');
  } catch (err) {
    console.error(
      JSON.stringify({
        error: 'ui-crawl: compiled files not found in dist/. Run "npm run build" first.',
      }),
    );
    process.exit(1);
  }
}

const {
  crawl,
  buildAgentPayload,
  buildFindingsJson,
  startMcpServer,
  startUiServer,
  snapshotUrl,
  formatSnapshot,
  serveStatic,
  discoverHtmlRoutes,
  openDatabase,
  getDiff,
  getRunHistory,
} = mod;

function parseFlags(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const body = a.slice(2);
    if (body.includes('=')) {
      const [k, v] = body.split(/=(.*)/s);
      opts[k] = v;
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      opts[body] = next;
      i++;
    } else {
      opts[body] = true;
    }
  }
  return { opts, positional };
}

async function main() {
  const { opts, positional } = parseFlags(process.argv.slice(2));

  // MCP Mode
  if (opts.mcp) {
    await startMcpServer();
    return;
  }

  // UI Server / Dashboard Mode
  if (opts.ui) {
    const port = typeof opts.ui === 'string' || typeof opts.ui === 'number' ? Number(opts.ui) : 49152;
    const dbPath = opts.db ? String(opts.db) : '.ui-crawl.db';
    const server = await startUiServer({ port, dbPath });
    process.stderr.write(`[ui-crawl] UI console running at ${server.url}\n`);
    await new Promise((resolve) => {
      process.on('SIGINT', () => {
        server.close().then(resolve);
      });
      process.on('SIGTERM', () => {
        server.close().then(resolve);
      });
    });
    return;
  }

  // History Query Mode (standalone)
  if (opts.history) {
    const dbPath = opts.db ? String(opts.db) : '.ui-crawl.db';
    const db = openDatabase(dbPath);
    const limit = opts.limit ? Number(opts.limit) : 10;
    const history = getRunHistory(db, limit);
    process.stdout.write(JSON.stringify(history, null, 2) + '\n');
    return;
  }

  // Standalone Diff Query Mode
  if (opts.diff && !opts['base-url'] && !opts.dir && !opts.file && !opts.config) {
    const dbPath = opts.db ? String(opts.db) : '.ui-crawl.db';
    const db = openDatabase(dbPath);
    const runB = typeof opts.diff === 'string' ? opts.diff : undefined;
    const diffRes = getDiff(db, runB ?? getRunHistory(db, 1)[0]?.id ?? '');
    process.stdout.write(JSON.stringify(diffRes, null, 2) + '\n');
    return;
  }

  // Screenshot Mode
  if (opts.shot) {
    const outPath = String(opts.shot);
    let staticServer;
    const staticTarget = opts.dir ? String(opts.dir) : opts.file ? String(opts.file) : undefined;
    let targetUrl = (opts.url || opts['base-url'] || positional[0])
      ? String(opts.url || opts['base-url'] || positional[0])
      : undefined;

    if (staticTarget) {
      staticServer = await serveStatic(staticTarget);
      targetUrl = staticServer.url;
    }

    if (!targetUrl) {
      console.error(JSON.stringify({ error: '--shot requires a target URL, positional URL, --dir, or --file' }));
      process.exit(2);
    }

    try {
      const { chromium, webkit, firefox } = await import('playwright');
      const browserName = opts.browser === 'webkit' ? 'webkit' : opts.browser === 'firefox' ? 'firefox' : 'chromium';
      const launcher = browserName === 'webkit' ? webkit : browserName === 'firefox' ? firefox : chromium;
      const browser = await launcher.launch({ headless: !opts.headed });
      const width = opts.width ? Number(opts.width) : 1280;
      const height = opts.height ? Number(opts.height) : 800;
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (opts.wait) await page.waitForTimeout(Number(opts.wait));
      else await page.waitForTimeout(500);

      if (opts.selector) {
        const el = page.locator(String(opts.selector)).first();
        await el.screenshot({ path: outPath });
      } else {
        await page.screenshot({ path: outPath, fullPage: !!opts['full-page'] });
      }
      await browser.close();
      process.stdout.write(JSON.stringify({ shot: outPath, url: targetUrl, width, height, browser: browserName, selector: opts.selector }) + '\n');
      return;
    } finally {
      if (staticServer) await staticServer.close();
    }
  }

  // Snapshot Mode
  if (opts.snapshot) {
    const targetUrl = (opts.url || opts['base-url'] || positional[0])
      ? String(opts.url || opts['base-url'] || positional[0])
      : undefined;
    const dir = opts.dir ? String(opts.dir) : undefined;
    const file = opts.file ? String(opts.file) : undefined;
    const cap = opts.cap ? Number(opts.cap) : undefined;

    if (!targetUrl && !dir && !file) {
      console.error(
        JSON.stringify({
          error: 'Snapshot requires --url <url>, --base-url <url>, --dir <path>, or --file <path>',
        }),
      );
      process.exit(2);
    }

    try {
      const entries = await snapshotUrl({ url: targetUrl, dir, file, cap });
      if (opts.json) {
        process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
      } else {
        process.stdout.write(formatSnapshot(entries, cap) + '\n');
      }
      return;
    } catch (err) {
      console.error(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exit(1);
    }
  }

  // Audit Crawl Mode
  let config = {};
  if (opts.config) config = JSON.parse(await readFile(String(opts.config), 'utf8'));
  if (opts['base-url']) config.baseUrl = String(opts['base-url']);
  if (!config.baseUrl && positional[0] && (positional[0].startsWith('http://') || positional[0].startsWith('https://'))) {
    config.baseUrl = positional[0];
  }
  if (opts.out) config.outDir = String(opts.out);
  if (opts.routes) config.routes = String(opts.routes).split(',').map((s) => s.trim()).filter(Boolean);
  if (opts['max-pages']) config.maxPages = Number(opts['max-pages']);
  if (opts['max-probes']) config.maxProbesPerPage = Number(opts['max-probes']);
  if (opts['nav-retries']) config.navRetries = Number(opts['nav-retries']);
  if (opts['host-delay']) config.perHostDelayMs = Number(opts['host-delay']);
  if (opts['no-robots']) config.respectRobots = false;
  if (opts['seed-storage']) config.seedStorage = String(opts['seed-storage']);
  if (opts['no-zoom']) config.skipZoom = true;
  if (opts['no-clicks']) config.skipInteractionSweep = true;
  if (opts['no-contrast']) config.skipContrast = true;
  if (opts['no-affordance']) config.skipAffordance = true;
  if (opts['no-spacing']) config.skipSpacing = true;
  if (opts['no-layout']) config.skipLayout = true;
  if (opts.observe) config.observeControls = true;
  if (opts['no-guidance']) config.guidance = false;
  if (opts['no-network']) config.networkInventory = false;
  if (opts['user-agent']) config.userAgent = String(opts['user-agent']);
  if (opts.headed) config.headless = false;
  if (opts.db) config.dbPath = opts.db === 'false' || opts.db === 'null' ? null : String(opts.db);
  if (opts.diff) config.diff = typeof opts.diff === 'string' ? opts.diff : true;
  if (opts['theme-sweep'] || opts['dark-mode']) config.themeSweep = true;
  if (opts.crops) config.captureCrops = true;
  if (opts.browser) config.browser = String(opts.browser);
  if (opts.quick) config.quick = true;

  // Differential Re-run Defects
  if (opts['rerun-defects']) {
    const dbPath = opts.db ? String(opts.db) : '.ui-crawl.db';
    if (existsSync(dbPath)) {
      try {
        const db = openDatabase(dbPath);
        const runs = getRunHistory(db, 1);
        if (runs.length > 0) {
          const stmt = db.prepare("SELECT DISTINCT route FROM findings WHERE run_id = ? AND bucket = 'defect'");
          const rows = stmt.all(runs[0].id);
          const failedRoutes = rows.map((r) => r.route);
          if (failedRoutes.length > 0) {
            config.routes = failedRoutes;
            process.stderr.write(`[ui-crawl] Re-auditing ${failedRoutes.length} failed route(s) from run ${runs[0].id}: ${failedRoutes.join(', ')}\n`);
          } else {
            process.stderr.write(`[ui-crawl] Previous run ${runs[0].id} had 0 defects. Auditing all routes.\n`);
          }
        }
      } catch {
        /* proceed with default routes */
      }
    }
  }

  let staticServer;
  const staticTarget = opts.dir ? String(opts.dir) : opts.file ? String(opts.file) : undefined;
  if (staticTarget) {
    staticServer = await serveStatic(staticTarget);
    config.baseUrl = staticServer.url;
    // Auto-discover routes if dir is provided and routes not explicitly specified
    if (opts.dir && (!config.routes || (Array.isArray(config.routes) && config.routes.length === 0))) {
      config.routes = discoverHtmlRoutes(String(opts.dir));
      process.stderr.write(`[ui-crawl] Auto-discovered ${config.routes.length} HTML route(s) in ${opts.dir}\n`);
    }
  }

  try {
    if (!config.baseUrl) {
      console.error(
        JSON.stringify({
          error: 'ui-crawl requires --base-url <url>, --dir <path>, --file <path>, or a --config file with "baseUrl".',
        }),
      );
      process.exit(2);
    }

    if (opts.verbose) {
      process.stderr.write(`[ui-crawl] auditing ${config.baseUrl}${staticTarget ? ` (serving ${staticTarget})` : ''}...\n`);
    }

    const result = await crawl(config);
    let payload = buildAgentPayload(result);
    if (opts['defects-only']) {
      payload.actions = payload.actions.filter((a) => a.bucket === 'defect');
    }
    const output = opts.full ? buildFindingsJson(result) : JSON.stringify(payload, null, 2);

    process.stdout.write(output + '\n');

    const defects = result.findings.filter((f) => f.bucket === 'defect').length;
    if (defects > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (staticServer) await staticServer.close();
  }
}

main().catch((e) => {
  console.error(
    JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    }),
  );
  process.exit(1);
});
