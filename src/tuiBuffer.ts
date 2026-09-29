import { contrastRatio, relativeLuminance, suggestAccessibleColor } from './colors.js';

export interface TuiCell {
  char: string;
  /** 0 marks a continuation cell; 2 marks a wide grapheme. */
  width?: number;
  fg: string;
  bg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface TuiControl {
  index: number;
  kind: 'button' | 'checkbox' | 'radio' | 'input' | 'menu-item' | 'focus';
  label: string;
  row: number; // 0-indexed
  col: number; // 0-indexed
  width: number;
  focused?: boolean;
  inferred?: boolean;
}

export interface TuiContrastFinding {
  row: number;
  col: number;
  char: string;
  fg: string;
  bg: string;
  ratio: number;
  suggestedFg?: string;
  severity: 'high' | 'medium' | 'low';
}

const DEFAULT_FG = '#e5e5e5';
const DEFAULT_BG = '#1e1e1e';

const ANSI_16_COLORS: string[] = [
  '#000000', // 0: Black
  '#cd0000', // 1: Red
  '#00cd00', // 2: Green
  '#cdcd00', // 3: Yellow
  '#0000ee', // 4: Blue
  '#cd00cd', // 5: Magenta
  '#00cdcd', // 6: Cyan
  '#e5e5e5', // 7: White
  '#7f7f7f', // 8: Bright Black (Gray)
  '#ff0000', // 9: Bright Red
  '#00ff00', // 10: Bright Green
  '#ffff00', // 11: Bright Yellow
  '#5c5cff', // 12: Bright Blue
  '#ff00ff', // 13: Bright Magenta
  '#00ffff', // 14: Bright Cyan
  '#ffffff', // 15: Bright White
];

function ansi256ToHex(n: number): string {
  if (n >= 0 && n < 16) return ANSI_16_COLORS[n];
  if (n >= 16 && n <= 231) {
    const idx = n - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const r = levels[Math.floor(idx / 36)];
    const g = levels[Math.floor((idx % 36) / 6)];
    const b = levels[idx % 6];
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  if (n >= 232 && n <= 255) {
    const v = 8 + (n - 232) * 10;
    const hex = v.toString(16).padStart(2, '0');
    return `#${hex}${hex}${hex}`;
  }
  return DEFAULT_FG;
}

function emptyCell(): TuiCell {
  return {
    char: ' ',
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function getCharWidth(codePoint: number): number {
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  // Combining characters / zero-width
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  // East Asian Wide / Fullwidth / Emojis
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
function graphemeWidth(text: string): number {
  if (/\p{Emoji_Presentation}|\uFE0F/u.test(text)) return 2;
  return Math.max(0, ...Array.from(text, char => /\p{Mark}/u.test(char) ? 0 : getCharWidth(char.codePointAt(0)!)));
}

export class TuiBuffer {
  cols: number;
  rows: number;
  cursor = { x: 0, y: 0, visible: true };
  private savedCursor = { x: 0, y: 0 };
  private currentStyle = {
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };

  private primaryGrid: TuiCell[][];
  private altGrid: TuiCell[][];
  private isAlt = false;
  private pending = '';
  title = '';
  bellRung = false;
  mouseTracking = false;
  sgrMouse = false;
  bracketedPaste = false;
  autoWrap = true;
  onReply?: (text: string) => void;
  private lastGlyph: { row: number; col: number } | null = null;
  mutations = 0;

  constructor(cols = 80, rows = 24) {
    this.cols = Math.max(10, cols);
    this.rows = Math.max(4, rows);
    this.primaryGrid = this.createEmptyGrid();
    this.altGrid = this.createEmptyGrid();
  }

  private createEmptyGrid(): TuiCell[][] {
    const grid: TuiCell[][] = [];
    for (let r = 0; r < this.rows; r++) {
      const row: TuiCell[] = [];
      for (let c = 0; c < this.cols; c++) {
        row.push(emptyCell());
      }
      grid.push(row);
    }
    return grid;
  }

  get currentGrid(): TuiCell[][] {
    return this.isAlt ? this.altGrid : this.primaryGrid;
  }

  resetMutations(): void {
    this.mutations = 0;
    this.bellRung = false;
  }

  resize(newCols: number, newRows: number): void {
    const cols = Math.max(10, newCols);
    const rows = Math.max(4, newRows);
    if (cols === this.cols && rows === this.rows) return;

    const resizeGrid = (oldGrid: TuiCell[][]): TuiCell[][] => {
      const newGrid: TuiCell[][] = [];
      for (let r = 0; r < rows; r++) {
        const row: TuiCell[] = [];
        for (let c = 0; c < cols; c++) {
          if (r < oldGrid.length && c < oldGrid[r].length) {
            row.push({ ...oldGrid[r][c] });
          } else {
            row.push(emptyCell());
          }
        }
        newGrid.push(row);
      }
      return newGrid;
    };

    this.primaryGrid = resizeGrid(this.primaryGrid);
    this.altGrid = resizeGrid(this.altGrid);
    this.cols = cols;
    this.rows = rows;
    this.cursor.x = Math.min(this.cols - 1, this.cursor.x);
    this.cursor.y = Math.min(this.rows - 1, this.cursor.y);
    this.mutations++;
  }

  write(chunk: string): void {
    const data = this.pending + chunk;
    this.pending = '';
    let i = 0;
    const len = data.length;

    while (i < len) {
      const ch = data[i];

      // Escape sequence
      if (ch === '\x1b') {
        this.lastGlyph = null;
        if (i + 1 >= len) {
          this.pending = data.slice(i);
          break;
        }

        const next = data[i + 1];
        if (next === '[') {
          // CSI sequence: ESC [ ... [final char in 0x40-0x7E]
          let j = i + 2;
          while (j < len && data.charCodeAt(j) >= 0x30 && data.charCodeAt(j) <= 0x3f) {
            j++;
          }
          while (j < len && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x2f) {
            j++;
          }
          if (j >= len) {
            // Sequence is incomplete across chunk boundary: save and wait for next chunk
            this.pending = data.slice(i);
            break;
          }
          const finalChar = data[j];
          if (data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e) {
            const paramStr = data.slice(i + 2, j);
            this.handleCsi(paramStr, finalChar);
            i = j + 1;
            continue;
          }
        } else if (next === ']') {
          // OSC sequence: ESC ] ... (ST or BEL)
          let j = i + 2;
          let terminated = false;
          while (j < len) {
            if (data[j] === '\x07') {
              this.handleOsc(data.slice(i + 2, j));
              j++;
              terminated = true;
              break;
            }
            if (data[j] === '\x1b' && j + 1 < len && data[j + 1] === '\\') {
              this.handleOsc(data.slice(i + 2, j));
              j += 2;
              terminated = true;
              break;
            }
            j++;
          }
          if (!terminated) {
            this.pending = data.slice(i);
            break;
          }
          i = j;
          continue;
        } else if (next === '7') {
          this.savedCursor = { x: this.cursor.x, y: this.cursor.y };
          i += 2;
          continue;
        } else if (next === '8') {
          this.cursor.x = Math.min(this.cols - 1, this.savedCursor.x);
          this.cursor.y = Math.min(this.rows - 1, this.savedCursor.y);
          i += 2;
          continue;
        }
        // Unrecognized escape: skip ESC
        i++;
        continue;
      }

      // Control characters
      if (ch === '\r') {
        this.lastGlyph = null;
        this.cursor.x = 0;
        i++;
        continue;
      }
      if (ch === '\n') {
        this.lastGlyph = null;
        this.lineFeed();
        i++;
        continue;
      }
      if (ch === '\b') {
        this.lastGlyph = null;
        this.cursor.x = Math.max(0, this.cursor.x - 1);
        i++;
        continue;
      }
      if (ch === '\t') {
        this.lastGlyph = null;
        const nextStop = Math.min(this.cols - 1, (Math.floor(this.cursor.x / 8) + 1) * 8);
        while (this.cursor.x < nextStop) {
          this.setCell(this.cursor.y, this.cursor.x, ' ');
          this.cursor.x++;
        }
        i++;
        continue;
      }
      if (ch === '\x07') {
        this.bellRung = true;
        this.mutations++;
        i++;
        continue;
      }

      // Check for trailing high surrogate without low surrogate at chunk boundary
      const codeUnit = data.charCodeAt(i);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        if (i + 1 >= len) {
          this.pending = data.slice(i);
          break;
        }
      }

      // Unicode printable character handling with surrogate pairs and wide chars
      const codePoint = data.codePointAt(i);
      if (codePoint !== undefined && codePoint >= 32) {
        const charStr = String.fromCodePoint(codePoint);
        const charLen = charStr.length;
        const previous = this.lastGlyph;
        if (previous) {
          const cell = this.currentGrid[previous.row]?.[previous.col];
          if (cell && [...graphemes.segment(cell.char + charStr)].length === 1) {
            const combined = cell.char + charStr;
            const width = graphemeWidth(combined);
            const oldWidth = cell.width ?? 1;
            cell.char = combined;
            cell.width = width;
            if (width > oldWidth && previous.col + 1 < this.cols) {
              this.currentGrid[previous.row][previous.col + 1] = { ...cell, char: '', width: 0 };
            }
            this.cursor.x += width - oldWidth;
            this.mutations++;
            i += charLen;
            continue;
          }
        }
        const w = graphemeWidth(charStr);
        if (w > 0) {
          if (this.cursor.x + w > this.cols) {
            if (this.autoWrap) { this.cursor.x = 0; this.lineFeed(); }
            else this.cursor.x = Math.max(0, this.cols - w);
          }
          const row = this.cursor.y, col = this.cursor.x;
          this.setCell(row, col, charStr, w);
          if (w === 2 && col + 1 < this.cols) {
            this.currentGrid[row][col + 1] = { ...this.currentGrid[row][col], char: '', width: 0 };
          }
          this.lastGlyph = { row, col };
          this.cursor.x += w;
        }
        i += charLen;
        continue;
      }

      i++;
    }
  }

  private lineFeed(): void {
    if (this.cursor.y < this.rows - 1) {
      this.cursor.y++;
    } else {
      // Scroll up
      const grid = this.currentGrid;
      grid.shift();
      const newRow: TuiCell[] = [];
      for (let c = 0; c < this.cols; c++) newRow.push(emptyCell());
      grid.push(newRow);
      this.mutations++;
    }
  }

  private setCell(r: number, c: number, char: string, width = 1): void {
    if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) return;
    const grid = this.currentGrid;
    const prev = grid[r][c];
    if (prev.width === 0 && c > 0) grid[r][c - 1] = emptyCell();
    if (prev.width === 2 && c + 1 < this.cols) grid[r][c + 1] = emptyCell();
    if (
      prev.char !== char ||
      (prev.width ?? 1) !== width ||
      prev.fg !== this.currentStyle.fg ||
      prev.bg !== this.currentStyle.bg ||
      prev.bold !== this.currentStyle.bold ||
      prev.dim !== this.currentStyle.dim ||
      prev.underline !== this.currentStyle.underline ||
      prev.inverse !== this.currentStyle.inverse
    ) {
      grid[r][c] = {
        char, width,
        fg: this.currentStyle.fg,
        bg: this.currentStyle.bg,
        bold: this.currentStyle.bold,
        dim: this.currentStyle.dim,
        italic: this.currentStyle.italic,
        underline: this.currentStyle.underline,
        inverse: this.currentStyle.inverse,
      };
      this.mutations++;
    }
  }

  private handleCsi(params: string, finalChar: string): void {
    const isPrivate = params.startsWith('?');
    const cleanParams = isPrivate ? params.slice(1) : params;
    const args = cleanParams.length > 0 ? cleanParams.split(';').map((v) => parseInt(v, 10)) : [];
    const arg0 = Number.isNaN(args[0]) || args[0] === undefined ? 1 : args[0];

    switch (finalChar) {
      case 'A': // Cursor Up
        this.cursor.y = Math.max(0, this.cursor.y - Math.max(1, arg0));
        break;
      case 'B': // Cursor Down
        this.cursor.y = Math.min(this.rows - 1, this.cursor.y + Math.max(1, arg0));
        break;
      case 'C': // Cursor Forward
        this.cursor.x = Math.min(this.cols - 1, this.cursor.x + Math.max(1, arg0));
        break;
      case 'D': // Cursor Back
        this.cursor.x = Math.max(0, this.cursor.x - Math.max(1, arg0));
        break;
      case 'E': // Cursor Next Line
        this.cursor.x = 0;
        this.cursor.y = Math.min(this.rows - 1, this.cursor.y + Math.max(1, arg0));
        break;
      case 'F': // Cursor Previous Line
        this.cursor.x = 0;
        this.cursor.y = Math.max(0, this.cursor.y - Math.max(1, arg0));
        break;
      case 'G': // Cursor Horizontal Absolute
        this.cursor.x = Math.max(0, Math.min(this.cols - 1, arg0 - 1));
        break;
      case 'H':
      case 'f': {
        // Cursor Position: [row;col]
        const r = Number.isNaN(args[0]) || args[0] === 0 || args[0] === undefined ? 1 : args[0];
        const c = Number.isNaN(args[1]) || args[1] === 0 || args[1] === undefined ? 1 : args[1];
        this.cursor.y = Math.max(0, Math.min(this.rows - 1, r - 1));
        this.cursor.x = Math.max(0, Math.min(this.cols - 1, c - 1));
        break;
      }
      case 'J': // Erase in Display
        this.eraseInDisplay(Number.isNaN(args[0]) || args[0] === undefined ? 0 : args[0]);
        break;
      case 'K': // Erase in Line
        this.eraseInLine(Number.isNaN(args[0]) || args[0] === undefined ? 0 : args[0]);
        break;
      case 'L': // Insert Line
        this.insertLines(Math.max(1, arg0));
        break;
      case 'M': // Delete Line
        this.deleteLines(Math.max(1, arg0));
        break;
      case 'P': // Delete Character
        this.deleteCharacters(Math.max(1, arg0));
        break;
      case '@': // Insert Character
        this.insertCharacters(Math.max(1, arg0));
        break;
      case 'X': // Erase Character
        this.eraseCharacters(Math.max(1, arg0));
        break;
      case 'd': // Line Position Absolute
        this.cursor.y = Math.max(0, Math.min(this.rows - 1, arg0 - 1));
        break;
      case 't': {
        // Window manipulation: 8;rows;cols t -> resize text area
        if (args[0] === 8 && args.length >= 3) {
          const r = args[1];
          const c = args[2];
          if (!Number.isNaN(r) && !Number.isNaN(c) && r >= 4 && c >= 10) {
            this.resize(c, r);
          }
        }
        break;
      }
      case 'h': // Set Mode
        if (isPrivate) {
          if (arg0 === 7) this.autoWrap = true;
          if (arg0 === 2004) this.bracketedPaste = true;
          if (arg0 === 1006) this.sgrMouse = true;
          if (arg0 === 25) this.cursor.visible = true;
          if (arg0 === 1049 || arg0 === 47) {
            this.isAlt = true;
            this.mutations++;
          }
          if (arg0 === 1000 || arg0 === 1002 || arg0 === 1003) {
            this.mouseTracking = true;
          }
        }
        break;
      case 'l': // Reset Mode
        if (isPrivate) {
          if (arg0 === 7) this.autoWrap = false;
          if (arg0 === 2004) this.bracketedPaste = false;
          if (arg0 === 1006) this.sgrMouse = false;
          if (arg0 === 25) this.cursor.visible = false;
          if (arg0 === 1049 || arg0 === 47) {
            this.isAlt = false;
            this.mutations++;
          }
          if (arg0 === 1000 || arg0 === 1002 || arg0 === 1003) {
            this.mouseTracking = false;
          }
        }
        break;
      case 'n':
        if (arg0 === 6) this.onReply?.(`\x1b[${this.cursor.y + 1};${Math.min(this.cols, this.cursor.x + 1)}R`);
        break;
      case 'c':
        this.onReply?.('\x1b[?1;2c');
        break;
      case 'm': // SGR
        this.handleSgr(args);
        break;
      case 's': // Save Cursor
        this.savedCursor = { x: this.cursor.x, y: this.cursor.y };
        break;
      case 'u': // Restore Cursor
        this.cursor.x = Math.min(this.cols - 1, this.savedCursor.x);
        this.cursor.y = Math.min(this.rows - 1, this.savedCursor.y);
        break;
    }
  }

  private handleSgr(args: number[]): void {
    if (args.length === 0) {
      this.resetStyle();
      return;
    }

    for (let i = 0; i < args.length; i++) {
      const code = Number.isNaN(args[i]) ? 0 : args[i];

      if (code === 0) {
        this.resetStyle();
      } else if (code === 1) {
        this.currentStyle.bold = true;
      } else if (code === 2) {
        this.currentStyle.dim = true;
      } else if (code === 3) {
        this.currentStyle.italic = true;
      } else if (code === 4) {
        this.currentStyle.underline = true;
      } else if (code === 7) {
        this.currentStyle.inverse = true;
      } else if (code === 22) {
        this.currentStyle.bold = false;
        this.currentStyle.dim = false;
      } else if (code === 23) {
        this.currentStyle.italic = false;
      } else if (code === 24) {
        this.currentStyle.underline = false;
      } else if (code === 27) {
        this.currentStyle.inverse = false;
      } else if (code >= 30 && code <= 37) {
        this.currentStyle.fg = ANSI_16_COLORS[code - 30];
      } else if (code === 39) {
        this.currentStyle.fg = DEFAULT_FG;
      } else if (code >= 40 && code <= 47) {
        this.currentStyle.bg = ANSI_16_COLORS[code - 40];
      } else if (code === 49) {
        this.currentStyle.bg = DEFAULT_BG;
      } else if (code >= 90 && code <= 97) {
        this.currentStyle.fg = ANSI_16_COLORS[code - 90 + 8];
      } else if (code >= 100 && code <= 107) {
        this.currentStyle.bg = ANSI_16_COLORS[code - 100 + 8];
      } else if (code === 38 || code === 48) {
        // Extended color: 38;5;n or 38;2;r;g;b
        const isFg = code === 38;
        const mode = args[i + 1];
        if (mode === 5 && i + 2 < args.length) {
          const color = ansi256ToHex(args[i + 2]);
          if (isFg) this.currentStyle.fg = color;
          else this.currentStyle.bg = color;
          i += 2;
        } else if (mode === 2 && i + 4 < args.length) {
          const r = Math.max(0, Math.min(255, args[i + 2]));
          const g = Math.max(0, Math.min(255, args[i + 3]));
          const b = Math.max(0, Math.min(255, args[i + 4]));
          const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          if (isFg) this.currentStyle.fg = hex;
          else this.currentStyle.bg = hex;
          i += 4;
        }
      }
    }
  }

  private resetStyle(): void {
    this.currentStyle = {
      fg: DEFAULT_FG,
      bg: DEFAULT_BG,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
    };
  }

  private eraseInDisplay(mode: number): void {
    const grid = this.currentGrid;
    if (mode === 2 || mode === 3) {
      // Clear entire screen
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          grid[r][c] = emptyCell();
        }
      }
      this.mutations++;
    } else if (mode === 0) {
      // Clear from cursor to end
      for (let c = this.cursor.x; c < this.cols; c++) grid[this.cursor.y][c] = emptyCell();
      for (let r = this.cursor.y + 1; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) grid[r][c] = emptyCell();
      }
      this.mutations++;
    } else if (mode === 1) {
      // Clear from start to cursor
      for (let r = 0; r < this.cursor.y; r++) {
        for (let c = 0; c < this.cols; c++) grid[r][c] = emptyCell();
      }
      for (let c = 0; c <= this.cursor.x; c++) grid[this.cursor.y][c] = emptyCell();
      this.mutations++;
    }
  }

