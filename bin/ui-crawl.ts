#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import { crawl, type CrawlConfig } from '../src/index.js';

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
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

async function main(): Promise<void> {
  const opts = parseFlags(process.argv.slice(2));
  let config: Partial<CrawlConfig> = {};
  if (opts.config) config = JSON.parse(await readFile(String(opts.config), 'utf8')) as Partial<CrawlConfig>;
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
  if (opts.headed) config.headless = false;

  if (!config.baseUrl) {
    console.error('ui-crawl: provide --base-url <url> or a --config file with "baseUrl".');
    process.exit(2);
  }

  console.log(`ui-crawl → ${config.baseUrl}`);
  const result = await crawl(config as CrawlConfig);
  const defects = result.findings.filter((f) => f.bucket === 'defect').length;
  const taste = result.findings.filter((f) => f.bucket === 'taste').length;
  console.log(`\n${result.pages.length} pages · ${defects} defects · ${taste} taste questions`);
  const skipped = result.pages.reduce((n, p) => n + (p.skippedControls ?? 0), 0);
  if (skipped > 0) {
    console.log(`note: ${skipped} control(s) not probed — maxProbesPerPage cap reached (raise it with --max-probes).`);
  }
  console.log(`report: ${result.reportPath}`);
  if (defects > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
