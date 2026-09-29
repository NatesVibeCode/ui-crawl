import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { resolveConfig, type ResolvedConfig, type CrawlConfig, type StorageStateData } from './config.js';
import { buildContext, launchBrowser } from './browser.js';
import { serveStatic, type StaticServer } from './serve.js';
import { buildSnapshot, formatSnapshot, diffSnapshots, markControls, type SnapshotEntry } from './snapshot.js';
import { observeClick } from './interactions.js';
import { classifyChange, MUTATION_FLOOR } from './changeDetect.js';
import { SNAPSHOT_SELECTOR } from './selectors.js';
import type { Signals, ChangeVerdict } from './types.js';

/**
 * A live browser an agent drives one action at a time.
 *
 * The crawl is a batch instrument: it opens its own pages, decides what to click, and
 * returns a verdict. That is the wrong shape for a harness that wants to LOOK at a page,
 * click one specific thing, look again, and reason about the difference. This is the
 * instrument for that: a session persists across calls, and every action returns the
 * resulting observable state so the next decision is grounded in what actually happened
 * rather than in what was intended.
 *
 * Deliberately NOT exposed: arbitrary script evaluation. A model-driven `eval` is a
 * remote-code-execution surface wearing a UI-testing costume, and nothing in navigating
 * and evaluating a page needs it.
 */

/** The actions a caller may perform. Each returns the resulting observable state. */
export type SessionAction =
  | { type: 'click'; index: number }
  | { type: 'fill'; index: number; value: string }
  | { type: 'select'; index: number; value: string }
  | { type: 'hover'; index: number }
  | { type: 'fillForm'; fields: Array<{ index: number; value: string }> }
  | { type: 'press'; key: string }
  | { type: 'scroll'; dy?: number; dx?: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'theme'; scheme: 'light' | 'dark' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'screenshot'; fullPage?: boolean }
  | { type: 'wait'; ms?: number };

export interface SessionTarget {
  url?: string;
  dir?: string;
  file?: string;
  /** Path appended to a `dir`/`file` target's served origin, e.g. '/about'. */
  route?: string;
  /** Local terminal command for TUI evaluation. */
  tui?: string | string[];
}

export interface SessionOptions {
  browser?: 'chromium' | 'webkit' | 'firefox';
  width?: number;
  height?: number;
  cols?: number;
  rows?: number;
  headless?: boolean;
  /** Where screenshots are written. Defaults to './ui-crawl-out'. */
  outDir?: string;
  storageState?: string | StorageStateData;
  /**
   * How long an action may take to produce a signal, in ms. Default 800 — deliberately
   * far shorter than the crawl's 1500ms, because here a human-equivalent agent is
   * blocked on the answer rather than a batch job running overnight.
   */
  interactionTimeoutMs?: number;
  navTimeoutMs?: number;
  /** Max controls returned in the post-action snapshot. Default 80. */
  cap?: number;
  /**
   * Number every visible control on screenshots (set-of-marks), so the `[n]` indices in
   * the snapshot text ground to pixels in the image. Default true — the session is a
   * vision instrument, and an unmarked screenshot leaves the model guessing which pixels
   * `[3]` means. Marking never touches the verdict: badges are injected after the
   * mutation count is read and removed before the action returns.
   */
  markedScreenshots?: boolean;
  /**
   * How much of the control list each action returns. `full` re-sends everything (the
   * default — an index is only addressable if the caller has seen it); `changed` sends
   * only what moved since the last snapshot, for long loops where eighty unchanged lines
   * per step are pure token burn; `none` sends no list at all, for steps where only the
   * verdict and the screenshot matter. Per-action overrides via `act(action, { snapshot })`.
   */
  snapshot?: SnapshotMode;
}

export type SnapshotMode = 'full' | 'changed' | 'none';