  private eraseInLine(mode: number): void {
    const row = this.currentGrid[this.cursor.y];
    if (!row) return;
    if (mode === 2) {
      for (let c = 0; c < this.cols; c++) row[c] = emptyCell();
      this.mutations++;
    } else if (mode === 0) {
      for (let c = this.cursor.x; c < this.cols; c++) row[c] = emptyCell();
      this.mutations++;
    } else if (mode === 1) {
      for (let c = 0; c <= this.cursor.x; c++) row[c] = emptyCell();
      this.mutations++;
    }
  }

  private insertLines(n: number): void {
    const grid = this.currentGrid;
    for (let k = 0; k < n; k++) {
      grid.splice(this.cursor.y, 0, Array.from({ length: this.cols }, () => emptyCell()));
      grid.pop();
    }
    this.mutations++;
  }

  private deleteLines(n: number): void {
    const grid = this.currentGrid;
    for (let k = 0; k < n; k++) {
      if (this.cursor.y < grid.length) {
        grid.splice(this.cursor.y, 1);
        grid.push(Array.from({ length: this.cols }, () => emptyCell()));
      }
    }
    this.mutations++;
  }

  private deleteCharacters(n: number): void {
    const row = this.currentGrid[this.cursor.y];
    if (!row) return;
    row.splice(this.cursor.x, n);
    while (row.length < this.cols) row.push(emptyCell());
    this.mutations++;
  }

