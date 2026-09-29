import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TuiSession } from '../src/tuiSession.js';
import { checkTui, observeTui, validateTuiCheck, validateTuiObserve } from '../src/tuiCheck.js';
import { TuiBuffer } from '../src/tuiBuffer.js';
import { measureTuiSpacing } from '../src/tuiSpacing.js';

async function launch(code: string) {
  return TuiSession.open({ command: ['python3', '-u', '-c', code], interactionTimeoutMs: 80,
    outDir: await mkdtemp(path.join(tmpdir(), 'tui-check-')) });
}

describe('explicit terminal checks and observations', () => {
  it('rejects empty contracts, bad geometry and ambiguous background surfaces', () => {
    expect(() => validateTuiCheck({})).toThrow('requires');
    expect(() => validateTuiCheck({ identities: [{ name: 'call', value: ' ' }] })).toThrow('nonempty name and value');
    expect(() => validateTuiCheck({ oneOfText: [{ name: 'disposition', values: [] }] })).toThrow('values must be a nonempty array');
    expect(() => validateTuiObserve({ durationMs: 100, sequence: [] })).toThrow('nonempty array');
    expect(() => validateTuiCheck({ spacing: [{ name: 'input', background: '#171d17', minRows: -1 }] })).toThrow('nonnegative');
    expect(() => validateTuiCheck({ spacing: [{ name: 'input', bounds: { row: 0, col: 0, rows: 1, cols: 0 } }] })).toThrow('bounds');
    const b = new TuiBuffer(40, 12);
    b.write('\x1b[48;2;23;29;23m  \x1b[0m gap \x1b[48;2;23;29;23m  ');
    expect(measureTuiSpacing(b, [{ name: 'input', background: '#171d17' }])[0].violations[0]).toContain('one solid rectangular');
  });

  it('requires a named identity to match as a complete visible token', async () => {
    const session = await launch("import os,time\nos.write(1,b'Running file_read (call-10)')\ntime.sleep(2)");
    try {
      const result = await checkTui(session, { identities: [{ name: 'OE call', value: 'call-1' }] });
      expect(result.passed).toBe(false);
      expect(result.violations).toContain('OE call identity missing from visible screen: call-1');
      const exact = await checkTui(session, { requiredText: ['file_read'], identities: [{ name: 'OE call', value: 'call-10' }] });
      expect(exact.passed).toBe(true);
    } finally { await session.close(); }
  });

  it('accepts one of the stated equivalent busy outcomes but not silence', async () => {
    const session = await launch("import os,time\nos.write(1,b'Working · next question')\ntime.sleep(2)");
    let queued;
    try {
      const passed = await checkTui(session, { oneOfText: [{ name: 'busy submission status', values: ['not sent', 'queued'] }] });
      expect(passed.passed).toBe(false);
      expect(passed.violations[0]).toContain('none of the accepted text appeared');
      queued = await launch("import os,time\nos.write(1,b'queued for after this turn')\ntime.sleep(2)");
      const explicit = await checkTui(queued, { oneOfText: [{ name: 'busy submission status', values: ['not sent', 'queued'] }] });
      expect(explicit.passed).toBe(true);
    } finally { await session.close(); await queued?.close(); }
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

  it('waits for loading to disappear without treating an old footer as readiness', async () => {
    const session = await launch("import os,time\nos.write(1,b'Footer active model\\nLoading catalog')\ntime.sleep(.3)\nos.write(1,b'\\x1b[2;1H\\x1b[2KCatalog complete')\ntime.sleep(2)");
    try {
      const result = await checkTui(session, { readyText: ['Footer active model'], readyAbsentText: ['Loading catalog'], requiredText: ['Catalog complete'], timeoutMs: 1000 });
      expect(result.ready).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.presentReadyAbsentText).toEqual([]);
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

  it('accepts a milestone when its identity arrives in a later changed frame', async () => {
    const session = await launch("import os,time\nos.write(1,b'Ready')\ntime.sleep(.2)\nos.write(1,b'\\x1b[2;1HRunning file_read')\ntime.sleep(.15)\nos.write(1,b'\\x1b[3;1Hcall-1')\ntime.sleep(2)");
    try {
      const result = await observeTui(session, { durationMs: 600, intervalMs: 20, sequence: [
        { name: 'identified running call', text: 'Running file_read', identities: [{ name: 'call', value: 'call-1' }] },
      ] });
      expect(result.passed).toBe(true);
      expect(result.violations).toEqual([]);
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

  it('requires stable call identity at every lifecycle milestone and rejects no-observation', async () => {
    expect(() => validateTuiObserve({ durationMs: 500, sequence: [
      { name: 'start', text: 'running', identities: [{ name: 'call', value: 'call-1' }] },
      { name: 'finish', text: 'succeeded', identities: [{ name: 'call', value: 'call-10' }] },
    ] })).toThrow('identity call changes');

    const session = await launch("import os,time\nos.write(1,b'Ready')\ntime.sleep(2)");
    try {
      const missing = await observeTui(session, { durationMs: 100, intervalMs: 20, sequence: [
        { name: 'running', text: 'running', identities: [{ name: 'call', value: 'call-1' }] },
      ] });
      expect(missing.passed).toBe(false);
      expect(missing.sequence[0].seenAtMs).toBeNull();
      const passive = await observeTui(session, { durationMs: 60, intervalMs: 20 });
      expect(passive.passed).toBeNull();
      expect(passive.frames.length).toBeGreaterThan(0);
    } finally { await session.close(); }
  });

  it('fails explicit checks on a nonzero exit and screenshot failure', async () => {
    const exited = await launch("import os,sys\nos.write(1,b'Frame survived exit')\nsys.exit(7)");
    try {
      const result = await checkTui(exited, { requiredText: ['Frame survived exit'] });
      expect(result.passed).toBe(false);
      expect(result.violations).toContain('process exited with code 7');
    } finally { await exited.close(); }

    const screenshot = await launch("import os,time\nos.write(1,b'Ready')\ntime.sleep(2)");
    try {
      screenshot.screenshot = async () => { throw new Error('fixture screenshot unavailable'); };
      const result = await checkTui(screenshot, { requiredText: ['Ready'] });
      expect(result.passed).toBe(false);
      expect(result.violations).toContain('screenshot failed: fixture screenshot unavailable');
    } finally { await screenshot.close(); }
  });

  it('measures large terminal surfaces without spreading every cell onto the stack', () => {
    const b = new TuiBuffer(600, 400);
    const result = measureTuiSpacing(b, [{ name: 'screen', background: b.currentGrid[0][0].bg, minRows: 400 }]);
    expect(result[0].passed).toBe(true);
  });
});