export interface ActionState {
  ok: boolean;
  action: string;
  /** Snapshot index the action addressed, when it addressed one. */
  index?: number;
  /** Tag and accessible name of the element acted on. */
  target?: { tag: string; name: string };
  url: string;
  title: string;
  /** Viewport in CSS px; screenshot pixels are CSS px × deviceScaleFactor. */
  viewport: { width: number; height: number; deviceScaleFactor?: number };
  /** Whether the action moved the page somewhere else. */
  navigated: boolean;
  /** What the action provably did. Silence is never reported as success. */
  verdict: ChangeVerdict;
  signals: Signals;
  /** A native alert/confirm/prompt the page raised, if any. Dismissed, never left blocking. */
  dialog?: { type: string; message: string; decision?: 'accepted' | 'dismissed' };
  /** Numbered control list for the state AFTER the action. */
  snapshot: string;
  /** Path to a screenshot of the state AFTER the action, relative to `outDir`. */
  screenshot?: string;
  error?: string;
}

let sessionCounter = 0;

export class UiSession {
  readonly id: string;
  private browser: Browser;
  private context: BrowserContext;
  private page: Page;
  private cfg: ResolvedConfig;
  private staticServer: StaticServer | undefined;
  private baseUrl: string;
  private outDir: string;
  private cap: number;
  private viewport: { width: number; height: number };
  private deviceScaleFactor = 1;
  private step = 0;
  private closed = false;
  /** Dialogs seen since the last action, so the caller can be told about them. */
  private lastDialog: { type: string; message: string; decision?: 'accepted' | 'dismissed' } | undefined;
  /**
   * One-shot dialog directive for the next native dialog. The persistent handler
   * dismisses by default (a blocking dialog must never hang the session); when a caller
   * passes a decision with its action, the next dialog gets that decision instead, once.
   */
  private dialogOverride: { decision: 'accept' | 'dismiss'; promptText?: string } | null = null;
  /** Full control list behind the last reported snapshot, for `changed` deltas. */
  private lastEntries: SnapshotEntry[] = [];
  private snapshotMode: SnapshotMode;
  private markedScreenshots: boolean;

  private constructor(args: {
    id: string;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    cfg: ResolvedConfig;
    staticServer: StaticServer | undefined;
    outDir: string;
    cap: number;
    viewport: { width: number; height: number };
    snapshotMode: SnapshotMode;
    markedScreenshots: boolean;
  }) {
    this.id = args.id;
    this.browser = args.browser;
    this.context = args.context;
    this.page = args.page;
    this.cfg = args.cfg;
    this.staticServer = args.staticServer;
    this.outDir = args.outDir;
    this.cap = args.cap;
    this.viewport = args.viewport;
    this.baseUrl = args.cfg.baseUrl;
    this.snapshotMode = args.snapshotMode;
    this.markedScreenshots = args.markedScreenshots;
  }