  private insertCharacters(n: number): void {
    const row = this.currentGrid[this.cursor.y];
    if (!row) return;
    for (let k = 0; k < n; k++) {
      row.splice(this.cursor.x, 0, emptyCell());
      row.pop();
    }
    this.mutations++;
  }

  private eraseCharacters(n: number): void {
    const row = this.currentGrid[this.cursor.y];
    if (!row) return;
    for (let c = this.cursor.x; c < Math.min(this.cols, this.cursor.x + n); c++) {
      row[c] = emptyCell();
    }
    this.mutations++;
  }

  private handleOsc(cmd: string): void {
    // e.g. 0;Title or 2;Title
    const parts = cmd.split(';');
    if ((parts[0] === '10' || parts[0] === '11') && parts[1] === '?') {
      const value = parts[0] === '10' ? 'e5e5/e5e5/e5e5' : '1e1e/1e1e/1e1e';
      this.onReply?.(`\x1b]${parts[0]};rgb:${value}\x1b\\`);
      return;
    }
    if ((parts[0] === '0' || parts[0] === '2') && parts[1]) {
      this.title = parts.slice(1).join(';');
      this.mutations++;
    }
  }

  getLines(): string[] {
    const grid = this.currentGrid;
    return grid.map((row) => row.map((cell) => cell.char).join('').trimEnd());
  }

