import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { crawl, type CrawlConfig } from './index.js';
import type { StorageStateData } from './config.js';
import { buildAgentPayload, buildFindingsJson, buildFixPlan, type AgentPayload } from './report.js';
import { snapshotUrl, formatSnapshot } from './snapshot.js';
import { serveStatic, discoverHtmlRoutes, type StaticServer } from './serve.js';
import { openDatabase, getDiff, getRunHistory, getDefectRoutes, hasRun, getRunResult } from './db.js';
import { UiSession, SessionRegistry, type SessionAction } from './session.js';
import { SELECTOR, SNAPSHOT_SELECTOR } from './selectors.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Live browser sessions, keyed by id. Bounded so a caller cannot leak processes. */
const sessions = new SessionRegistry(4);

/** Reported in `initialize`. Kept next to the tool list so the two cannot disagree. */
export const MCP_VERSION = '0.2.0';

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** A storageState path, or the state object itself (as `ui_login` returns). */
function storageStateArg(v: unknown): string | StorageStateData | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as StorageStateData;
  return undefined;
}

function ok(id: string | number | null, payload: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }], isError: false },
  };
}

function fail(id: string | number | null, message: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: message }], isError: true },
  };
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/**
 * Read a PNG off disk as an MCP image content block, so a vision-capable caller sees
 * pixels instead of a path it may not be able to open.
 *
 * Returns null for anything unreadable or absurdly large — a missing image is reported
 * in the text payload, never silently dropped, and a monster file never blows the transport.
 */
async function imageContent(absPath: string): Promise<ImageContent | null> {
  try {
    const buf = await readFile(absPath);
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
    return { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' };
  } catch {
    return null;
  }
}

/** A text payload with the readable images appended, for callers that can see. */
function okWithImages(
  id: string | number | null,
  payload: unknown,
  images: Array<ImageContent | null>,
): JsonRpcResponse {
  const content: unknown[] = [
    { type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) },
  ];
  for (const img of images) {
    if (img) content.push(img);
  }
  return { jsonrpc: '2.0', id, result: { content, isError: false } };
}

/**
 * Every crawler knob the CLI accepts, in one place, so the MCP surface cannot silently
 * fall behind the command line. A harness user should not have to know which invocation
 * happens to expose the option they need.
 */
const CRAWL_PROPERTIES = {
  baseUrl: { type: 'string', description: 'Base URL of a running app (e.g. http://localhost:3000)' },
  dir: { type: 'string', description: 'Local directory to serve statically and audit' },
  file: { type: 'string', description: 'Local HTML file to serve statically and audit' },
  routes: { type: 'array', items: { type: 'string' }, description: 'Routes to audit; omit to discover' },
  maxPages: { type: 'number', description: 'Hard cap on visited route templates (default 25)' },
  maxProbesPerPage: { type: 'number', description: 'Cap on controls click-probed per page (default 40)' },
  maxFindingsPerPage: { type: 'number', description: 'Cap on findings kept per route (default 200); excess is reported as truncated, never hidden' },
  browser: { type: 'string', enum: ['chromium', 'webkit', 'firefox'], description: 'Browser engine (default chromium)' },
  quick: { type: 'boolean', description: 'Fast sweep: skip clicks and zoom reflow' },
  themeSweep: { type: 'boolean', description: 'Also audit under dark mode' },
  captureCrops: { type: 'boolean', description: 'Photograph each finding: native image blocks over MCP, base64 plus a file path over the CLI' },
  concurrency: { type: 'number', description: 'Concurrent page visit workers (default 4)' },
  headless: { type: 'boolean', description: 'Run the browser headless (default true)' },
  storageState: {
    type: ['string', 'object'],
    description: 'Authenticated context: a storageState path, or the state object ui_login returns',
  },
  seedStorage: { type: 'string', description: 'JSON file of localStorage/sessionStorage to pre-seed' },
  outDir: { type: 'string', description: 'Where screenshots and reports are written (default ./ui-crawl-out)' },
  dbPath: { type: 'string', description: 'SQLite database path (default .ui-crawl.db); "none" to disable' },
  diff: { type: 'boolean', description: 'Compute a differential against the previous run' },
  rerunDefects: { type: 'boolean', description: 'Re-audit only the routes that had defects last run' },
  planOnly: { type: 'boolean', description: 'Return the ordered work order (ui_fix_plan shape) instead of the raw action list' },
  skipInteractions: { type: 'boolean', description: 'Skip the click sweep' },
  skipLayout: { type: 'boolean', description: 'Skip layout collision and clipping checks' },
  skipContrast: { type: 'boolean', description: 'Skip WCAG contrast checks' },
  skipAffordance: { type: 'boolean', description: 'Skip hover/focus affordance checks' },
  skipSpacing: { type: 'boolean', description: 'Skip spacing and touch-target checks' },
  skipHitTest: { type: 'boolean', description: 'Skip pointer hit-testing' },
  skipZoom: { type: 'boolean', description: 'Skip the zoom reflow pass' },
  guidance: { type: 'boolean', description: 'Fetch robots/sitemap/llms.txt (default true)' },
  networkInventory: { type: 'boolean', description: 'Record same-origin XHR/fetch calls (default true)' },
  full: { type: 'boolean', description: 'Return the full findings.json instead of the concise action plan' },
} as const;

