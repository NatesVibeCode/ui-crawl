import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TuiSession } from '../src/tuiSession.js';
import { checkTui, observeTui, validateTuiCheck } from '../src/tuiCheck.js';
import { TuiBuffer } from '../src/tuiBuffer.js';
import { measureTuiSpacing } from '../src/tuiSpacing.js';

async function launch(code: string) {
  return TuiSession.open({ command: ['python3', '-u', '-c', code], interactionTimeoutMs: 80,
    outDir: await mkdtemp(path.join(tmpdir(), 'tui-check-')) });
}

describe('explicit terminal checks and observations', () => {
  it('rejects empty contracts, bad geometry and ambiguous background surfaces', () => {
    expect(() => validateTuiCheck({})).toThrow('requires');
    expect(() => validateTuiCheck({ spacing: [{ name: 'input', background: '#171d17', minRows: -1 }] })).toThrow('nonnegative');
    expect(() => validateTuiCheck({ spacing: [{ name: 'input', bounds: { row: 0, col: 0, rows: 1, cols: 0 } }] })).toThrow('bounds');
    const b = new TuiBuffer(40, 12);
    b.write('\x1b[48;2;23;29;23m  \x1b[0m gap \x1b[48;2;23;29;23m  ');
    expect(measureTuiSpacing(b, [{ name: 'input', background: '#171d17' }])[0].violations[0]).toContain('one solid rectangular');
  });

  it('waits for application content after startup control bytes before measuring', async () => {
    const session = await launch("import os,time\nos.write(1,b'\x1b[?25l')\ntime.sleep(.3)\nos.write(1,b'\x1b[2;3HMenu ready')\ntime.sleep(5)");
    try {
      const result = await checkTui(session, { readyText: ['Menu ready'], requiredText: ['Menu ready'], timeoutMs: 1000,
        spacing: [{ name: 'menu', bounds: { row: 0, col: 0, rows: 3, cols: 20 }, minPadding: { top: 1, left: 2, bottom: 1 } }] });
      expect(result.passed).toBe(true);
      expect(result.ready).toBe(true);
      const missing = await checkTui(session, { readyText: ['missing'], requiredText: ['missing'], timeoutMs: 20 });
      expect(missing.ready).toBe(false);
      expect(missing.passed).toBe(false);
    } finally { await session.close(); }
  });

  it('records partial content before completion, excluding the spinner region', async () => {
    const session = await launch("import os,time\nos.write(1,b'Ready')\ntime.sleep(.3)\nos.write(1,b'\x1b[2;1HChecking files')\ntime.sleep(.2)\nos.write(1,b'\x1b[3;1HRunning file_read')\ntime.sleep(.2)\nos.write(1,b'\x1b[4;1HDone')\ntime.sleep(2)");
    try {
      const result = await observeTui(session, { durationMs: 1000, intervalMs: 20, bounds: { row: 1, col: 0, rows: 3, cols: 40 }, sequence: [
        { name: 'progress', text: 'Checking files', absentText: ['Done'] },
        { name: 'tool', text: 'Running file_read', absentText: ['Done'] },
        { name: 'complete', text: 'Done' },
      ] });
      expect(result.passed).toBe(true);
      expect(result.sequence[0].seenAtMs).toBeLessThan(result.sequence[2].seenAtMs!);
    } finally { await session.close(); }
  });

  it('does not pass streaming for a spinner followed by one complete burst', async () => {
    const session = await launch("import os,time\nos.write(1,b'Ready')\nfor c in b'12345':\n time.sleep(.06);os.write(1,b'\x1b[1;1H'+bytes([c]))\nos.write(1,b'\x1b[2;1HChecking files Done')\ntime.sleep(2)");
    try {
      const result = await observeTui(session, { durationMs: 600, intervalMs: 20, bounds: { row: 1, col: 0, rows: 3, cols: 40 }, sequence: [
        { name: 'partial', text: 'Checking files', absentText: ['Done'] }, { name: 'complete', text: 'Done' },
      ] });
      expect(result.passed).toBe(false);
      expect(result.sequence[0].seenAtMs).toBeNull();
    } finally { await session.close(); }
  });

  it('measures large terminal surfaces without spreading every cell onto the stack', () => {
    const b = new TuiBuffer(600, 400);
    const result = measureTuiSpacing(b, [{ name: 'screen', background: b.currentGrid[0][0].bg, minRows: 400 }]);
    expect(result[0].passed).toBe(true);
  });
});
