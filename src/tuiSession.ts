import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { TuiBuffer, type TuiControl } from './tuiBuffer.js';
import { TuiProcess, validateTerminalSize, type TuiProcessOptions } from './tuiProcess.js';
import type { ActionState, SessionAction, SnapshotMode } from './session.js';
import type { Signals } from './types.js';

export interface TuiSessionOptions extends TuiProcessOptions {
  outDir?: string;
  cap?: number;
  markedScreenshots?: boolean;
  snapshot?: SnapshotMode;
  interactionTimeoutMs?: number;
}

export type TuiAction =
  | SessionAction
  | { type: 'write'; text: string }
  | { type: 'type'; text: string }
  | { type: 'paste'; text: string };

let tuiSessionCounter = 0;

export class TuiSession {
  readonly id: string;
  readonly type = 'tui' as const;
  private proc: TuiProcess;
  private buffer: TuiBuffer;
  private cols: number;
  private rows: number;
  private outDir: string;
  private cap: number;
  private markedScreenshots: boolean;
  private snapshotMode: SnapshotMode;
  private interactionTimeoutMs: number;
  private commandString: string;

  private browser: Browser | null = null;
  private renderPage: Page | null = null;
  private step = 0;
  private closed = false;
  private lastLines: string[] = [];
  private seenControls: TuiControl[] = [];
  private rawChunks: Buffer[] = [];
  private rawBytes = 0;

  private constructor(args: {
    id: string;
    proc: TuiProcess;
    buffer: TuiBuffer;
    cols: number;
    rows: number;
    outDir: string;
    cap: number;
    markedScreenshots: boolean;
    snapshotMode: SnapshotMode;
    interactionTimeoutMs: number;
    commandString: string;
  }) {
    this.id = args.id;
    this.proc = args.proc;
    this.buffer = args.buffer;
    this.cols = args.cols;
    this.rows = args.rows;
    this.outDir = args.outDir;
    this.cap = args.cap;
    this.markedScreenshots = args.markedScreenshots;
    this.snapshotMode = args.snapshotMode;
    this.interactionTimeoutMs = args.interactionTimeoutMs;
    this.commandString = args.commandString;

    this.buffer.onReply = text => this.proc.write(text);
    this.proc.on('raw-data', (bytes: Buffer) => {
      if (this.rawBytes + bytes.length <= 10 * 1024 * 1024) {
        this.rawChunks.push(Buffer.from(bytes));
        this.rawBytes += bytes.length;
      }
    });
    this.proc.on('data', (chunk: string) => {
      this.buffer.write(chunk);
    });
    this.proc.on('error-data', (chunk: string) => {
      this.buffer.write(chunk);
    });
  }

  static async open(options: TuiSessionOptions): Promise<TuiSession> {
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const buffer = new TuiBuffer(cols, rows);
    const proc = new TuiProcess(options);

    let spawnError: Error | null = null;
    proc.on('error', (err) => {
      spawnError = err;
    });

    const cmdStr = Array.isArray(options.command)
      ? options.command.join(' ')
      : options.command;

    const session = new TuiSession({
      id: `tui_${Date.now().toString(36)}_${(tuiSessionCounter++).toString(36)}`,
      proc,
      buffer,
      cols,
      rows,
      outDir: options.outDir ?? './ui-crawl-out',
      cap: options.cap ?? 80,
      markedScreenshots: options.markedScreenshots ?? true,
      snapshotMode: options.snapshot ?? 'full',
      interactionTimeoutMs: options.interactionTimeoutMs ?? 600,
      commandString: cmdStr,
    });

    // Wait for the TUI to launch and paint its initial screen
    await proc.waitForOutput(session.interactionTimeoutMs, 100);
    if (spawnError) {
      await session.close().catch(() => {});
      throw spawnError;
    }
    session.lastLines = buffer.getLines();
    return session;
  }

  private async ensureRenderer(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    if (!this.renderPage) {
      this.renderPage = await this.browser.newPage({
        viewport: { width: Math.max(800, this.cols * 10 + 64), height: Math.max(600, this.rows * 20 + 96) },
      });
    }
    return this.renderPage;
  }

  get rawText(): string {
    return this.buffer.getScreenText();
  }

  get screenBuffer(): TuiBuffer {
    return this.buffer;
  }

  get terminalCols(): number {
    return this.cols;
  }