const VIEWPORT_SCHEMA = {
  type: 'array',
  description: 'Viewports to render; one PageReport is emitted per viewport (default a single 1280x800).',
  items: {
    type: 'object',
    properties: {
      width: { type: 'number' },
      height: { type: 'number' },
      label: { type: 'string', description: 'Short name, used in screenshot filenames' },
    },
    required: ['width', 'height'],
  },
};

export const MCP_TOOLS = [
  {
    name: 'ui_audit',
    description:
      'Batch audit of a web app: visual, layout, contrast, accessibility, and interaction defects across many routes at once. Returns a verdict, a prioritised action list, and page renders plus finding crops as native image blocks. Use ui_open + ui_act instead when you need to look at one page and drive it yourself.',
    inputSchema: { type: 'object', properties: { ...CRAWL_PROPERTIES, viewports: VIEWPORT_SCHEMA } },
  },
  {
    name: 'ui_open',
    description:
      'Open a live browser session for step-by-step navigation. Returns a sessionId plus a numbered snapshot of interactive controls and a screenshot. Every control is addressed by the [n] index in that snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
        dir: { type: 'string', description: 'Local directory to serve and open' },
        file: { type: 'string', description: 'Local HTML file to serve and open' },
        route: { type: 'string', description: 'Path to open within a dir/file target (e.g. /about)' },
        browser: { type: 'string', enum: ['chromium', 'webkit', 'firefox'] },
        width: { type: 'number', description: 'Viewport width (default 1280)' },
        height: { type: 'number', description: 'Viewport height (default 800)' },
        headless: { type: 'boolean' },
        outDir: { type: 'string', description: 'Where screenshots are written' },
        storageState: { type: 'string' },
        settleMs: { type: 'number', description: 'How long an action may take to produce a signal (default 800)' },
        markedScreenshots: { type: 'boolean', description: 'Number controls on screenshots (default true)' },
      },
    },
  },
  {
    name: 'ui_act',
    description:
      'Perform one action in a live session and report what provably happened: the ACTED/NOOP verdict, the signals behind it, the resulting URL, a fresh numbered snapshot, and a screenshot. Address controls by the [n] index in the latest snapshot; a missing index fails loudly, never clicks something adjacent. Actions: click, fill, select, press, scroll, resize, theme, screenshot, back, forward, reload, wait.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'From ui_open' },
        action: {
          type: 'string',
          enum: ['click', 'fill', 'select', 'hover', 'fillForm', 'press', 'scroll', 'resize', 'theme', 'screenshot', 'back', 'forward', 'reload', 'wait'],
          description: 'Which action to perform',
        },
        index: { type: 'number', description: 'Snapshot index to address, for click/fill/select/hover' },
        value: { type: 'string', description: 'Text to fill, option to select' },
        fields: {
          type: 'array',
          description: 'Fields for fillForm: [{index, value}, …] — filled in one step under one observation window',
          items: {
            type: 'object',
            properties: { index: { type: 'number' }, value: { type: 'string' } },
            required: ['index', 'value'],
          },
        },
        dialog: {
          type: 'string',
          enum: ['accept', 'dismiss'],
          description: 'Decision for the next native dialog this action raises; without it dialogs are recorded and dismissed',
        },
        promptText: { type: 'string', description: 'Text for a prompt dialog being accepted' },
        key: { type: 'string', description: 'Key for press, e.g. "Enter", "Tab", "Escape"' },
        dx: { type: 'number', description: 'Horizontal scroll for scroll' },
        dy: { type: 'number', description: 'Vertical scroll for scroll' },
        width: { type: 'number', description: 'Width for resize' },
        height: { type: 'number', description: 'Height for resize' },
        scheme: { type: 'string', enum: ['light', 'dark'], description: 'Colour scheme for theme' },
        fullPage: { type: 'boolean', description: 'Full-page capture for screenshot' },
        ms: { type: 'number', description: 'Milliseconds for wait' },
        route: { type: 'string', description: 'Navigate within the session origin' },
        snapshot: {
          type: 'string',
          enum: ['full', 'changed', 'none'],
          description: 'Control list verbosity: full list (default), only what changed since last step, or none',
        },
      },
      required: ['sessionId', 'action'],
    },
  },
  {
    name: 'ui_login',
    description:
      'Replay a login flow and capture the authenticated storage state for gated targets. COMMITS its actions — submitting the form really submits it — so point it at a dev target, never production. Pass the returned storageState object to ui_audit or ui_open.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        dir: { type: 'string' },
        file: { type: 'string' },
        route: { type: 'string', description: 'Path to open first, e.g. /login' },
        steps: {
          type: 'array',
          description: 'Actions to replay: {action, index?, value?, key?, dx?, dy?, width?, height?, scheme?, ms?}',
          items: { type: 'object' },
        },
        browser: { type: 'string', enum: ['chromium', 'webkit', 'firefox'] },
        headless: { type: 'boolean' },
        outDir: { type: 'string' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'ui_close',
    description: 'Close a live browser session and release its resources.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'ui_fix_plan',
    description:
      'Ordered work order for a stored run: one step per root cause, worst first, each with the file:line to edit, the concrete fix, and the picture that shows the defect. Reads the last run without re-crawling. Start here after ui_audit: it returns done/exitCriteria so you know when to stop, and steps so you do not have to group or prioritise findings yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        dbPath: { type: 'string', description: 'SQLite database path (default: .ui-crawl.db)' },
        runId: { type: 'string', description: 'Run to plan for (default: latest)' },
        includeTaste: { type: 'boolean', description: 'Include taste questions (default true); they never block' },
      },
    },
  },
  {
    name: 'ui_snapshot',
    description:
      'Numbered, token-efficient list of a page’s interactive controls, with accessible names and whether each is visible. Pass a sessionId to inspect the live session instead of loading a fresh page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        dir: { type: 'string' },
        file: { type: 'string' },
        sessionId: { type: 'string', description: 'Inspect an open session instead of a new page' },
        cap: { type: 'number', description: 'Max controls to return (default 80)' },
        format: { type: 'string', enum: ['text', 'json'] },
      },
    },
  },
  {
    name: 'ui_diff',
    description:
      'Compare two crawl runs: which findings were fixed, which persist, and which are regressions. Run ids come from ui_audit or ui_history.',
    inputSchema: {
      type: 'object',
      properties: {
        dbPath: { type: 'string' },
        runA: { type: 'string', description: 'Baseline run id (default: the run before runB)' },
        runB: { type: 'string', description: 'Current run id (default: latest)' },
      },
    },
  },
  {
    name: 'ui_history',
    description: 'Past crawl runs with their verdicts and defect counts.',
    inputSchema: {
      type: 'object',
      properties: { dbPath: { type: 'string' }, limit: { type: 'number', description: 'default 10' } },
    },
  },
  {
    name: 'ui_selectors',
    description:
      'The CSS selectors this tool enumerates controls with, so an agent can predict which elements a snapshot will surface and which it will miss.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** Build a crawl config from MCP arguments, sharing the CLI's own resolution. */
function crawlConfigFrom(args: Record<string, unknown>, baseUrl: string): CrawlConfig {
  const viewports = Array.isArray(args.viewports)
    ? (args.viewports as Array<{ width: number; height: number; label?: string }>)
    : undefined;

  return {
    baseUrl,
    routes: Array.isArray(args.routes) ? (args.routes as string[]) : undefined,
    maxPages: num(args.maxPages),
    maxProbesPerPage: num(args.maxProbesPerPage),
    maxFindingsPerPage: num(args.maxFindingsPerPage),
    browser: str(args.browser) as CrawlConfig['browser'],
    quick: bool(args.quick),
    themeSweep: bool(args.themeSweep),
    captureCrops: bool(args.captureCrops),
    concurrency: num(args.concurrency),
    headless: bool(args.headless),
    storageState: storageStateArg(args.storageState),
    seedStorage: str(args.seedStorage),
    outDir: str(args.outDir),
    dbPath: str(args.dbPath) === 'none' ? null : str(args.dbPath),
    diff: bool(args.diff) ?? (str(args.diff) as unknown as string),
    skipInteractionSweep: bool(args.skipInteractions),
    skipLayout: bool(args.skipLayout),
    skipContrast: bool(args.skipContrast),
    skipAffordance: bool(args.skipAffordance),
    skipSpacing: bool(args.skipSpacing),
    skipHitTest: bool(args.skipHitTest),
    skipZoom: bool(args.skipZoom),
    guidance: bool(args.guidance),
    networkInventory: bool(args.networkInventory),
    ...(viewports ? { viewports } : {}),
  } as CrawlConfig;
}

function buildAction(args: Record<string, unknown>): SessionAction | string {
  const kind = str(args.action);
  const index = num(args.index);
  const value = str(args.value);

  switch (kind) {
    case 'click':
      return index === undefined ? 'click requires an index' : { type: 'click', index };
    case 'fill':
      return index === undefined || value === undefined
        ? 'fill requires an index and a value'
        : { type: 'fill', index, value };
    case 'select':
      return index === undefined || value === undefined
        ? 'select requires an index and a value'
        : { type: 'select', index, value };
    case 'press':
      return { type: 'press', key: str(args.key) ?? value ?? 'Enter' };
    case 'hover':
      return index === undefined ? 'hover requires an index' : { type: 'hover', index };
    case 'fillForm': {
      const fields = args.fields;
      if (!Array.isArray(fields) || !fields.length) {
        return 'fillForm requires a non-empty fields array of {index, value}';
      }
      const clean: Array<{ index: number; value: string }> = [];
      for (const f of fields) {
        if (!f || typeof f !== 'object') return 'fillForm fields must be {index, value} objects';
        const rec = f as Record<string, unknown>;
        if (typeof rec.index !== 'number' || typeof rec.value !== 'string') {
          return 'fillForm fields must be {index, value} objects with a numeric index and string value';
        }
        clean.push({ index: rec.index, value: rec.value });
      }
      return { type: 'fillForm', fields: clean };
    }
    case 'scroll':
      return { type: 'scroll', dx: num(args.dx), dy: num(args.dy) };
    case 'resize': {
      const width = num(args.width);
      const height = num(args.height);
      return width === undefined || height === undefined
        ? 'resize requires width and height'
        : { type: 'resize', width, height };
    }
    case 'theme':
      return { type: 'theme', scheme: str(args.scheme) === 'dark' ? 'dark' : 'light' };
    case 'back':
      return { type: 'back' };
    case 'forward':
      return { type: 'forward' };
    case 'reload':
      return { type: 'reload' };
    case 'screenshot':
      return { type: 'screenshot', fullPage: bool(args.fullPage) };
    case 'wait':
      return { type: 'wait', ms: num(args.ms) };
    default:
      return `unknown action "${kind}" — expected one of: click, fill, select, press, scroll, resize, theme, screenshot, back, forward, reload, wait`;
  }
}

export async function handleMcpMessage(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;

  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ui-crawl', version: MCP_VERSION },
      },
    };
  }

  if (request.method === 'notifications/initialized') return null;

  if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (request.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  if (request.method !== 'tools/call') {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${request.method}` } };
  }

  const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === 'ui_selectors') {
    return ok(id, {
      probeSelector: SELECTOR,
      snapshotSelector: SNAPSHOT_SELECTOR,
      note:
        'A snapshot lists SNAPSHOT_SELECTOR matches, so it surfaces menus, tabs, and custom role widgets that the click sweep (probeSelector) never touches. Those are exactly the controls most likely to be dead.',
    });
  }

  if (name === 'ui_open') {
    let session: UiSession | undefined;
    try {
      session = await UiSession.open(
        {
          url: str(args.url),
          dir: str(args.dir),
          file: str(args.file),
          route: str(args.route),
        },
        {
          browser: str(args.browser) as 'chromium' | 'webkit' | 'firefox' | undefined,
          width: num(args.width),
          height: num(args.height),
          headless: bool(args.headless),
          outDir: str(args.outDir),
          storageState: storageStateArg(args.storageState),
          interactionTimeoutMs: num(args.settleMs),
          markedScreenshots: bool(args.markedScreenshots),
        },
      );
      sessions.add(session);
      const state = await session.act({ type: 'wait', ms: 1 });
      const shot = state.screenshot ? await imageContent(session.screenshotPath(state.screenshot)) : null;
      return okWithImages(id, { sessionId: session.id, ...state }, [shot]);
    } catch (err) {
      await session?.close().catch(() => {});
      return fail(id, `ui_open failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (name === 'ui_act') {
    const sessionId = str(args.sessionId);
    if (!sessionId) return fail(id, 'ui_act requires a sessionId from ui_open');
    let session: UiSession;
    try {
      session = sessions.get(sessionId);
    } catch {
      return fail(id, `no open session "${sessionId}" — call ui_open first`);
    }
    // A `route` argument is a navigation, not an action, and is allowed to fail loudly.
    if (str(args.route)) {
      try {
        return ok(id, await session.goto({ route: str(args.route) }));
      } catch (err) {
        return fail(id, `navigation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const action = buildAction(args);
    if (typeof action === 'string') return fail(id, action);
    const snapshotArg = str(args.snapshot);
    const snapshotMode =
      snapshotArg === 'changed' || snapshotArg === 'none' || snapshotArg === 'full' ? snapshotArg : undefined;
    const dialogArg = str(args.dialog);
    const dialogOpt =
      dialogArg === 'accept' || dialogArg === 'dismiss'
        ? { dialog: { decision: dialogArg, promptText: str(args.promptText) } as const }
        : {};
    const state = await session.act(
      action,
      { ...(snapshotMode ? { snapshot: snapshotMode } : {}), ...dialogOpt },
    );
    const shot = state.screenshot ? await imageContent(session.screenshotPath(state.screenshot)) : null;
    return okWithImages(id, state, [shot]);
  }

  if (name === 'ui_close') {
    const sessionId = str(args.sessionId);
    if (!sessionId) return fail(id, 'ui_close requires a sessionId');
    if (!sessions.has(sessionId)) return fail(id, `no open session "${sessionId}"`);
    await sessions.close(sessionId);
    return ok(id, { closed: sessionId, open: sessions.ids() });
  }

  if (name === 'ui_login') {
    const steps = args.steps;
    if (!Array.isArray(steps) || !steps.length) {
      return fail(id, 'ui_login requires a non-empty steps array');
    }
    let server: StaticServer | undefined;
    let session: UiSession | undefined;
    try {
      let baseUrl = str(args.url);
      const target = str(args.dir) ?? str(args.file);
      if (!baseUrl && target) {
        server = await serveStatic(target);
        baseUrl = server.url;
      }
      if (!baseUrl) return fail(id, 'ui_login requires url, dir, or file');

      session = await UiSession.open(
        { url: baseUrl, route: str(args.route) },
        {
          browser: str(args.browser) as 'chromium' | 'webkit' | 'firefox' | undefined,
          headless: bool(args.headless),
          outDir: str(args.outDir),
        },
      );
      const acted: string[] = [];
      for (const raw of steps) {
        const action = buildAction((raw ?? {}) as Record<string, unknown>);
        if (typeof action === 'string') {
          return fail(id, `ui_login step rejected: ${action}`);
        }
        const result = await session.act(action, { snapshot: 'none' });
        acted.push(`${result.action} -> ${result.verdict}`);
        if (!result.ok) {
          return fail(id, `ui_login step failed (${result.action}): ${result.error}`);
        }
      }
      const storageState = await session.saveStorageState();
      const finalShot = await session.screenshot().catch(() => undefined);
      const images = finalShot ? [await imageContent(session.screenshotPath(finalShot))] : [];
      return okWithImages(
        id,
        { storageState, steps: acted, screenshot: finalShot },
        images,
      );
    } catch (err) {
      return fail(id, `ui_login failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await session?.close().catch(() => {});
      if (server) await server.close().catch(() => {});
    }
  }

  if (name === 'ui_audit') {
    let server: StaticServer | undefined;
    try {
      let baseUrl = str(args.baseUrl);
      const target = str(args.dir) ?? str(args.file);
      if (!baseUrl && target) {
        server = await serveStatic(target);
        baseUrl = server.url;
      }
      if (!baseUrl) return fail(id, 'ui_audit requires baseUrl, dir, or file');

      const config = crawlConfigFrom(args, baseUrl);

      // Same rule as the CLI: a served directory audits its HTML routes, not a blind
      // discovery crawl from `/`. Without this the two surfaces visit different pages.
      if (target && str(args.dir) && !Array.isArray(args.routes)) {
        const discovered = discoverHtmlRoutes(target);
        if (discovered.length) config.routes = discovered;
      }

      if (bool(args.rerunDefects) && config.dbPath !== null) {
        try {
          const db = openDatabase(config.dbPath ?? '.ui-crawl.db');
          const latest = getRunHistory(db, 1)[0];
          if (latest) {
            const routes = getDefectRoutes(db, latest.id);
            if (routes.length) config.routes = routes;
          }
        } catch {
          /* fall through to discovered routes */
        }
      }

      const result = await crawl(config);
      if (bool(args.planOnly)) return ok(id, buildFixPlan(result, result.diff));
      if (bool(args.full)) return ok(id, buildFindingsJson(result));

      // The JSON text stays the parseable record, but pixels travel as image blocks, not
      // base64 blobs: ~83% of a crops payload is otherwise unreadable text tax. A crop is
      // stripped from the text only when its image block was actually attached, so nothing
      // is lost for a caller that cannot render images.
      const payload: AgentPayload = buildAgentPayload(result);
      const outDir = result.reportPath ?? './ui-crawl-out';
      const images: Array<ImageContent | null> = [];
      for (const page of payload.pages) {
        for (const rel of [page.screenshot, page.screenshotMarked, page.darkScreenshot].filter(Boolean) as string[]) {
          images.push(await imageContent(path.resolve(outDir, rel)));
        }
      }
      for (const action of payload.actions) {
        if (action.cropBase64 && action.crop) {
          const img = await imageContent(path.resolve(outDir, action.crop));
          if (img) {
            images.push(img);
            delete action.cropBase64;
          }
        }
      }
      return okWithImages(id, payload, images);
    } catch (err) {
      return fail(id, `ui_audit failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (server) await server.close().catch(() => {});
    }
  }

  if (name === 'ui_snapshot') {
    try {
      const sessionId = str(args.sessionId);
      if (sessionId) {
        const session = sessions.get(sessionId);
        const cap = num(args.cap);
        const entries = await session.snapshot(cap);
        return ok(id, str(args.format) === 'json' ? entries : formatSnapshot(entries, cap));
      }
      const entries = await snapshotUrl({
        url: str(args.url),
        dir: str(args.dir),
        file: str(args.file),
        cap: num(args.cap),
      });
      return ok(id, str(args.format) === 'json' ? entries : formatSnapshot(entries, num(args.cap)));
    } catch (err) {
      return fail(id, `ui_snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (name === 'ui_diff') {
    try {
      const db = openDatabase(str(args.dbPath) ?? '.ui-crawl.db');
      const runB = str(args.runB);
      const runA = str(args.runA);
      if (!runB && !getRunHistory(db, 2).length) {
        return fail(id, 'no crawl runs in the database — run ui_audit first');
      }
      if (runB && !hasRun(db, runB)) {
        return fail(id, `no run with id "${runB}" — ui_history lists real ids`);
      }
      const current = runB ?? getRunHistory(db, 1)[0].id;
      const diff = getDiff(db, current, runA);
      if (!diff) {
        return fail(id, 'no diff available — need at least two runs, or pass an explicit runA');
      }
      return ok(id, diff);
    } catch (err) {
      return fail(id, `ui_diff failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (name === 'ui_history') {
    try {
      const db = openDatabase(str(args.dbPath) ?? '.ui-crawl.db');
      return ok(id, getRunHistory(db, num(args.limit) ?? 10));
    } catch (err) {
      return fail(id, `ui_history failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (name === 'ui_fix_plan') {
    let server: StaticServer | undefined;
    try {
      const dbPath = str(args.dbPath) ?? '.ui-crawl.db';
      const db = openDatabase(dbPath);
      const runId = str(args.runId) ?? getRunHistory(db, 1)[0]?.id;
      if (!runId) return fail(id, 'no runs in the database — run ui_audit first');
      const stored = getRunResult(db, runId);
      if (!stored) return fail(id, `no run with id "${runId}" — ui_history lists real ids`);

      // The plan is derived from stored findings plus the diff against the run before
      // it, so "what did I just fix / what did I just break" needs no re-crawl either.
      const diff = getDiff(db, runId);
      const plan = buildFixPlan(
        {
          baseUrl: stored.baseUrl,
          startedAt: '',
          finishedAt: '',
          pages: stored.pages,
          findings: stored.findings,
          runId,
        },
        diff ?? undefined,
      );
      if (bool(args.includeTaste) === false) plan.tasteQuestions = [];

      // Attach the representative crops as image blocks, same delivery as ui_audit.
      const images: Array<ImageContent | null> = [];
      for (const step of plan.steps) {
        if (step.crop) images.push(await imageContent(path.resolve(stored.outDir, step.crop)));
        if (step.cropBase64) {
          images.push({ type: 'image', data: step.cropBase64.split(',')[1] ?? '', mimeType: 'image/png' });
        }
      }
      return okWithImages(id, plan, images);
    } catch (err) {
      return fail(id, `ui_fix_plan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (server) await server.close().catch(() => {});
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
}

export async function startMcpServer(
  inStream: Readable = process.stdin,
  outStream: Writable = process.stdout,
): Promise<void> {
  const rl = readline.createInterface({ input: inStream, terminal: false });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as JsonRpcRequest;
        const response = await handleMcpMessage(parsed);
        if (response !== null) outStream.write(JSON.stringify(response) + '\n');
      } catch (err) {
        outStream.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : String(err)}` },
          }) + '\n',
        );
      }
    }
  } finally {
    // Stdin closed: the host is going away. A session left open holds a browser child
    // process whose pipes keep the event loop alive, wedging shutdown indefinitely.
    await sessions.closeAll().catch(() => {});
  }
}
