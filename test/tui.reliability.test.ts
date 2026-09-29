import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TuiBuffer } from '../src/tuiBuffer.js';
import { TuiProcess } from '../src/tuiProcess.js';
import { TuiSession, keyToAnsi } from '../src/tuiSession.js';
import { auditTui } from '../src/tuiAudit.js';

async function collect(command: string[]): Promise<{ text: string; exit: number | null }> {
  const p = new TuiProcess({ command });
  let text = '';
  p.on('data', data => text += data);
  try {
    await new Promise<void>((resolve, reject) => { p.on('exit', () => resolve()); p.on('error', reject); });
    return { text, exit: p.exitCode };
  } finally { await p.close(); }
}

const inputRecorder = `import os,tty,select,sys,json
os.write(1,b'\\x1b[?1000h\\x1b[?1006h\\x1b[?2004h[ Button ]\\r')
tty.setraw(0)
data=b''
while True:
 r,_,_=select.select([0],[],[],0.2)
 if r:
  part=os.read(0,65536)
  if not part:break
  data+=part
  open(sys.argv[1],'w').write(json.dumps(list(data)))
`;

async function recorder(): Promise<{ session: TuiSession; bytes: () => Promise<number[]> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ui-crawl-input-'));
  const log = path.join(dir, 'input.json');
  await writeFile(log, '[]');
  const session = await TuiSession.open({ command: ['python3', '-u', '-c', inputRecorder, log], outDir: dir, interactionTimeoutMs: 120 });
  return { session, bytes: async () => JSON.parse(await readFile(log, 'utf8')) };
}