  get terminalRows(): number {
    return this.rows;
  }

  get exited(): boolean {
    return this.proc.exited;
  }

  get exitCode(): number | null {
    return this.proc.exitCode;
  }

  get stderrText(): string {
    return this.proc.stderrText;
  }

  get lines(): string[] {
    return this.buffer.getLines();
  }

  get title(): string {
    return this.buffer.title || this.commandString;
  }

  async snapshot(cap = this.cap): Promise<TuiControl[]> {
    this.seenControls = this.buffer.detectControls().slice(0, cap);
    return this.seenControls.map(c => ({ ...c }));
  }

  formatSnapshot(controls = this.buffer.detectControls(), mode: SnapshotMode = this.snapshotMode): string {
    if (mode === 'none') return '(snapshot suppressed for this step)';
    this.seenControls = controls.slice(0, this.cap).map(c => ({ ...c }));

    const currentLines = this.buffer.getLines();
    const ctrlLines: string[] = [];

    for (const ctrl of controls.slice(0, this.cap)) {
      const focusTag = ctrl.focused ? ' (focused)' : '';
      ctrlLines.push(`[${ctrl.index}] ${ctrl.inferred ? "candidate " : ""}${ctrl.kind} "${ctrl.label}" (at row ${ctrl.row}, col ${ctrl.col})${focusTag}`);
    }

    let screenBlock = '';
    if (mode === 'changed') {
      const diff: string[] = [];
      for (let r = 0; r < Math.max(currentLines.length, this.lastLines.length); r++) {
        const cur = currentLines[r] || '';
        const prev = this.lastLines[r] || '';
        if (cur !== prev) {
          diff.push(`~ row ${r}: ${cur}`);
        }
      }
      screenBlock = diff.length > 0 ? diff.join('\n') : '(no lines changed)';
    } else {
      screenBlock = currentLines.join('\n');
    }

    this.lastLines = currentLines;

    const parts: string[] = [];
    if (ctrlLines.length > 0) {
      parts.push(ctrlLines.join('\n'));
      parts.push('--- Terminal Screen ---');
    }
    parts.push(screenBlock);
    return parts.join('\n');
  }

  async screenshot(marked = this.markedScreenshots): Promise<string> {
    this.step++;
    const rel = path.join('screenshots', `session_${this.id}_${this.step}.png`);
    const abs = path.join(this.outDir, rel);
    const controls = this.buffer.detectControls().slice(0, this.cap);
    const html = this.buffer.toHtml({ marked, controls });
    // Freeze text, cursor and ANSI with the rendered grid, before asynchronous I/O.
    const screen = JSON.stringify({ cols: this.cols, rows: this.rows, cursor: { ...this.buffer.cursor }, lines: this.lines,
      renderer: 'ui-crawl terminal cell grid', exitCode: this.exitCode }, null, 2);
    const raw = Buffer.concat(this.rawChunks);
    await mkdir(path.dirname(abs), { recursive: true });
    const page = await this.ensureRenderer();
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await writeFile(path.join(this.outDir, `${this.id}.ansi`), raw);
    await writeFile(path.join(this.outDir, `${this.id}.screen.json`), screen);
    await writeFile(abs.replace(/\.png$/, '.screen.json'), screen);
    const element = page.locator('.term-window');
    await element.screenshot({ path: abs });
    return rel;
  }

  screenshotPath(rel: string): string {
    return path.resolve(this.outDir, rel);
  }

