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
  snapshotUrl,
  formatSnapshot,
  serveStatic,
  openDatabase,
  getDiff,
  getRunHistory,
} = mod;

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    if (body.includes('=')) {
      const [k, v] = body.split(/=(.*)/s);
      out[k] = v;
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}

async function main() {
  const opts = parseFlags(process.argv.slice(2));

  // MCP Mode
  if (opts.mcp) {
    await startMcpServer();
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

  // Snapshot Mode
  if (opts.snapshot) {
    const targetUrl = (opts.url || opts['base-url']) ? String(opts.url || opts['base-url']) : undefined;
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

  let staticServer;
  const staticTarget = opts.dir ? String(opts.dir) : opts.file ? String(opts.file) : undefined;
  if (staticTarget) {
    staticServer = await serveStatic(staticTarget);
    config.baseUrl = staticServer.url;
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
      console.error(`[ui-crawl] auditing ${config.baseUrl}${staticTarget ? ` (serving ${staticTarget})` : ''}...`);
    }

    const result = await crawl(config);
    const output = opts.full ? buildFindingsJson(result) : JSON.stringify(buildAgentPayload(result), null, 2);

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