  static async open(target: SessionTarget, options: SessionOptions = {}): Promise<UiSession> {
    let staticServer: StaticServer | undefined;
    let targetUrl = target.url;

    if (!targetUrl && (target.dir || target.file)) {
      staticServer = await serveStatic(target.dir || target.file!);
      targetUrl = staticServer.url;
    }
    if (!targetUrl) throw new Error('ui-crawl session: requires url, dir, or file');

    const base = new URL(targetUrl);
    const cfg = resolveConfig({
      baseUrl: targetUrl,
      browser: options.browser,
      headless: options.headless,
      storageState: options.storageState,
      outDir: options.outDir,
      interactionTimeoutMs: options.interactionTimeoutMs ?? 800,
      navTimeoutMs: options.navTimeoutMs,
    } satisfies CrawlConfig);

    const viewport = { width: options.width ?? 1280, height: options.height ?? 800 };
    const browser = await launchBrowser(cfg);
    const { context } = await buildContext(browser, cfg, viewport);
    const page = await context.newPage();

    const session = new UiSession({
      id: `sess_${Date.now().toString(36)}_${(sessionCounter++).toString(36)}`,
      browser,
      context,
      page,
      cfg,
      staticServer,
      outDir: options.outDir ?? './ui-crawl-out',
      cap: options.cap ?? 80,
      viewport,
      snapshotMode: options.snapshot ?? 'full',
      markedScreenshots: options.markedScreenshots ?? true,
    });

    // Native dialogs block the page until handled. Record and dismiss, so the agent is
    // told the page asked something instead of the session hanging on it. A per-action
    // override (accept/dismiss) takes precedence once, for confirm-flow testing.
    page.on('dialog', (d) => {
      const override = session.dialogOverride;
      session.dialogOverride = null;
      if (override) {
        session.lastDialog = { type: d.type(), message: d.message(), decision: override.decision === 'accept' ? 'accepted' : 'dismissed' };
        if (override.decision === 'accept') {
          void d.accept(override.promptText).catch(() => {});
        } else {
          void d.dismiss().catch(() => {});
        }
        return;
      }
      session.lastDialog = { type: d.type(), message: d.message(), decision: 'dismissed' };
      void d.dismiss().catch(() => {});
    });
    // A popup is a new page; the session's contract is one page. Close strays.
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => {});
    });

    // The initial navigation can fail (bad host, refused connection). Everything above
    // is already allocated — a throw here must not orphan a browser, a context, and a
    // static server behind it.
    try {
      await page.goto(session.routeUrl(target.route), { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
    } catch (err) {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      await staticServer?.close().catch(() => {});
      throw new Error(`ui-crawl session: initial navigation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    session.deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio || 1).catch(() => 1);
    return session;
  }

  private routeUrl(route?: string): string {
    if (!route) return this.baseUrl;
    if (/^https?:\/\//.test(route)) return route;
    return this.baseUrl.replace(/\/+$/, '') + (route.startsWith('/') ? route : `/${route}`);
  }

  /** Navigate to a route (or absolute URL) within the session's origin. */
  async goto(target: { route?: string; url?: string }): Promise<ActionState> {
    const url = target.url ?? this.routeUrl(target.route);
    const before = this.page.url();
    await this.page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs })
      .catch((e) => {
        throw new Error(`navigation failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    this.step++;
    return this.report(`goto ${url}`, { navigated: this.page.url() !== before });
  }

  /** The current numbered control list, without acting. */
  async snapshot(cap = this.cap): Promise<SnapshotEntry[]> {
    return buildSnapshot(this.page, cap);
  }

  /**
   * Perform one action and report the resulting observable state.
   *
   * Every mutating action is measured the same way the crawl measures a click, through the
   * same `observeClick` window and the same `classifyChange` verdict — so "did this do
   * anything?" gets the same honest answer here that it does in a sweep. No action reports
   * success on intent alone.
   *
   * `opts.snapshot` overrides the session's snapshot mode for this step only.
   * `opts.dialog` applies one decision to the next native dialog this action raises
   * (accept/dismiss, with optional prompt text); without it dialogs are recorded and
   * dismissed.
   */
  async act(
    action: SessionAction,
    opts: { snapshot?: SnapshotMode; dialog?: { decision: 'accept' | 'dismiss'; promptText?: string } } = {},
  ): Promise<ActionState> {
    if (this.closed) throw new Error('ui-crawl session is closed — call ui_open for a new one');
    this.lastDialog = undefined;
    if (opts.dialog) this.dialogOverride = opts.dialog;

    const label = describeAction(action);
    const urlBefore = this.page.url();

    let networkRequests = 0;
    let newConsoleMessages = 0;
    let consoleErrors = 0;
    let popupOpened = false;
    const onRequest = () => {
      networkRequests++;
    };
    const onConsole = (msg: { type(): string }) => {
      newConsoleMessages++;
      if (msg.type() === 'error') consoleErrors++;
    };
    const onPageError = () => {
      newConsoleMessages++;
      consoleErrors++;
    };
    const onPopup = () => {
      popupOpened = true;
    };

    this.page.on('request', onRequest);
    this.page.on('console', onConsole);
    this.page.on('pageerror', onPageError);
    this.context.on('page', onPopup);

    let index: number | undefined;
    let target: { tag: string; name: string } | undefined;
    let explicitScreenshot: 'full' | 'viewport' | undefined;

    try {
      // Count real DOM change, ignoring the class/style churn that hover and focus cause.
      // Hover is the exception: menus and tooltips reveal via class toggles with no other
      // signal, so a hover counts class-attribute changes too. Paint-only :hover effects
      // (no DOM change at all) still report NOOP — honestly, with the screenshot to look at.
      const countClasses = action.type === 'hover';
      await this.page
        .evaluate((countClassFlips: boolean) => {
          const w = window as unknown as { __uicrawl?: { mutations: number } };
          w.__uicrawl = { mutations: 0 };
          const SEMANTIC = new Set([
            'aria-expanded', 'aria-pressed', 'aria-selected', 'aria-checked', 'aria-hidden',
            'hidden', 'open', 'disabled', 'aria-disabled', 'data-state', 'data-active',
            'data-selected', 'data-theme',
          ]);
          new MutationObserver((muts) => {
            for (const m of muts) {
              if (m.type === 'childList') w.__uicrawl!.mutations += m.addedNodes.length + m.removedNodes.length;
              else if (
                m.type === 'attributes' &&
                m.attributeName &&
                (SEMANTIC.has(m.attributeName) || (countClassFlips && m.attributeName === 'class'))
              ) {
                w.__uicrawl!.mutations += 1;
              }
            }
          }).observe(document.body, { subtree: true, childList: true, attributes: true });
        }, countClasses)
        .catch(() => {});

      if ('index' in action) {
        const located = await this.locate(action.index);
        if (!located) {
          return await this.report(label, {
            index: action.index,
            snapshotMode: opts.snapshot ?? this.snapshotMode,
            error: `no visible control at snapshot index ${action.index} — re-snapshot and use a listed index`,
          });
        }
        index = action.index;
        target = { tag: located.tag, name: located.name };

        if (action.type === 'click') {
          await located.locator.click({ timeout: Math.min(2500, this.cfg.navTimeoutMs) });
        } else if (action.type === 'fill') {
          await located.locator.fill(action.value, { timeout: Math.min(2500, this.cfg.navTimeoutMs) });
        } else if (action.type === 'select') {
          await located.locator.selectOption(action.value, { timeout: Math.min(2500, this.cfg.navTimeoutMs) });
        } else if (action.type === 'hover') {
          await located.locator.hover({ timeout: Math.min(2500, this.cfg.navTimeoutMs) });
        }
      } else if (action.type === 'fillForm') {
        // One observation window for the whole form: filling five fields is one step, not five.
        const filled: string[] = [];
        for (const field of action.fields) {
          const located = await this.locate(field.index);
          if (!located) {
            return await this.report(label, {
              snapshotMode: opts.snapshot ?? this.snapshotMode,
              error: `fillForm stopped: no visible control at snapshot index ${field.index} — re-snapshot and use listed indices (filled so far: ${filled.length})`,
            });
          }
          await located.locator.fill(field.value, { timeout: Math.min(2500, this.cfg.navTimeoutMs) });
          filled.push(`[${field.index}]`);
        }
        target = { tag: 'form', name: filled.join(' ') };
      } else if (action.type === 'press') {
        await this.page.keyboard.press(action.key);
      } else if (action.type === 'scroll') {
        await this.page.evaluate(
          ({ dx, dy }) => window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior }),
          { dx: action.dx ?? 0, dy: action.dy ?? 0 },
        );
      } else if (action.type === 'resize') {
        this.viewport = { width: action.width, height: action.height };
        await this.page.setViewportSize(this.viewport);
      } else if (action.type === 'theme') {
        await this.page.emulateMedia({ colorScheme: action.scheme });
      } else if (action.type === 'back') {
        await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs }).catch(() => {});
      } else if (action.type === 'forward') {
        await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs }).catch(() => {});
      } else if (action.type === 'reload') {
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs }).catch(() => {});
      } else if (action.type === 'screenshot') {
        // A deliberate capture rather than an interaction: the agent asked to see the page.
        explicitScreenshot = action.fullPage ? 'full' : 'viewport';
      } else if (action.type === 'wait') {
        await this.page.waitForTimeout(Math.min(action.ms ?? 500, 10000));
      }

      await observeClick(this.page, this.cfg, urlBefore, () => ({
        networkRequests,
        dialogOpened: this.lastDialog !== undefined,
        popupOpened,
      }));
    } catch (err) {
      return await this.report(label, {
        index,
        target,
        error: condenseError(err),
      });
    } finally {
      this.page.off('request', onRequest);
      this.page.off('console', onConsole);
      this.page.off('pageerror', onPageError);
      this.context.off('page', onPopup);
    }

    const domMutationCount = await this.page
      .evaluate(() => {
        const w = window as unknown as { __uicrawl?: { mutations: number } };
        return w.__uicrawl?.mutations ?? 0;
      })
      .catch(() => 0);

    const urlAfter = this.page.url();
    const urlChanged = urlAfter !== urlBefore;
    const signals: Signals = {
      navigated: urlChanged,
      urlChanged,
      domMutated: domMutationCount > 0,
      domMutationCount,
      networkRequests,
      newConsoleMessages,
      consoleErrors,
      dialogOpened: this.lastDialog !== undefined,
      popupOpened,
      // A Playwright-level failure to dispatch (element detached mid-click) is reported as
      // thrown, so a caller is never told "nothing happened" for something that errored.
      clickThrew: false,
    };

    return await this.report(label, {
      index,
      target,
      signals,
      navigated: urlChanged,
      snapshotMode: opts.snapshot ?? this.snapshotMode,
      ...(this.lastDialog ? { dialog: this.lastDialog } : {}),
      ...(explicitScreenshot ? { fullPage: explicitScreenshot === 'full' } : {}),
    });
  }

  /** Capture the current render and return its path relative to `outDir`. */
  async screenshot(fullPage = false): Promise<string> {
    this.step++;
    const rel = path.join('screenshots', `session_${this.id}_${this.step}.png`);
    const abs = path.join(this.outDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    // Marked viewport shots ground the snapshot indices to pixels. Full-page captures
    // skip marking: fixed badges would misplace on a tall render. Either way the badges
    // are gone before this returns — a marked page is never a state the session keeps.
    if (this.markedScreenshots && !fullPage) {
      const marks = await markControls(this.page, this.cap).catch(() => null);
      try {
        await this.page.screenshot({ path: abs, fullPage });
      } finally {
        await marks?.cleanup();
      }
    } else {
      await this.page.screenshot({ path: abs, fullPage });
    }
    return rel;
  }

  /** Absolute filesystem path for a screenshot path this session returned. */
  screenshotPath(rel: string): string {
    return path.resolve(this.outDir, rel);
  }

  /**
   * Capture the context's storage state — cookies plus per-origin localStorage — for
   * reuse as an authenticated context. This is the end of a login flow: unlike the
   * audit sweep, which aborts mutating requests on destructive-looking controls, a login
   * COMMITS its actions. Submitting a form here really submits it; point it at a dev
   * target, not production.
   *
   * With `filePath` the state is written to disk (the `--save-storage` shape); without
   * it the state object is returned for in-process reuse (the `--login` audit shape).
   */
  async saveStorageState(filePath?: string): Promise<StorageStateData> {
    const state = (await this.context.storageState(
      filePath ? { path: filePath } : {},
    ).catch(() => null)) as unknown as StorageStateData | null;
    if (!state) throw new Error('ui-crawl session: could not capture storage state');
    return state;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.page.close().catch(() => {});
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
    await this.staticServer?.close().catch(() => {});
  }

  /**
   * Resolve a snapshot index to a locator. `index` is the element's position in the
   * SNAPSHOT_SELECTOR match list, so `.nth(index)` re-addresses exactly the element the
   * snapshot described — the same key `buildSnapshot` assigns.
   */
  private async locate(
    index: number,
  ): Promise<{ locator: ReturnType<Page['locator']>; tag: string; name: string } | null> {
    if (!Number.isInteger(index) || index < 0) return null;
    const entries = await buildSnapshot(this.page, Number.MAX_SAFE_INTEGER).catch(() => []);
    const entry = entries.find((e) => e.index === index);
    if (!entry) return null;
    return {
      locator: this.page.locator(SNAPSHOT_SELECTOR).nth(entry.index),
      tag: entry.tag,
      name: entry.name,
    };
  }

  /** Assemble the post-action state: verdict, control list, and a picture to look at. */
  private async report(
    label: string,
    extra: Partial<ActionState> & { signals?: Signals; fullPage?: boolean; snapshotMode?: SnapshotMode } = {},
  ): Promise<ActionState> {
    const url = this.page.url();
    const title = await this.page.title().catch(() => '');
    const signals: Signals = extra.signals ?? {
      navigated: false,
      urlChanged: false,
      domMutated: false,
      domMutationCount: 0,
      networkRequests: 0,
      newConsoleMessages: 0,
      consoleErrors: 0,
      dialogOpened: false,
      popupOpened: false,
      clickThrew: false,
    };

    const mode = extra.snapshotMode ?? this.snapshotMode;
    const entries = mode === 'none' ? [] : await this.snapshot().catch(() => []);
    const snapshot =
      mode === 'none'
        ? '(snapshot suppressed for this step)'
        : mode === 'changed'
          ? diffSnapshots(this.lastEntries, entries)
          : formatSnapshot(entries, this.cap);
    // A suppressed step captures nothing, so it must not become the baseline a later
    // delta compares against — that would report the whole list as added.
    if (mode !== 'none') this.lastEntries = entries;
    let screenshot: string | undefined;
    try {
      screenshot = await this.screenshot(extra.fullPage ?? false);
    } catch {
      /* a screenshot is a bonus, never a reason to fail an action */
    }

    return {
      ok: !extra.error,
      action: label,
      ...(extra.index !== undefined ? { index: extra.index } : {}),
      ...(extra.target ? { target: extra.target } : {}),
      url,
      title,
      viewport:
        this.deviceScaleFactor !== 1
          ? { ...this.viewport, deviceScaleFactor: this.deviceScaleFactor }
          : { ...this.viewport },
      navigated: extra.navigated ?? signals.navigated,
      // Without a measured signal, report what the pure classifier makes of it: silence
      // is NOOP, never silently ACTED.
      verdict: classifyChange(signals),
      signals,
      ...(extra.dialog ? { dialog: extra.dialog } : {}),
      snapshot,
      ...(screenshot ? { screenshot } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    };
  }
}

/** Pure: Playwright failures arrive with a 15-line call log; a model needs the verdict. */
export function condenseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split('\n')[0].trim();
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}…` : firstLine;
}

/** Pure: a short, stable description of an action, for logs and transcripts. */
export function describeAction(action: SessionAction): string {
  switch (action.type) {
    case 'click':
      return `click [${action.index}]`;
    case 'fill':
      return `fill [${action.index}]`;
    case 'select':
      return `select [${action.index}]`;
    case 'hover':
      return `hover [${action.index}]`;
    case 'fillForm':
      return `fillForm ${action.fields.map((f) => `[${f.index}]`).join(' ')}`;
    case 'press':
      return `press ${action.key}`;
    case 'scroll':
      return `scroll dy=${action.dy ?? 0}`;
    case 'resize':
      return `resize ${action.width}x${action.height}`;
    case 'theme':
      return `theme ${action.scheme}`;
    case 'wait':
      return `wait ${action.ms ?? 500}ms`;
    case 'screenshot':
      return action.fullPage ? 'screenshot fullPage' : 'screenshot';
    default:
      return action.type;
  }
}

import type { TuiSession } from './tuiSession.js';

export type AnySession = UiSession | TuiSession;

/**
 * A bounded set of live sessions.
 *
 * Each session holds a real browser or terminal process, so an unbounded map would leak
 * processes. The cap is a hard ceiling: opening past it fails loudly rather than evicting
 * a session a caller is still holding an id for.
 */
export class SessionRegistry {
  private sessions = new Map<string, AnySession>();

  constructor(private readonly limit = 4) {}

  add(session: AnySession): void {
    if (this.sessions.size >= this.limit) {
      throw new Error(
        `ui-crawl: ${this.limit} sessions already open — close one before opening another`,
      );
    }
    this.sessions.set(session.id, session);
  }

  get(id: string): AnySession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`ui-crawl: no open session with id "${id}"`);
    return s;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.close().catch(() => {})));
  }
}

export { MUTATION_FLOOR };
