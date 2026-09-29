import { performance } from 'node:perf_hooks';
import type { TuiSession } from './tuiSession.js';
import { measureTuiSpacing, validateTextList, validateTerminalRect, validateTuiSpacingSpecs, type TerminalRect, type TuiSpacingSpec } from './tuiSpacing.js';

export interface TuiCheckOptions {
  /** Readiness is separate from the assertions: do not wait for broken spacing to pass. */
  readyText?: string[];
  timeoutMs?: number;
  requiredText?: string[];
  absentText?: string[];
  spacing?: TuiSpacingSpec[];
}

export interface TuiObserveOptions {
  durationMs: number;
  intervalMs?: number;
  /** Restrict observations to content so a spinner cannot stand in for streamed text. */
  bounds?: TerminalRect;
  sequence?: Array<{ name: string; text: string; absentText?: string[] }>;
}

function object(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TUI check options must be an object');
}

function milliseconds(n: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
}

export function validateTuiCheck(options: TuiCheckOptions): void {
  object(options);
  for (const key of ['readyText', 'requiredText', 'absentText'] as const) {
    if (options[key] !== undefined) validateTextList(options[key], key);
  }
  milliseconds(options.timeoutMs ?? 3000, 'timeoutMs', 0, 10000);
  if (options.spacing !== undefined) validateTuiSpacingSpecs(options.spacing);
  if (!options.spacing?.length && !options.requiredText?.length && !options.absentText?.length) throw new Error('TUI check requires spacing, requiredText, or absentText assertions');
}

export function validateTuiObserve(options: TuiObserveOptions): void {
  object(options);
  milliseconds(options.durationMs, 'durationMs', 1, 10000);
  milliseconds(options.intervalMs ?? 40, 'intervalMs', 10, 1000);
  if (options.bounds !== undefined) validateTerminalRect(options.bounds);
  if (options.sequence !== undefined) {
    if (!Array.isArray(options.sequence) || !options.sequence.length) throw new Error('sequence must be a nonempty array');
    for (const item of options.sequence) {
      if (!item || typeof item.name !== 'string' || !item.name.trim() || typeof item.text !== 'string' || !item.text.length) throw new Error('sequence entries require name and text');
      if (item.absentText !== undefined) validateTextList(item.absentText, 'sequence absentText');
    }
  }
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Read-only, explicit assertions. These are not heuristic defect/taste findings. */
export async function checkTui(session: TuiSession, options: TuiCheckOptions) {
  validateTuiCheck(options);
  const started = performance.now();
  const missingReady = () => (options.readyText ?? []).filter(text => !session.rawText.includes(text));
  while (missingReady().length && !session.exited && performance.now() - started < (options.timeoutMs ?? 3000)) {
    await pause(Math.min(25, Math.max(1, (options.timeoutMs ?? 3000) - (performance.now() - started))));
  }
  const missingReadyText = missingReady();
  const text = session.rawText;
  const measurements = options.spacing ? measureTuiSpacing(session.screenBuffer, options.spacing) : [];
  const violations = missingReadyText.map(value => `readiness text missing: ${value}`);
  for (const value of options.requiredText ?? []) if (!text.includes(value)) violations.push(`required text missing: ${value}`);
  for (const value of options.absentText ?? []) if (text.includes(value)) violations.push(`unexpected text present: ${value}`);
  for (const result of measurements) violations.push(...result.violations.map(v => `${result.name}: ${v}`));
  const exitCode = session.exitCode;
  if (exitCode !== null && exitCode !== 0) violations.push(`process exited with code ${exitCode}`);
  const viewport = { cols: session.terminalCols, rows: session.terminalRows };
  let screenshot: string | undefined;
  try { screenshot = await session.screenshot(false); }
  catch (error) { violations.push(`screenshot failed: ${error instanceof Error ? error.message : String(error)}`); }
  return { kind: 'tui-check' as const, passed: violations.length === 0, ready: !missingReadyText.length, missingReadyText, viewport, exitCode, text, measurements, violations, screenshot };
}

/** Sample visible text over time; raw repaint/cursor counts do not prove streaming.
 * Ordered milestones must occur in different changed samples. Use absentText to
 * require partial content before completion. This proves only observed UI text,
 * not provider execution or clipboard integration.
 */
export async function observeTui(session: TuiSession, options: TuiObserveOptions) {
  validateTuiObserve(options);
  const bounds = options.bounds;
  const read = () => {
    if (!bounds) return session.rawText;
    if (bounds.row + bounds.rows > session.terminalRows || bounds.col + bounds.cols > session.terminalCols) throw new Error('observation bounds extend outside terminal viewport');
    return session.screenBuffer.currentGrid.slice(bounds.row, bounds.row + bounds.rows)
      .map(row => row.slice(bounds.col, bounds.col + bounds.cols).map(cell => cell.char).join('').trimEnd()).join('\n');
  };
  const started = performance.now();
  const frames: Array<{ atMs: number; text: string }> = [];
  const sequence = (options.sequence ?? []).map(item => ({ ...item, seenAtMs: null as number | null }));
  let next = 0, bytes = 0, truncated = false;
  while (true) {
    const text = read();
    const atMs = Math.round(performance.now() - started);
    if (!frames.length || text !== frames[frames.length - 1].text) {
      bytes += Buffer.byteLength(text);
      if (bytes > 2 * 1024 * 1024 || frames.length >= 1000) { truncated = true; break; }
      frames.push({ atMs, text });
      const target = sequence[next];
      if (target && text.includes(target.text) && !(target.absentText ?? []).some(value => text.includes(value))) {
        target.seenAtMs = atMs;
        next++;
      }
    }
    const remaining = options.durationMs - (performance.now() - started);
    if (remaining <= 0 || session.exited) break;
    await pause(Math.min(options.intervalMs ?? 40, remaining));
  }
  const violations = sequence.filter(item => item.seenAtMs === null).map(item => `milestone not observed in order: ${item.name}`);
  if (truncated) violations.push('observation exceeded evidence limit; timeline is incomplete');
  const exitCode = session.exitCode;
  if (exitCode !== null && exitCode !== 0) violations.push(`process exited with code ${exitCode}`);
  return {
    kind: 'tui-observation' as const,
    passed: violations.length ? false : sequence.length ? true : null,
    elapsedMs: Math.round(performance.now() - started), intervalMs: options.intervalMs ?? 40,
    changedFrames: Math.max(0, frames.length - 1), bounds, frames, sequence, exitCode, truncated, violations,
  };
}
