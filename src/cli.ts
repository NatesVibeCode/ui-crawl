import { readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { crawl, type CrawlConfig } from './index.js';
import { buildAgentPayload, buildFindingsJson, buildFixPlan } from './report.js';
import { startMcpServer } from './mcp.js';
import { snapshotUrl, formatSnapshot } from './snapshot.js';
import { serveStatic, discoverHtmlRoutes, type StaticServer } from './serve.js';
import { openDatabase, getDiff, getRunHistory, getDefectRoutes, hasRun, getRunResult } from './db.js';
import { UiSession, SessionRegistry, type SessionAction } from './session.js';
import { TuiSession } from './tuiSession.js';
import { checkTui, observeTui, validateTuiCheck, validateTuiObserve, type TuiCheckOptions, type TuiObserveOptions } from './tuiCheck.js';
import { auditTui } from './tuiAudit.js';
import type { ActionState } from './session.js';

/**
 * The single CLI implementation.
 *
 * This used to exist twice — a hand-written `bin/ui-crawl.js` and a near-identical
 * `bin/ui-crawl.ts` — with nothing asserting they agreed, so they were free to drift.
 * There is one copy now, typed and covered by tests; `bin/ui-crawl.js` is a shim.
 *
 * Contract: stdout is pure data (JSON, or the formatted snapshot list). Every progress
 * line, warning, and error goes to stderr. Exit codes: 0 clean or taste-only, 1 defects
 * found, 2 misconfigured.
 */

export interface ParsedFlags {
  opts: Record<string, string | boolean>;
  positional: string[];
}

export function parseFlags(args: string[]): ParsedFlags {
  const opts: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      if (body.includes('=')) {
        const [k, v] = body.split(/=(.*)/s);
        opts[k] = v;
        continue;
      }
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        opts[body] = next;
        i++;
      } else {
        opts[body] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const k = a.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        opts[k] = next;
        i++;
      } else {
        opts[k] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

const EXIT_OK = 0;
const EXIT_DEFECTS = 1;
const EXIT_CONFIG = 2;

function fail(message: string, code = EXIT_CONFIG): number {
  process.stderr.write(JSON.stringify({ error: message }) + '\n');
  return code;
}

/** Open a long-lived browser session and replay a scripted action list against it. */
async function runScriptedSession(
  opts: Record<string, string | boolean>,
): Promise<number> {
  const stepsPath = opts.steps ? String(opts.steps) : undefined;
  if (!stepsPath) return fail('--session requires --steps <file.json>');

  let steps: Array<SessionAction | ({ type: 'check' } & TuiCheckOptions) | ({ type: 'observe' } & TuiObserveOptions)>;
  try {
    steps = JSON.parse(await readFile(stepsPath, 'utf8')) as SessionAction[];
  } catch (err) {
    return fail(`--steps: cannot read ${stepsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(steps)) return fail('--steps must be a JSON array of actions');
  try {
    for (const step of steps) {
      if (step?.type === 'check') validateTuiCheck(step);
      if (step?.type === 'observe') validateTuiObserve(step);
      if ((step?.type === 'check' || step?.type === 'observe') && !opts.tui) return fail(`${step.type} requires --tui`);
    }
  } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  if (opts['tui-check']) return fail('Use check steps inside --session, or --tui-check without --session');

  const tuiTarget = opts.tui ? String(opts.tui) : undefined;
  const staticTarget = opts.dir ? String(opts.dir) : opts.file ? String(opts.file) : undefined;
  const targetUrl = opts.url ? String(opts.url) : opts['base-url'] ? String(opts['base-url']) : undefined;
  if (!targetUrl && !staticTarget && !tuiTarget) {
    return fail('--session requires --url, --base-url, --dir, --file, or --tui');
  }

  const outDir = opts.out ? String(opts.out) : './ui-crawl-out';
  const registry = new SessionRegistry(1);
  const session = tuiTarget
    ? await TuiSession.open({
        command: tuiTarget,
        cols: opts.cols ? Number(opts.cols) : undefined,
        rows: opts.rows ? Number(opts.rows) : undefined,
        outDir,
        markedScreenshots: !opts['no-marked'],
      })
    : await UiSession.open(
        { url: targetUrl, dir: staticTarget },
        {
          browser: (opts.browser ? String(opts.browser) : 'chromium') as 'chromium' | 'webkit' | 'firefox',
          outDir,
          headless: !opts.headed,
          markedScreenshots: !opts['no-marked'],
          ...(opts.width ? { width: Number(opts.width) } : {}),
          ...(opts.height ? { height: Number(opts.height) } : {}),
        },
      );
  registry.add(session);

  const transcript: Array<{ action: string; result: ActionState }> = [];
  const checks: unknown[] = [];
  let failedChecks = 0;
  let defects = 0;
  try {
    for (const step of steps) {
      if (step.type === 'check' || step.type === 'observe') {
        if (!(session instanceof TuiSession)) throw new Error(`${step.type} is a terminal-only step`);
        const result = step.type === 'check' ? await checkTui(session, step) : await observeTui(session, step);
        checks.push({ step: transcript.length + checks.length, ...result });
        if (result.passed === false) failedChecks++;
        continue;
      }
      // A step may carry a `snapshot` verbosity override alongside its action fields.
      const { snapshot: snapshotMode, ...action } = step as SessionAction & {
        snapshot?: 'full' | 'changed' | 'none';
      };
      const snapshotOpt =
        snapshotMode === 'full' || snapshotMode === 'changed' || snapshotMode === 'none'
          ? { snapshot: snapshotMode }
          : {};
      const result = await session.act(action as any, snapshotOpt);
      transcript.push({ action: result.action, result });
      process.stderr.write(
        `[ui-crawl] ${result.action} -> ${result.verdict}${result.error ? ` (${result.error})` : ''}\n`,
      );
      if (result.signals.consoleErrors > 0) defects++;
    }
  } finally {
    await registry.closeAll();
  }

  process.stdout.write(
    JSON.stringify(
      {
        sessionId: session.id,
        steps: transcript.map((t) => ({
          action: t.action,
          ok: t.result.ok,
          verdict: t.result.verdict,
          navigated: t.result.navigated,
          url: t.result.url,
          screenshot: t.result.screenshot,
          ...(t.result.dialog ? { dialog: t.result.dialog } : {}),
          ...(t.result.error ? { error: t.result.error } : {}),
          snapshot: t.result.snapshot,
        })),
        checks,
        summary: { steps: transcript.length + checks.length, consoleErrors: defects, failedChecks },
        outDir,
      },
      null,
      2,
    ) + '\n',
  );
  return defects || failedChecks || transcript.some(t => !t.result.ok) ? EXIT_DEFECTS : EXIT_OK;
}

async function runShot(opts: Record<string, string | boolean>, positional: string[]): Promise<number> {
  const outPath = String(opts.shot);
  let staticServer: StaticServer | undefined;
  const staticTarget = opts.dir ? String(opts.dir) : opts.file ? String(opts.file) : undefined;
  const given = opts.url || opts['base-url'] || positional[0];
  let targetUrl = given ? String(given) : undefined;

  if (staticTarget) {
    staticServer = await serveStatic(staticTarget);
    targetUrl = staticServer.url;
  }
  if (!targetUrl) return fail('--shot requires a target URL, positional URL, --dir, or --file');

  try {
    const { chromium, webkit, firefox } = await import('playwright');
    const browserName = String(opts.browser ?? 'chromium');
    const launcher = browserName === 'webkit' ? webkit : browserName === 'firefox' ? firefox : chromium;
    const browser = await launcher.launch({ headless: !opts.headed });
    try {
      const width = opts.width ? Number(opts.width) : 1280;
      const height = opts.height ? Number(opts.height) : 800;
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(opts.wait ? Number(opts.wait) : 500);

      if (opts.selector) {
        await page.locator(String(opts.selector)).first().screenshot({ path: outPath });
      } else {
        await page.screenshot({ path: outPath, fullPage: !!opts['full-page'] });
      }
      process.stdout.write(
        JSON.stringify({ shot: outPath, url: targetUrl, width, height, browser: browserName, selector: opts.selector }) + '\n',
      );
      return EXIT_OK;
    } finally {
      // A failed navigation must not orphan the browser behind it.
      await browser.close().catch(() => {});
    }
  } finally {
    if (staticServer) await staticServer.close();
  }
}

async function runSnapshot(opts: Record<string, string | boolean>, positional: string[]): Promise<number> {
  const given = opts.url || opts['base-url'] || positional[0];
  const targetUrl = given ? String(given) : undefined;
  const dir = opts.dir ? String(opts.dir) : undefined;
  const file = opts.file ? String(opts.file) : undefined;
  const cap = opts.cap ? Number(opts.cap) : undefined;

  if (!targetUrl && !dir && !file) {
    return fail('Snapshot requires --url <url>, --base-url <url>, --dir <path>, or --file <path>');
  }

  try {
    const entries = await snapshotUrl({ url: targetUrl, dir, file, cap });
    process.stdout.write(
      (opts.json ? JSON.stringify(entries, null, 2) : formatSnapshot(entries, cap)) + '\n',
    );
    return EXIT_OK;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), EXIT_DEFECTS);
  }
}

export /** Flags that used to exist, so a stale invocation fails with a reason instead of a mystery. */
const RETIRED: Record<string, string> = {
  ui: 'The human dashboard was removed — ui-crawl is an agent instrument, not a web app. Use --mcp (ui_audit / ui_open / ui_act) or --session --steps <file.json>.',
};

async function runCli(argv: string[]): Promise<number> {
  const { opts, positional } = parseFlags(argv);

  if (opts.help || opts.h) {
    process.stdout.write(`ui-crawl — agent-native UI inspection instrument

Usage:
  ui-crawl --base-url <url> [options]
  ui-crawl --dir <path> [options]
  ui-crawl --file <path> [options]
  ui-crawl --config <path>

Options:
  --tui <cmd>            Launch a terminal app for inspection
  --tui-check <file.json> Check explicit terminal text and spacing contracts
  --session --steps <file.json> Replay actions, terminal check/observe steps
  --routes <r1,r2>        Comma-separated routes to audit
  --dir <path>            Serve and audit a static directory
  --file <path>           Audit a single HTML file
  --base-url <url>        Base URL of a running server
  --out <dir>             Output directory (default: ./ui-crawl-out)
  --plan [runId]          Emit ordered fix plan from stored run
  --diff [runId]          Compare current run against baseline
  --history               List stored audit runs
  --defects-only          Filter out taste questions from output
  --theme-sweep           Capture both light and dark mode snapshots
  --crops                 Capture visual crops for defects
  --mcp                   Run as an MCP server
  --tui                   Audit or interact with a terminal UI
  --help, -h              Show this help message
\n`);
    return EXIT_OK;
  }

  for (const [flag, reason] of Object.entries(RETIRED)) {
    if (opts[flag]) return fail(`--${flag} was removed. ${reason}`);
  }

  if (opts.mcp) {
    await startMcpServer();
    return EXIT_OK;
  }

  if (opts.session) return runScriptedSession(opts);

  // Ordered work order for a stored run. Reads the database — no re-crawl, no browser —
  // so the caller gets the grouping, ordering and stopping condition for free.
  if (opts.plan) {
    const db = openDatabase(opts.db ? String(opts.db) : '.ui-crawl.db');
    const runId = typeof opts.plan === 'string' ? opts.plan : getRunHistory(db, 1)[0]?.id;
    if (!runId) return fail('--plan: no runs in the database — run an audit first');
    const stored = getRunResult(db, runId);
    if (!stored) return fail(`--plan: no run with id "${runId}" — check ui-crawl --history for real ids.`);
    const plan = buildFixPlan(
      { baseUrl: stored.baseUrl, startedAt: '', finishedAt: '', pages: stored.pages, findings: stored.findings, runId, detectorFailures: stored.detectorFailures },
      getDiff(db, runId) ?? undefined,
    );
    // Plans are for machines: the inline base64 is the payload, the file path is a handle.
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return plan.done ? EXIT_OK : EXIT_DEFECTS;
  }

  if (opts.history) {
    const db = openDatabase(opts.db ? String(opts.db) : '.ui-crawl.db');
    process.stdout.write(JSON.stringify(getRunHistory(db, opts.limit ? Number(opts.limit) : 10), null, 2) + '\n');
    return EXIT_OK;
  }

  if (opts.diff && !opts['base-url'] && !opts.dir && !opts.file && !opts.config) {
    const db = openDatabase(opts.db ? String(opts.db) : '.ui-crawl.db');
    if (typeof opts.diff === 'string' && !hasRun(db, opts.diff)) {
      return fail(`--diff: no run with id "${opts.diff}" — check ui-crawl --history for real ids.`);
    }
    const runB = typeof opts.diff === 'string' ? opts.diff : getRunHistory(db, 1)[0]?.id;
    const diffRes = runB ? getDiff(db, runB) : null;
    // A single-run database has nothing to diff against. Say so in the payload rather
    // than printing `null` on stdout, which reads downstream as "no regressions found".
    if (!diffRes) {
      process.stdout.write(
        JSON.stringify(
          { error: 'no diff available', reason: 'fewer than two runs in the database — run an audit first' },
          null,
          2,
        ) + '\n',
      );
      return EXIT_CONFIG;
    }
    process.stdout.write(JSON.stringify(diffRes, null, 2) + '\n');
    return EXIT_OK;
  }

  if (opts['tui-check'] && !opts.tui) return fail('--tui-check requires --tui');
  if (opts.tui) {
    if (opts['tui-check']) {
      let spec: TuiCheckOptions;
      try {
        spec = JSON.parse(await readFile(String(opts['tui-check']), 'utf8')) as TuiCheckOptions;
        validateTuiCheck(spec);
      } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      const session = await TuiSession.open({ command: String(opts.tui), cols: opts.cols ? Number(opts.cols) : undefined,
        rows: opts.rows ? Number(opts.rows) : undefined, outDir: opts.out ? String(opts.out) : undefined });
      try {
        const result = await checkTui(session, spec);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return result.passed ? EXIT_OK : EXIT_DEFECTS;
      } finally { await session.close(); }
    }
    if (opts.snapshot) {
      const session = await TuiSession.open({
        command: String(opts.tui),
        cols: opts.cols ? Number(opts.cols) : undefined,
        rows: opts.rows ? Number(opts.rows) : undefined,
        outDir: opts.out ? String(opts.out) : undefined,
      });
      try {
        const controls = await session.snapshot(opts.cap ? Number(opts.cap) : undefined);
        process.stdout.write(
          (opts.json ? JSON.stringify(controls, null, 2) : session.formatSnapshot(controls, 'full')) + '\n',
        );
        return EXIT_OK;
      } finally {
        await session.close();
      }
    }

    if (opts.shot) {
      const outPath = String(opts.shot);
      const session = await TuiSession.open({
        command: String(opts.tui),
        cols: opts.cols ? Number(opts.cols) : undefined,
        rows: opts.rows ? Number(opts.rows) : undefined,
        outDir: opts.out ? String(opts.out) : undefined,
      });
      try {
        const rel = await session.screenshot(!opts['no-marked']);
        const abs = session.screenshotPath(rel);
        if (path.resolve(outPath) !== abs) {
          await copyFile(abs, outPath);
        }
        process.stdout.write(
          JSON.stringify({ shot: outPath, tui: opts.tui, cols: opts.cols ?? 80, rows: opts.rows ?? 24 }) + '\n',
        );
        return EXIT_OK;
      } finally {
        await session.close();
      }
    }

    // Default --tui invocation: batch audit
    const payload = await auditTui({
      command: String(opts.tui),
      cols: opts.cols ? Number(opts.cols) : undefined,
      rows: opts.rows ? Number(opts.rows) : undefined,
      outDir: opts.out ? String(opts.out) : undefined,
      settleMs: opts['settle-ms'] ? Number(opts['settle-ms']) : undefined,
      probeControls: opts['probe-controls'] === true && !opts['no-clicks'],
    });
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return payload.summary.defects > 0 ? EXIT_DEFECTS : EXIT_OK;
  }

  if (opts.shot) return runShot(opts, positional);
  if (opts.snapshot) return runSnapshot(opts, positional);

  // Audit crawl
  const config: Partial<CrawlConfig> = {};
  if (opts.config) {
    try {
      Object.assign(config, JSON.parse(await readFile(String(opts.config), 'utf8')) as Partial<CrawlConfig>);
    } catch (err) {
      return fail(`--config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (opts['base-url']) config.baseUrl = String(opts['base-url']);
  if (!config.baseUrl && positional[0] && /^https?:\/\//.test(positional[0])) config.baseUrl = positional[0];
  if (opts.out) config.outDir = String(opts.out);
  if (opts.routes) config.routes = String(opts.routes).split(',').map((s) => s.trim()).filter(Boolean);
  if (opts['max-pages']) config.maxPages = Number(opts['max-pages']);
  if (opts['max-probes']) config.maxProbesPerPage = Number(opts['max-probes']);
  if (opts['max-findings']) config.maxFindingsPerPage = Number(opts['max-findings']);
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
  if (opts['no-hit-test']) config.skipHitTest = true;
  if (opts['no-guidance']) config.guidance = false;
  if (opts['no-network']) config.networkInventory = false;
  if (opts['user-agent']) config.userAgent = String(opts['user-agent']);
  if (opts.headed) config.headless = false;
  if (opts.db) config.dbPath = opts.db === 'false' || opts.db === 'null' ? null : String(opts.db);
  if (opts.diff) config.diff = typeof opts.diff === 'string' ? opts.diff : true;
  if (opts['theme-sweep'] || opts['dark-mode']) config.themeSweep = true;
  if (opts.crops) config.captureCrops = true;
  if (opts.browser) config.browser = String(opts.browser) as 'chromium' | 'webkit' | 'firefox';
  if (opts.quick) config.quick = true;
  if (opts.concurrency || opts.c) config.concurrency = Number(opts.concurrency || opts.c);

  if (opts['rerun-defects']) {
    const dbPath = opts.db ? String(opts.db) : '.ui-crawl.db';
    if (existsSync(dbPath)) {
      try {
        const db = openDatabase(dbPath);
        const runs = getRunHistory(db, 1);
        if (runs.length > 0) {
          const failedRoutes = getDefectRoutes(db, runs[0].id);
          if (failedRoutes.length > 0) {
            config.routes = failedRoutes;
            process.stderr.write(
              `[ui-crawl] Re-auditing ${failedRoutes.length} failed route(s) from run ${runs[0].id}: ${failedRoutes.join(', ')}\n`,
            );
          } else {
            process.stderr.write(`[ui-crawl] Previous run ${runs[0].id} had 0 defects. Auditing all routes.\n`);
          }
        }
      } catch {
        /* proceed with default routes */
      }
    }
  }

  let staticServer: StaticServer | undefined;
  const staticTarget = opts.dir ? String(opts.dir) : opts.file ? String(opts.file) : undefined;
  if (staticTarget) {
    staticServer = await serveStatic(staticTarget);
    config.baseUrl = staticServer.url;
    if (opts.dir && (!config.routes || (Array.isArray(config.routes) && config.routes.length === 0))) {
      config.routes = discoverHtmlRoutes(String(opts.dir));
      process.stderr.write(`[ui-crawl] Auto-discovered ${config.routes.length} HTML route(s) in ${opts.dir}\n`);
    }
  }

  // Login flow: replay scripted steps (type into the login form, submit) and capture the
  // authenticated storage state. Unlike the audit sweep — which aborts mutating requests
  // on destructive-looking controls — a login COMMITS: submitting the form really submits
  // it. Point it at a dev target, never production.
  //
  // Two shapes: `--login steps.json --save-storage state.json` saves and exits, so a
  // later audit can pass `--storage-state state.json`. Bare `--login steps.json` keeps
  // the state in memory and audits the gated app in the same run.
  if (opts.login) {
    const stepsPath = String(opts.login);
    const abortLogin = async (message: string): Promise<number> => {
      await staticServer?.close().catch(() => {});
      staticServer = undefined;
      return fail(message);
    };
    let steps: SessionAction[];
    try {
      steps = JSON.parse(await readFile(stepsPath, 'utf8')) as SessionAction[];
    } catch (err) {
      return abortLogin(`--login: cannot read ${stepsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(steps)) {
      return abortLogin('--login steps must be a JSON array of actions');
    }
    if (!config.baseUrl) {
      return abortLogin('--login requires --base-url, --dir, or --file alongside it');
    }

    const loginOut = opts.out ? String(opts.out) : './ui-crawl-out';
    const loginSession = await UiSession.open(
      { url: config.baseUrl, route: opts['login-route'] ? String(opts['login-route']) : undefined },
      {
        browser: (opts.browser ? String(opts.browser) : 'chromium') as 'chromium' | 'webkit' | 'firefox',
        outDir: loginOut,
        headless: !opts.headed,
      },
    );
    try {
      for (const step of steps) {
        const result = await loginSession.act(step, { snapshot: 'none' });
        process.stderr.write(`[ui-crawl] login: ${result.action} -> ${result.verdict}\n`);
        if (!result.ok) {
          await loginSession.close().catch(() => {});
          return abortLogin(`--login step failed (${result.action}): ${result.error}`);
        }
      }
      const finalShot = await loginSession.screenshot().catch(() => undefined);

      if (opts['save-storage']) {
        const savePath = String(opts['save-storage']);
        await loginSession.saveStorageState(savePath);
        process.stdout.write(
          JSON.stringify({ saved: savePath, steps: steps.length, screenshot: finalShot }, null, 2) + '\n',
        );
        await staticServer?.close().catch(() => {});
        staticServer = undefined;
        return EXIT_OK;
      }

      config.storageState = await loginSession.saveStorageState();
      process.stderr.write(`[ui-crawl] login: captured authenticated state (${steps.length} steps)\n`);
    } finally {
      await loginSession.close();
    }
  }

  try {
    if (!config.baseUrl) {
      return fail('ui-crawl requires --base-url <url>, --dir <path>, --file <path>, or a --config file with "baseUrl".');
    }

    if (opts.verbose) {
      process.stderr.write(
        `[ui-crawl] auditing ${config.baseUrl}${staticTarget ? ` (serving ${staticTarget})` : ''}...\n`,
      );
    }

    const result = await crawl(config as CrawlConfig);
    const payload = buildAgentPayload(result);
    if (opts['defects-only']) {
      payload.actions = payload.actions.filter((a) => a.bucket === 'defect');
    }
    process.stdout.write((opts.full ? buildFindingsJson(result) : JSON.stringify(payload, null, 2)) + '\n');

    return result.findings.some((f) => f.bucket === 'defect') ? EXIT_DEFECTS : EXIT_OK;
  } finally {
    if (staticServer) await staticServer.close();
  }
}

/** Entry point for `bin/ui-crawl.js`. Returns the process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let code: number;
  try {
    code = await runCli(argv);
  } catch (e) {
    process.stderr.write(
      JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      }) + '\n',
    );
    code = EXIT_DEFECTS;
  }
  process.exitCode = code;
}