describe('terminal reliability regressions', () => {
  it('preserves split UTF-8 from the actual PTY and propagates exit status', async () => {
    expect(await collect(['python3', '-u', '-c', "import os,time\nb='é東京'.encode()\nfor c in b:\n os.write(1,bytes([c]));time.sleep(.015)\nraise SystemExit(42)"])).toEqual({ text: 'é東京', exit: 42 });
  });

  it('preserves exact graphemes, combining marks, wide text, and indexed colors', () => {
    for (const text of ['e\u0301X', '東京X', '👩‍💻X', '👨‍👩‍👧‍👦X', '🇺🇸X', '📦X']) {
      const b = new TuiBuffer(80, 24);
      for (const unit of text.split('')) b.write(unit);
      expect(b.getLines()[0]).toBe(text);
      expect(b.cursor.x).toBe(text === '東京X' ? 5 : text === 'e\u0301X' ? 2 : 3);
    }
    const b = new TuiBuffer(80, 24); b.write('\x1b[38;5;17mX');
    expect(b.currentGrid[0][0].fg).toBe('#00005f');
  });

  it('recognizes an explicit menu selection marker as focus', () => {
    const b = new TuiBuffer(80, 24);
    b.write('\x1b[?25l> models  selected\r\n  effort  medium');
    expect(b.detectControls().find(c => c.kind === 'menu-item')?.focused).toBe(true);
  });

  it('keeps wide glyph continuation cells out of text and repairs overwrite', () => {
    const b = new TuiBuffer(80, 24); b.write('abc\r東');
    expect(b.getLines()[0]).toBe('東c');
    b.write('\x1b[2Gx');
    expect(b.getLines()[0]).toBe(' xc');
  });

  it('maps modified navigation, aliases, and rejects unsupported key names', () => {
    expect(keyToAnsi('Control+S')).toBe('\x13');
    expect(keyToAnsi('Ctrl+PageUp')).toBe('\x1b[5;5~');
    expect(keyToAnsi('Control+End')).toBe('\x1b[1;5F');
    expect(keyToAnsi('Ctrl+Shift+ArrowLeft')).toBe('\x1b[1;6D');
    expect(keyToAnsi('Shift+Tab')).toBe('\x1b[Z');
    expect(() => keyToAnsi('BogusKey')).toThrow('Unsupported');
  });

  it('applies coalesced resizes through the control pipe without changing application bytes', async () => {
    const source = `import os,tty,json,time
 tty.setraw(0)
 print('READY',flush=True)
 data=os.read(0,4096)
 size=os.get_terminal_size(0)
 print(json.dumps({'cols':size.columns,'rows':size.lines,'input':list(data)}),flush=True)
`.replace(/^ /gm, '');
    const p = new TuiProcess({ command: ['python3', '-u', '-c', source] });
    let output = ''; p.on('data', s => output += s);
    try {
      await p.waitForOutput(500);
      p.resize(100, 36); p.resize(120, 40);
      await new Promise(r => setTimeout(r, 80));
      // This is application text, not an instrument resize command.
      const input = '\x1b[8;22;77tq';
      p.write(input);
      await p.waitForOutput(500);
      const result = JSON.parse(output.trim().split('\n').at(-1)!);
      expect(result).toEqual({ cols: 120, rows: 40, input: [...Buffer.from(input)] });
    } finally { await p.close(); }
  });

  it('makes default audits observation-only, with accurate counters', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ui-crawl-passive-'));
    const log = path.join(dir, 'input.json'); await writeFile(log, '[]');
    const result = await auditTui({ command: ['python3', '-u', '-c', inputRecorder, log], outDir: dir, settleMs: 120 });
    expect(JSON.parse(await readFile(log, 'utf8'))).toEqual([]);
    expect(result.pages[0].probedControls).toBe(0);
    expect(result.pages[0].controlCount).toBe(1);
    expect(result.pages[0].skippedControls).toBe(1);
  });

  it('sends click, wheel, and paste without implicit submission', async () => {
    const { session: s, bytes } = await recorder();
    try {
      const button = (await s.snapshot()).find(c => c.kind === 'button')!;
      expect((await s.act({ type: 'click', index: button.index })).ok).toBe(true);
      await s.snapshot();
      expect((await s.act({ type: 'fill', index: button.index, value: 'draft' })).ok).toBe(true);
      expect((await s.act({ type: 'scroll', dy: -2 })).ok).toBe(true);
      const text = Buffer.from(await bytes()).toString();
      expect(text).toContain('\x1b[<0;1;1M\x1b[<0;1;1m');
      expect(text).toContain('\x1b[200~draft\x1b[201~');
      expect(text).toContain('\x1b[<64;41;13M');
      expect(text).not.toContain('\r');
    } finally { await s.close(); }
  });

  it('rejects unseen, stale, unsupported, and unavailable mouse actions', async () => {
    const { session: s, bytes } = await recorder();
    try {
      expect((await s.act({ type: 'click', index: 0 }, { snapshot: 'none' })).ok).toBe(false);
      const button = (await s.snapshot()).find(c => c.kind === 'button')!;
      s.screenBuffer.write('\r[ Changed ]\r');
      expect((await s.act({ type: 'click', index: button.index }, { snapshot: 'none' })).ok).toBe(false);
      expect((await s.act({ type: 'reload' })).ok).toBe(false);
      s.screenBuffer.write('\x1b[?1000l');
      expect((await s.act({ type: 'scroll', dy: -1 })).ok).toBe(false);
      expect(await bytes()).toEqual([]);
    } finally { await s.close(); }
  });

  it('renders one browser row per terminal row without phantom line spacing', async () => {
    const { session: s } = await recorder();
    try {
      const shot = await s.screenshot(false);
      const png = await readFile(s.screenshotPath(shot));
      expect(png.readUInt32BE(20)).toBe(s.terminalRows * 17 + 44);
    } finally { await s.close(); }
  });

  it('reports actual failed and blank processes with failed page metadata', async () => {
    for (const cmd of ['/usr/bin/false', '/usr/bin/true']) {
      const outDir = await mkdtemp(path.join(tmpdir(), 'ui-crawl-exit-'));
      const result = await auditTui({ command: [cmd], outDir });
      expect(result.verdict).toBe('has_defects');
      expect(result.pages[0].status).toBe(500);
    }
  });
});
