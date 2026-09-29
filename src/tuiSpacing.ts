import type { TuiBuffer } from './tuiBuffer.js';

export interface TerminalRect { row: number; col: number; rows: number; cols: number }
export interface TerminalPadding { top: number; right: number; bottom: number; left: number }
/** Caller-supplied surface identity avoids guessing an editor from arbitrary prose. */
export interface TuiSpacingSpec {
  name: string;
  bounds?: TerminalRect;
  /** Locate the painted surface by its exact background color. */
  background?: string;
  minRows?: number;
  minCols?: number;
  minPadding?: Partial<TerminalPadding>;
  minGapBefore?: number;
  /** Upper bound for grouping related content without excess whitespace. */
  maxGapBefore?: number;
  requiredText?: string[];
}
export interface TuiSpacingMeasurement {
  name: string;
  found: boolean;
  bounds?: TerminalRect;
  padding?: TerminalPadding;
  gapBefore?: number;
  text?: string;
  passed: boolean;
  violations: string[];
}

/** Validate external CLI/MCP contracts before launching or touching a session. */
export function validateTuiSpacingSpecs(value: unknown): asserts value is TuiSpacingSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('spacing must be a nonempty array');
  const names = new Set<string>();
  for (const spec of value) {
    if (!spec || typeof spec !== 'object' || typeof spec.name !== 'string' || !spec.name.trim()) throw new Error('spacing requires a surface name');
    if (names.has(spec.name)) throw new Error(`duplicate spacing surface: ${spec.name}`);
    names.add(spec.name);
    if (!!spec.bounds === !!spec.background) throw new Error(`${spec.name}: provide exactly one of bounds or background`);
    if (spec.background !== undefined && (typeof spec.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(spec.background))) throw new Error(`${spec.name}: background must be #rrggbb`);
    if (spec.bounds !== undefined) validateTerminalRect(spec.bounds);
    for (const key of ['minRows', 'minCols', 'minGapBefore', 'maxGapBefore'] as const) {
      if (spec[key] !== undefined && (!Number.isInteger(spec[key]) || spec[key] < 0)) throw new Error(`${spec.name}: ${key} must be a nonnegative integer`);
    }
    if (spec.minGapBefore !== undefined && spec.maxGapBefore !== undefined && spec.minGapBefore > spec.maxGapBefore) throw new Error(`${spec.name}: minGapBefore exceeds maxGapBefore`);
    if (spec.minPadding !== undefined) {
      if (!spec.minPadding || typeof spec.minPadding !== 'object' || Array.isArray(spec.minPadding)) throw new Error(`${spec.name}: minPadding must be an object`);
      for (const [key, n] of Object.entries(spec.minPadding)) {
        if (!['top', 'right', 'bottom', 'left'].includes(key) || !Number.isInteger(n) || (n as number) < 0) throw new Error(`${spec.name}: invalid padding ${key}`);
      }
    }
    if (spec.requiredText !== undefined) validateTextList(spec.requiredText, 'requiredText');
  }
}

export function validateTextList(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(s => typeof s !== 'string' || !s.length)) throw new Error(`${label} must be an array of nonempty strings`);
}

export function validateTerminalRect(rect: TerminalRect): void {
  if (!rect || ![rect.row, rect.col, rect.rows, rect.cols].every(Number.isInteger) || rect.row < 0 || rect.col < 0 || rect.rows < 1 || rect.cols < 1) throw new Error('bounds require nonnegative integer row/col and positive rows/cols');
}

/** Measure explicit UI spacing contracts in terminal cells, not CSS pixels.
 * This returns measurements, not a defect/taste reclassification. A blank row in
 * code or a paragraph is not evidence of a layout bug without an explicit target.
 */
export function measureTuiSpacing(buffer: TuiBuffer, specs: TuiSpacingSpec[]): TuiSpacingMeasurement[] {
  validateTuiSpacingSpecs(specs);
  const grid = buffer.currentGrid;
  return specs.map(spec => {
    const violations: string[] = [];
    let bounds = spec.bounds;
    if (!bounds && spec.background) {
      let top = buffer.rows, left = buffer.cols, bottom = -1, right = -1, count = 0;
      for (let r = 0; r < buffer.rows; r++) for (let c = 0; c < buffer.cols; c++) {
        if (grid[r][c].bg.toLowerCase() === spec.background.toLowerCase()) {
          top = Math.min(top, r); left = Math.min(left, c);
          bottom = Math.max(bottom, r); right = Math.max(right, c); count++;
        }
      }
      if (count) {
        bounds = { row: top, col: left, rows: bottom - top + 1, cols: right - left + 1 };
        if (count !== bounds.rows * bounds.cols) return { name: spec.name, found: true, bounds, passed: false, violations: ['background does not identify one solid rectangular surface; supply explicit bounds'] };
      }
    }
    if (!bounds) return { name: spec.name, found: false, passed: false, violations: ['surface not found'] };
    const { row, col, rows, cols } = bounds;
    if (![row, col, rows, cols].every(Number.isInteger) || row < 0 || col < 0 || rows < 1 || cols < 1 || row + rows > buffer.rows || col + cols > buffer.cols) {
      return { name: spec.name, found: true, bounds, passed: false, violations: ['surface extends outside terminal viewport'] };
    }
    let top = row + rows, bottom = row - 1, left = col + cols, right = col;
    const lines: string[] = [];
    for (let r = row; r < row + rows; r++) {
      lines.push(grid[r].slice(col, col + cols).map(cell => cell.char).join('').trimEnd());
      for (let c = col; c < col + cols; c++) if (grid[r][c].char.trim()) {
        top = Math.min(top, r); bottom = Math.max(bottom, r);
        left = Math.min(left, c); right = Math.max(right, c + (grid[r][c].width ?? 1));
      }
    }
    const padding = bottom >= row ? {
      top: top - row, bottom: row + rows - 1 - bottom,
      left: left - col, right: col + cols - right,
    } : { top: rows, bottom: rows, left: cols, right: cols };
    let gapBefore = 0;
    for (let r = row - 1; r >= 0; r--) {
      if (grid[r].slice(col, col + cols).some(cell => cell.char.trim())) break;
      gapBefore++;
    }
    if (rows < (spec.minRows ?? 0)) violations.push(`height ${rows} rows < ${spec.minRows}`);
    if (cols < (spec.minCols ?? 0)) violations.push(`width ${cols} columns < ${spec.minCols}`);
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      if (padding[side] < (spec.minPadding?.[side] ?? 0)) violations.push(`${side} padding ${padding[side]} cells < ${spec.minPadding![side]}`);
    }
    if (gapBefore < (spec.minGapBefore ?? 0)) violations.push(`preceding gap ${gapBefore} rows < ${spec.minGapBefore}`);
    if (spec.maxGapBefore !== undefined && gapBefore > spec.maxGapBefore) violations.push(`preceding gap ${gapBefore} rows > ${spec.maxGapBefore}`);
    const text = lines.join('\n');
    for (const expected of spec.requiredText ?? []) if (!text.includes(expected)) violations.push(`required text missing: ${expected}`);
    return { name: spec.name, found: true, bounds, padding, gapBefore, text, passed: violations.length === 0, violations };
  });
}