  getScreenText(): string {
    return this.getLines().join('\n');
  }

  /**
   * Detect interactive controls across the screen buffer:
   * buttons `[ Save ]`, checkboxes `[x]`, options `( )`, menu pointers `> Option`, inputs, cursor focus.
   */
  detectControls(): TuiControl[] {
    const lines = this.getLines();
    const controls: TuiControl[] = [];
    let nextIndex = 0;

    for (let r = 0; r < lines.length; r++) {
      const line = lines[r];

      // 1. Bracketed buttons / checkboxes: [ ... ]
      const bracketRegex = /\[([^\]]*?)\]/g;
      let m: RegExpExecArray | null;
      while ((m = bracketRegex.exec(line)) !== null) {
        const inner = m[1].trim();
        const col = m.index;
        const width = m[0].length;
        if (inner === 'x' || inner === 'X' || inner === ' ' || inner === '') {
          controls.push({
            index: nextIndex++,
            kind: 'checkbox',
            label: m[0],
            row: r,
            col,
            width,
          });
        } else {
          controls.push({
            index: nextIndex++,
            kind: 'button',
            label: inner,
            row: r,
            col,
            width,
          });
        }
      }

      // 2. Radio / choice: ( ... )
      const parenRegex = /\(([^\)]*?)\)/g;
      while ((m = parenRegex.exec(line)) !== null) {
        const inner = m[1].trim();
        const col = m.index;
        const width = m[0].length;
        if (inner === '*' || inner === 'x' || inner === 'o' || inner === ' ' || inner === '') {
          controls.push({
            index: nextIndex++,
            kind: 'radio',
            label: m[0],
            row: r,
            col,
            width,
          });
        } else if (inner.length > 0) {
          controls.push({
            index: nextIndex++,
            kind: 'button',
            label: inner,
            row: r,
            col,
            width,
          });
        }
      }