  async act(
    action: TuiAction,
    opts: { snapshot?: SnapshotMode } = {},
  ): Promise<ActionState> {
    if (this.closed) throw new Error('ui-crawl TUI session is closed — open a new one');

    const mode = opts.snapshot ?? this.snapshotMode;
    const label = describeTuiAction(action);
    const cursorBefore = { ...this.buffer.cursor };
    const screenBefore = JSON.stringify(this.buffer.currentGrid);
    const exitedBefore = this.proc.exited;
    this.buffer.resetMutations();

    let target: { tag: string; name: string } | undefined;
    let targetIndex: number | undefined;
    let error: string | undefined;

    try {
      if ('index' in action && action.index !== undefined) {
        const controls = this.buffer.detectControls();
        const seen = this.seenControls.find(c => c.index === action.index);
        const ctrl = seen && controls.find(c => c.row === seen.row && c.col === seen.col && c.kind === seen.kind && c.label === seen.label);
        if (!ctrl) {
          error = `unseen or stale terminal candidate ${action.index} — re-snapshot before acting`;
        } else {
          targetIndex = ctrl.index;
          target = { tag: ctrl.kind, name: ctrl.label };

          if (action.type === 'click') {
            this.mouse(0, ctrl.col, ctrl.row);
            this.mouse(0, ctrl.col, ctrl.row, true);
          } else if (action.type === 'fill') {
            if (!ctrl.focused) throw new Error('Fill requires the currently focused terminal candidate; focus it explicitly first');
            this.typeText(action.value);
          } else {
            throw new Error(`Unsupported indexed terminal action: ${action.type}`);
          }
        }
      } else if (action.type === 'press') {
        const code = keyToAnsi(action.key);
        this.proc.write(code);
      } else if (action.type === 'write') {
        this.proc.write(action.text);
      } else if (action.type === 'type' || action.type === 'paste') {
        this.typeText(action.text);
      } else if (action.type === 'fill') {
        this.typeText(action.value);
      } else if (action.type === 'resize') {
        const newCols =
          'cols' in action && (action as any).cols !== undefined
            ? (action as any).cols
            : 'width' in action && action.width !== undefined
            ? action.width
            : this.cols;
        const newRows =
          'rows' in action && (action as any).rows !== undefined
            ? (action as any).rows
            : 'height' in action && action.height !== undefined
            ? action.height
            : this.rows;
        validateTerminalSize(newCols, newRows);
        this.cols = newCols;
        this.rows = newRows;
        this.buffer.resize(newCols, newRows);
        this.proc.resize(newCols, newRows);
      } else if (action.type === 'scroll') {
        const dx = action.dx ?? 0, dy = action.dy ?? 0;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Wheel steps must be finite');
        for (const [delta, negative, positive] of [[dy, 64, 65], [dx, 66, 67]]) {
          for (let i = 0; i < Math.min(100, Math.ceil(Math.abs(delta))); i++) {
            this.mouse(delta < 0 ? negative : positive, Math.floor(this.cols / 2), Math.floor(this.rows / 2));
          }
        }
      } else if (action.type === 'wait') {
        await new Promise((r) => setTimeout(r, Math.min(action.ms ?? 500, 10000)));
      } else if (action.type === 'screenshot') {
        // Just take screenshot
      } else {
        throw new Error(`Unsupported terminal action: ${action.type}`);
      }

      // Wait for output to settle
      await this.proc.waitForOutput(this.interactionTimeoutMs, 60);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const cursorMoved =
      cursorBefore.x !== this.buffer.cursor.x || cursorBefore.y !== this.buffer.cursor.y;
    const screenMutated = screenBefore !== JSON.stringify(this.buffer.currentGrid);
    const exited = this.proc.exited;

    const signals: Signals = {
      navigated: false,
      urlChanged: false,
      domMutated: screenMutated,
      domMutationCount: screenMutated ? this.buffer.mutations : 0,
      networkRequests: 0,
      newConsoleMessages: this.proc.stderrText ? 1 : 0,
      consoleErrors: this.proc.exitCode !== null && this.proc.exitCode !== 0 ? 1 : 0,
      dialogOpened: this.buffer.bellRung,
      popupOpened: false,
      clickThrew: !!error,
    };

    const acted = screenMutated || cursorMoved || this.buffer.bellRung || (!exitedBefore && exited);
    const verdict = error ? 'INCONCLUSIVE' : acted ? 'ACTED' : 'NOOP';

    let screenshot: string | undefined;
    try {
      screenshot = await this.screenshot();
    } catch (err) {
      error = `Terminal screenshot failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    return {
      ok: !error,
      action: label,
      ...(targetIndex !== undefined ? { index: targetIndex } : {}),
      ...(target ? { target } : {}),
      url: `tui://${this.commandString}`,
      title: this.title,
      viewport: { width: this.cols, height: this.rows },
      navigated: false,
      verdict: error ? 'INCONCLUSIVE' : verdict,
      signals,
      snapshot: this.formatSnapshot(this.buffer.detectControls(), mode),
      ...(screenshot ? { screenshot } : {}),
      ...(error ? { error } : {}),
    };
  }

  private typeText(text: string): void {
    if (this.buffer.bracketedPaste) {
      this.proc.write(`\x1b[200~${text}\x1b[201~`);
    } else {
      if (/[\r\n]/.test(text)) throw new Error('Multiline paste requires bracketed-paste mode; use explicit key actions for submission');
      this.proc.write(text);
    }
  }

  private mouse(button: number, col: number, row: number, release = false): void {
    if (!this.buffer.mouseTracking) throw new Error('The application has not enabled terminal mouse input');
    if (this.buffer.sgrMouse) this.proc.write(`\x1b[<${button};${col + 1};${row + 1}${release ? 'm' : 'M'}`);
    else {
      if (col >= 223 || row >= 223) throw new Error('Coordinates exceed legacy terminal mouse limits');
      this.proc.write('\x1b[M' + String.fromCharCode(32 + (release ? 3 : button), col + 33, row + 33));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.proc.close();
    await this.renderPage?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.renderPage = null;
    this.browser = null;
  }
}

export function keyToAnsi(key: string): string {
  const parts = key.replace(/^(control)(?=[+-])/i, 'Ctrl').split(/[+-](?=.)/);
  const base = parts.pop()!;
  const modifiers = new Set(parts.map(p => p.toLowerCase()));
  if ([...modifiers].some(p => !['ctrl', 'control', 'alt', 'meta', 'shift'].includes(p))) throw new Error(`Unsupported terminal key: ${key}`);
  const ctrl = modifiers.has('ctrl') || modifiers.has('control');
  const alt = modifiers.has('alt') || modifiers.has('meta');
  const shift = modifiers.has('shift');
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const k = base.toLowerCase();
  const arrows: Record<string, string> = { arrowup: 'A', up: 'A', arrowdown: 'B', down: 'B', arrowright: 'C', right: 'C', arrowleft: 'D', left: 'D', home: 'H', end: 'F' };
  if (arrows[k]) return modifier === 1 ? `\x1b[${arrows[k]}` : `\x1b[1;${modifier}${arrows[k]}`;
  const navigation: Record<string, number> = { pageup: 5, pagedown: 6, insert: 2, delete: 3 };
  if (navigation[k]) return `\x1b[${navigation[k]}${modifier === 1 ? '' : `;${modifier}`}~`;
  if (k === 'tab' && shift && modifier === 2) return '\x1b[Z';
  if (ctrl) {
    if (/^[a-z]$/.test(k)) return (alt ? '\x1b' : '') + String.fromCharCode(k.charCodeAt(0) - 96);
    const controls: Record<string, string> = { space: '\x00', '@': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f', '?': '\x7f' };
    if (controls[k] !== undefined) return (alt ? '\x1b' : '') + controls[k];
    throw new Error(`Unsupported terminal key: ${key}`);
  }
  const named: Record<string, string> = { enter: '\r', return: '\r', escape: '\x1b', esc: '\x1b', tab: '\t', backspace: '\x7f', space: ' ' };
  if (named[k]) return (alt ? '\x1b' : '') + named[k];
  const fn = /^f([1-9]|1[0-2])$/.exec(k);
  if (fn) {
    const n = Number(fn[1]);
    if (n <= 4) return modifier === 1 ? `\x1bO${'PQRS'[n - 1]}` : `\x1b[1;${modifier}${'PQRS'[n - 1]}`;
    const num = [15, 17, 18, 19, 20, 21, 23, 24][n - 5];
    return `\x1b[${num}${modifier === 1 ? '' : `;${modifier}`}~`;
  }
  if ([...base].length === 1) return (alt ? '\x1b' : '') + (shift ? base.toUpperCase() : base);
  throw new Error(`Unsupported terminal key: ${key}`);
}

export function describeTuiAction(action: TuiAction): string {
  switch (action.type) {
    case 'press':
      return `press ${action.key}`;
    case 'write':
    case 'type':
      return `type "${(action as any).text}"`;
    case 'fill':
      return `fill "${action.value}"`;
    case 'click':
      return `click [${action.index}]`;
    case 'resize':
      return `resize ${'cols' in action ? (action as any).cols : action.width}x${'rows' in action ? (action as any).rows : action.height}`;
    case 'wait':
      return `wait ${action.ms ?? 500}ms`;
    case 'screenshot':
      return 'screenshot';
    default:
      return (action as any).type;
  }
}
