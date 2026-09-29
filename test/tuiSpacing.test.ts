import { describe, it, expect } from 'vitest';
import { TuiBuffer } from '../src/tuiBuffer.js';
import { measureTuiSpacing } from '../src/tuiSpacing.js';

describe('semantic terminal spacing measurements', () => {
  it('catches excessive separation between related transcript lines', () => {
    const b = new TuiBuffer(40, 12);
    b.write('> question\x1b[4;1Hanswer');
    const [result] = measureTuiSpacing(b, [{ name: 'reply', bounds: { row: 3, col: 0, rows: 1, cols: 40 }, maxGapBefore: 1 }]);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('preceding gap 2 rows > 1');
    expect(() => measureTuiSpacing(b, [{ name: 'reply', bounds: { row: 3, col: 0, rows: 1, cols: 40 }, minGapBefore: 2, maxGapBefore: 1 }])).toThrow('minGapBefore exceeds');
  });

  it('catches a related block with too little separation', () => {
    const b = new TuiBuffer(40, 12);
    b.write('> question\x1b[2;1Hanswer');
    const [result] = measureTuiSpacing(b, [{ name: 'reply', bounds: { row: 1, col: 0, rows: 1, cols: 40 }, minGapBefore: 1 }]);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('preceding gap 0 rows < 1');
  });
  it('catches a one-row cramped input instead of treating an empty screen as generous padding', () => {
    const b = new TuiBuffer(40, 12);
    b.write('\x1b[8;2H\x1b[48;2;23;29;23m> draft\x1b[0m');
    const [result] = measureTuiSpacing(b, [{ name: 'composer', background: '#171d17', minRows: 5, minPadding: { top: 1, bottom: 1, left: 2, right: 2 } }]);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('height 1 rows < 5');
    expect(result.padding?.left).toBe(0);
  });

  it('measures actual surface padding and requires draft text to survive', () => {
    const b = new TuiBuffer(40, 12);
    for (let r = 5; r <= 9; r++) b.write(`\x1b[${r};3H\x1b[48;2;23;29;23m${' '.repeat(34)}`);
    b.write('\x1b[6;5H> first\x1b[7;5H  second\x1b[8;5H  third\x1b[0m');
    const [result] = measureTuiSpacing(b, [{ name: 'composer', background: '#171d17', minRows: 5, minPadding: { top: 1, bottom: 1, left: 2, right: 2 }, requiredText: ['first', 'second', 'third'] }]);
    expect(result.passed).toBe(true);
    expect(result.bounds).toEqual({ row: 4, col: 2, rows: 5, cols: 34 });
    expect(result.padding?.top).toBe(1);
    expect(result.padding?.bottom).toBe(1);
  });

  it('fails offscreen bounds and missing surface/content instead of passing vacuous padding', () => {
    const b = new TuiBuffer(40, 12);
    const results = measureTuiSpacing(b, [
      { name: 'missing', background: '#abcdef' },
      { name: 'offscreen', bounds: { row: 10, col: 0, rows: 5, cols: 40 } },
      { name: 'lost draft', bounds: { row: 0, col: 0, rows: 5, cols: 40 }, requiredText: ['draft'] },
    ]);
    expect(results.every(r => !r.passed)).toBe(true);
  });
});