      // 3. Menu pointers: > Item or * Item or -> Item
      const menuRegex = /(?:^|\s)(?:>|\*|●|○|->)\s*(\S.*?)(?:\s{2,}|$)/g;
      while ((m = menuRegex.exec(line)) !== null) {
        const full = m[0].trim();
        const label = m[1].trim();
        const col = line.indexOf(full);
        if (col >= 0 && !controls.some((c) => c.row === r && c.col === col)) {
          controls.push({
            index: nextIndex++,
            kind: 'menu-item',
            focused: /^(?:>|->)/.test(full),
            label,
            row: r,
            col,
            width: full.length,
          });
        }
      }

      // 4. Input fields: "Prompt: [____]" or "Prompt: ____"
      const inputRegex = /([A-Za-z0-9_\-\s]+?):\s*(?:_{2,}|\[\s*\])/g;
      while ((m = inputRegex.exec(line)) !== null) {
        const label = m[1].trim();
        const col = m.index;
        if (!controls.some((c) => c.row === r && Math.abs(c.col - col) < 3)) {
          controls.push({
            index: nextIndex++,
            kind: 'input',
            label: `${label}:`,
            row: r,
            col,
            width: m[0].length,
          });
        }
      }
    }

    for (const control of controls) {
      const line = lines[control.row];
      const before = [...graphemes.segment(line.slice(0, control.col))].reduce((sum, item) => sum + graphemeWidth(item.segment), 0);
      const width = [...graphemes.segment(line.slice(control.col, control.col + control.width))].reduce((sum, item) => sum + graphemeWidth(item.segment), 0);
      control.col = before;
      control.width = width;
      control.inferred = true;
    }

    // 5. Active cursor location: if cursor is visible and not already inside a control
    if (this.cursor.visible && this.cursor.y < this.rows && this.cursor.x < this.cols) {
      const row = this.cursor.y;
      const col = this.cursor.x;
      const existing = controls.find((c) => c.row === row && col >= c.col && col < c.col + c.width);
      if (existing) {
        existing.focused = true;
      } else {
        const lineText = lines[row] || '';
        const nearby = lineText.slice(Math.max(0, col - 5), Math.min(this.cols, col + 10)).trim();
        controls.push({
          index: nextIndex++,
          kind: 'focus',
          label: nearby ? `cursor at "${nearby}"` : `cursor at ${row}:${col}`,
          row,
          col,
          width: 1,
          focused: true,
        });
      }
    }

    return controls;
  }

  /**
   * Audit color contrast across all rendered character cells.
   * Reports cells with contrast ratio < minRatio (default 4.5:1 for WCAG AA).
   */
  auditContrast(minRatio = 4.5): TuiContrastFinding[] {
    const findings: TuiContrastFinding[] = [];
    const grid = this.currentGrid;

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cell = grid[r][c];
        if (!cell.char || cell.char === ' ') continue;

        let fg = cell.fg;
        let bg = cell.bg;
        if (cell.inverse) {
          fg = cell.bg;
          bg = cell.fg;
        }

        const parseHex = (h: string) => {
          const num = parseInt(h.slice(1), 16);
          return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
        };

        const fgRgb = parseHex(fg);
        const bgRgb = parseHex(bg);
        const ratio = contrastRatio(fgRgb, bgRgb);

        if (ratio < minRatio) {
          const suggestion = suggestAccessibleColor(fg, bg, 4.5);
          findings.push({
            row: r,
            col: c,
            char: cell.char,
            fg,
            bg,
            ratio,
            suggestedFg: suggestion?.hex,
            severity: ratio < 2.0 ? 'high' : ratio < 3.0 ? 'medium' : 'low',
          });
        }
      }
    }

    return findings;
  }

  /**
   * Render the terminal screen to an HTML representation suitable for Playwright screenshotting.
   */
  toHtml(options: { marked?: boolean; controls?: TuiControl[] } = {}): string {
    const grid = this.currentGrid;
    const controls = options.controls ?? (options.marked ? this.detectControls() : []);

    const charWidth = 8.5; // px per character in 14px monospace font
    const charHeight = 17; // px per row

    const totalWidth = Math.ceil(this.cols * charWidth) + 32;
    const totalHeight = Math.ceil(this.rows * charHeight) + 64;

    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    let rowsHtml = '';
    for (let r = 0; r < this.rows; r++) {
      const row = grid[r];
      let lineHtml = '';
      let i = 0;

      while (i < this.cols) {
        const cell = row[i];
        if (cell.width === 0) { i++; continue; }
        let spanChars = cell.char;
        let j = i + (cell.width ?? 1);

        let fg = cell.fg;
        let bg = cell.bg;
        if (cell.inverse) {
          fg = cell.bg;
          bg = cell.fg;
        }

        const styles: string[] = [
          `display: inline-block`,
          `width: ${(j - i) * charWidth}px`,
          `color: ${fg}`,
          `background-color: ${bg}`,
        ];
        if (cell.bold) styles.push('font-weight: bold');
        if (cell.dim) styles.push('opacity: 0.6');
        if (cell.italic) styles.push('font-style: italic');
        if (cell.underline) styles.push('text-decoration: underline');

        lineHtml += `<span style="${styles.join('; ')}">${escapeHtml(spanChars)}</span>`;
        i = j;
      }

      rowsHtml += `<div class="term-row">${lineHtml}</div>\n`;
    }

    // Cursor indicator
    let cursorHtml = '';
    if (this.cursor.visible && this.cursor.y < this.rows && this.cursor.x < this.cols) {
      const top = 8 + this.cursor.y * charHeight;
      const left = 12 + this.cursor.x * charWidth;
      cursorHtml = `<div class="term-cursor" style="top: ${top}px; left: ${left}px; width: ${charWidth}px; height: ${charHeight}px;"></div>`;
    }

    // Set-of-Marks badges
    let badgesHtml = '';
    if (options.marked && controls.length > 0) {
      for (const ctrl of controls) {
        const top = 8 + Math.max(0, ctrl.row * charHeight - 6);
        const left = 12 + Math.max(0, ctrl.col * charWidth - 4);
        badgesHtml += `<div class="som-badge" style="top: ${top}px; left: ${left}px;">${ctrl.index}</div>\n`;
      }
    }

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0c0d0e;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .term-window {
      background-color: #1e1e1e;
      border-radius: 8px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
      width: ${totalWidth}px;
      overflow: hidden;
    }
    .term-titlebar {
      background: linear-gradient(180deg, #2d2d2d, #252525);
      border-bottom: 1px solid #181818;
      height: 28px;
      display: flex;
      align-items: center;
      padding: 0 10px;
      user-select: none;
    }
    .term-dots {
      display: flex;
      gap: 6px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .dot-red { background: #ff5f56; }
    .dot-yellow { background: #ffbd2e; }
    .dot-green { background: #27c93f; }
    .term-title {
      flex: 1;
      text-align: center;
      font-size: 11px;
      color: #999;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      margin-right: 36px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .term-body {
      position: relative;
      background-color: #1e1e1e;
      padding: 8px 12px;
      font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
      font-size: 14px;
      line-height: ${charHeight}px;
      letter-spacing: 0px;
      white-space: normal;
    }
    .term-row {
      white-space: pre;
      height: ${charHeight}px;
      overflow: hidden;
    }
    .term-cursor {
      position: absolute;
      background-color: rgba(255, 255, 255, 0.7);
      mix-blend-mode: difference;
      pointer-events: none;
    }
    .som-badge {
      position: absolute;
      background: #ffd600;
      color: #000;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 10px;
      font-weight: 700;
      line-height: 12px;
      padding: 1px 4px;
      border-radius: 3px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.5), 0 0 0 1px #000;
      z-index: 100;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div class="term-window">
    <div class="term-titlebar">
      <div class="term-dots">
        <div class="dot dot-red"></div>
        <div class="dot dot-yellow"></div>
        <div class="dot dot-green"></div>
      </div>
      <div class="term-title">${escapeHtml(this.title || `Terminal (${this.cols}×${this.rows})`)}</div>
    </div>
    <div class="term-body">
      ${rowsHtml}
      ${cursorHtml}
      ${badgesHtml}
    </div>
  </div>
</body>
</html>`;
  }
}
