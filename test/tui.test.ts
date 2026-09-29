import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { TuiBuffer } from '../src/tuiBuffer.js';
import { TuiProcess } from '../src/tuiProcess.js';
import { TuiSession, keyToAnsi } from '../src/tuiSession.js';
import { auditTui } from '../src/tuiAudit.js';
import { handleMcpMessage } from '../src/mcp.js';
import { parseFlags } from '../src/cli.js';

describe('TuiBuffer', () => {
  it('parses plain text and cursor movements', () => {
    const buf = new TuiBuffer(40, 10);
    buf.write('Hello, World!\r\nSecond Line');
    const lines = buf.getLines();
    expect(lines[0]).toBe('Hello, World!');
    expect(lines[1]).toBe('Second Line');
  });

  it('handles cursor positioning and line clear', () => {
    const buf = new TuiBuffer(40, 10);
    buf.write('Old Text Here');
    // Move to col 5 (1-based), erase to end of line, write new text
    buf.write('\x1b[5G\x1b[KNew');
    const lines = buf.getLines();
    expect(lines[0]).toBe('Old New');
  });

  it('handles ANSI SGR styling and colors', () => {
    const buf = new TuiBuffer(40, 10);
    // Green text on black, bold
    buf.write('\x1b[1;32mGreen Bold\x1b[0m Normal');
    const grid = buf.currentGrid;
    expect(grid[0][0].char).toBe('G');
    expect(grid[0][0].bold).toBe(true);
    expect(grid[0][0].fg).toBe('#00cd00');

    // Normal text after reset
    expect(grid[0][11].char).toBe('N');
    expect(grid[0][11].bold).toBe(false);
  });

  it('handles 24-bit truecolor SGR', () => {
    const buf = new TuiBuffer(40, 10);
    buf.write('\x1b[38;2;123;45;67mRGB Color\x1b[0m');
    const cell = buf.currentGrid[0][0];
    expect(cell.char).toBe('R');
    expect(cell.fg).toBe('#7b2d43');
  });

  it('detects interactive controls: buttons, checkboxes, inputs, menu items', () => {
    const buf = new TuiBuffer(60, 10);
    buf.write('┌────────────────────────┐\r\n');
    buf.write('│ [ Submit ]  [ Cancel ] │\r\n');
    buf.write('│ [x] Remember me        │\r\n');
    buf.write('│ (o) Radio selection    │\r\n');
    buf.write('│ > Menu Item 1          │\r\n');
    buf.write('│ Username: [      ]     │\r\n');
    buf.write('└────────────────────────┘');

    const controls = buf.detectControls();
    expect(controls.length).toBeGreaterThanOrEqual(5);

    const submit = controls.find((c) => c.label === 'Submit');
    expect(submit).toBeDefined();
    expect(submit?.kind).toBe('button');

    const cancel = controls.find((c) => c.label === 'Cancel');
    expect(cancel).toBeDefined();
    expect(cancel?.kind).toBe('button');

    const checkbox = controls.find((c) => c.kind === 'checkbox');
    expect(checkbox).toBeDefined();

    const radio = controls.find((c) => c.kind === 'radio');
    expect(radio).toBeDefined();

    const menu = controls.find((c) => c.kind === 'menu-item');
    expect(menu).toBeDefined();
    expect(menu?.label).toBe('Menu Item 1');
  });

  it('audits color contrast on terminal cells', () => {
    const buf = new TuiBuffer(40, 10);
    // Dark blue on black background: low contrast
    buf.write('\x1b[34;40mHard to read\x1b[0m');
    const findings = buf.auditContrast();
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].ratio).toBeLessThan(3.0);
    expect(findings[0].suggestedFg).toBeDefined();
  });

  it('renders terminal screen to HTML with set-of-marks badges', () => {
    const buf = new TuiBuffer(40, 10);
    buf.write('Test [ Click Me ]');
    const html = buf.toHtml({ marked: true });
    expect(html.replace(/<[^>]*>/g, '')).toContain('Click Me');
  });

  it('handles fragmented ANSI escape sequences across multiple chunks', () => {
    const buf = new TuiBuffer(40, 10);
    // Write partial CSI in chunk 1, rest in chunk 2
    buf.write('Hello \x1b[1;3');
    buf.write('2mWorld\x1b[0m');
    const lines = buf.getLines();
    expect(lines[0]).toBe('Hello World');
    // Ensure raw escape codes were not printed to buffer
    expect(lines[0]).not.toContain('[1;3');
    expect(lines[0]).not.toContain('2m');
    const cellW = buf.currentGrid[0][6];
    expect(cellW.char).toBe('W');
    expect(cellW.bold).toBe(true);
    expect(cellW.fg).toBe('#00cd00'); // Green
  });

  it('handles Unicode surrogate pairs and wide emoji correctly', () => {
    const buf = new TuiBuffer(40, 10);
    // Package emoji U+1F4E6 (2 UTF-16 code units, width 2)
    buf.write('Box: 📦 Done');
    const lines = buf.getLines();
    expect(lines[0]).toContain('📦');
    expect(lines[0]).toContain('Done');
    // Fragmented surrogate pair across write chunks
    const highSurrogate = '\uD83C';
    const lowSurrogate = '\uDF89'; // 🎉 Party Popper
    buf.write('\r\n');
    buf.write(highSurrogate);
    buf.write(lowSurrogate + ' Party');
    const secondLine = buf.getLines()[1];
    expect(secondLine).toContain('🎉');
    expect(secondLine).toContain('Party');
  });
});

describe('TuiProcess and key mapping', () => {
  it('maps key names to ANSI escape codes', () => {
    expect(keyToAnsi('Enter')).toBe('\r');
    expect(keyToAnsi('Escape')).toBe('\x1b');
    expect(keyToAnsi('Tab')).toBe('\t');
    expect(keyToAnsi('ArrowUp')).toBe('\x1b[A');
    expect(keyToAnsi('ArrowDown')).toBe('\x1b[B');
    expect(keyToAnsi('Ctrl+C')).toBe('\x03');
    expect(keyToAnsi('Ctrl+S')).toBe('\x13');
    expect(keyToAnsi('ctrl-s')).toBe('\x13');
    expect(keyToAnsi('Ctrl+A')).toBe('\x01');
    expect(keyToAnsi('Ctrl+Z')).toBe('\x1a');
    expect(keyToAnsi('Alt+x')).toBe('\x1bx');
  });

  it('spawns and receives output from a simple command', async () => {
    const proc = new TuiProcess({
      command: ['/bin/sh', '-c', 'echo "test output from tui"'],
      cols: 40,
      rows: 10,
    });
    let received = '';
    proc.on('data', (d) => {
      received += d;
    });

    await proc.waitForOutput(500, 100);
    proc.kill();
    expect(received).toContain('test output from tui');
  });
});

describe('TuiSession', () => {
  let session: TuiSession | null = null;
  const outDir = './ui-crawl-out/test-tui';

  afterAll(async () => {
    if (session) await session.close().catch(() => {});
  });

  it('opens a session and returns initial snapshot and state', async () => {
    session = await TuiSession.open({
      command: ['/bin/sh', '-c', 'echo "[ Option A ] [ Option B ]"; read ans; echo "Selected: $ans"; sleep 1'],
      cols: 60,
      rows: 10,
      outDir,
    });

    expect(session.id.startsWith('tui_')).toBe(true);
    expect(session.rawText).toContain('Option A');

    const controls = await session.snapshot();
    expect(controls.length).toBeGreaterThanOrEqual(2);
    expect(controls[0].label).toBe('Option A');
  });

  it('acts on a session: presses key and observes output change', async () => {
    if (!session) return;
    const res = await session.act({ type: 'write', text: 'Option A\n' });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe('ACTED');
    expect(res.url).toContain('tui://');
    expect(res.snapshot).toContain('Option A');
  });

  it('captures screenshot of terminal window', async () => {
    if (!session) return;
    const shotRel = await session.screenshot();
    expect(shotRel.endsWith('.png')).toBe(true);
    const absPath = session.screenshotPath(shotRel);
    expect(existsSync(absPath)).toBe(true);
  });
});

describe('auditTui', () => {
  it('evaluates a clean TUI app and produces AgentPayload', async () => {
    const payload = await auditTui({
      command: ['/bin/sh', '-c', 'echo "Welcome to MyApp"; echo "[ OK ]"'],
      cols: 60,
      rows: 10,
      outDir: './ui-crawl-out/test-tui-audit',
      probeControls: false,
    });

    expect(payload.runId).toBeDefined();
    expect(payload.routes[0]).toContain('tui://');
    expect(payload.summary.pagesCrawled).toBe(1);
    expect(payload.pages.length).toBe(1);
    expect(payload.pages[0].screenshot).toBeDefined();
  });

  it('flags low contrast ANSI text in a TUI app', async () => {
    // Blue text (#0000ee) on black background has ~1.2:1 contrast ratio
    const payload = await auditTui({
      command: ['/bin/sh', '-c', 'printf "\\033[34;40mHard to read blue text\\033[0m\\n"'],
      cols: 60,
      rows: 10,
      outDir: './ui-crawl-out/test-tui-contrast',
      probeControls: false,
    });

    expect(payload.summary.defects).toBeGreaterThanOrEqual(1);
    const contrastFinding = payload.actions.find((a) => a.type === 'low-contrast' && a.bucket === 'defect');
    expect(contrastFinding).toBeDefined();
    expect(contrastFinding?.bucket).toBe('defect');
    expect(contrastFinding?.remediation).toContain('Set foreground color');
  });

  it('classifies sub-4.5:1 contrast and crowded buttons as taste questions (not defects)', async () => {
    // Crowded buttons [Cancel][OK] (tight-target) + muted text #7f7f7f on #1e1e1e (ratio ~3.5:1)
    const payload = await auditTui({
      command: [
        '/bin/sh',
        '-c',
        'printf "Header\\n[Cancel][OK]\\n\\033[90mDim secondary metadata\\033[0m\\n"',
      ],
      cols: 60,
      rows: 10,
      outDir: './ui-crawl-out/test-tui-taste',
      probeControls: false,
    });

    expect(payload.summary.defects).toBe(0);
    expect(payload.summary.taste).toBeGreaterThanOrEqual(1);
    expect(payload.verdict).toBe('has_taste_questions');

    const tightTarget = payload.actions.find((a) => a.type === 'tight-target');
    expect(tightTarget).toBeDefined();
    expect(tightTarget?.bucket).toBe('taste');

    const subContrast = payload.actions.find((a) => a.type === 'low-contrast' && a.bucket === 'taste');
    expect(subContrast).toBeDefined();
    expect(subContrast?.bucket).toBe('taste');
  });

  it('detects viewport scale imbalance and unanchored divider bleed as taste questions', async () => {
    const payload = await auditTui({
      command: [
        '/bin/sh',
        '-c',
        'printf "┌────────────────────┐\\n│ Content Box        │\\n└────────────────────┘\\n────────────────────────────────────────\\n"',
      ],
      cols: 60,
      rows: 10,
      outDir: './ui-crawl-out/test-tui-taste-divider',
      probeControls: false,
    });

    const dividerFinding = payload.actions.find((a) => a.type === 'unanchored-divider-bleed');
    expect(dividerFinding).toBeDefined();
    expect(dividerFinding?.bucket).toBe('taste');
  });

  it('detects card padding, button padding, diff accessibility, and thinking streams as taste questions', async () => {
    const payload = await auditTui({
      command: [
        '/bin/sh',
        '-c',
        'printf "┌───────────────┐\\n│UnpaddedCard   │\\n└───────────────┘\\n[OK]\\n\\033[92mAdded line without plus sign\\033[0m\\n\\033[91mRemoved line without minus\\033[0m\\nThinking... reasoning stream\\n"',
      ],
      cols: 60,
      rows: 10,
      outDir: './ui-crawl-out/test-tui-taste-aesthetics',
      probeControls: false,
    });

    expect(payload.summary.defects).toBe(0);
    expect(payload.verdict).toBe('has_taste_questions');

    const cardPadding = payload.actions.find((a) => a.type === 'text-border-collision');
    expect(cardPadding).toBeDefined();
    expect(cardPadding?.bucket).toBe('taste');

    const buttonPadding = payload.actions.find((a) => a.fingerprint?.includes('tight-button-padding'));
    expect(buttonPadding).toBeDefined();
    expect(buttonPadding?.bucket).toBe('taste');

    const diffFinding = payload.actions.find((a) => a.fingerprint?.includes('diff-missing-gutter-symbol'));
    expect(diffFinding).toBeDefined();
    expect(diffFinding?.bucket).toBe('taste');

    const thinkingFinding = payload.actions.find((a) => a.fingerprint?.includes('unmuted-thinking-stream'));
    expect(thinkingFinding).toBeDefined();
    expect(thinkingFinding?.bucket).toBe('taste');
  });

  it('reports defects and has_defects verdict on failed commands (exit 1)', async () => {
    const payload = await auditTui({
      command: ['/bin/sh', '-c', 'echo "Fatal crash message" >&2; exit 1'],
      cols: 60,
      rows: 10,
      outDir: './ui-crawl-out/test-tui-fail',
      probeControls: false,
    });

    expect(payload.summary.defects).toBeGreaterThanOrEqual(1);
    expect(payload.verdict).toBe('has_defects');
    const exitFinding = payload.actions.find((a) => a.type === 'page-load-error');
    expect(exitFinding).toBeDefined();
    expect(exitFinding?.bucket).toBe('defect');
    expect(exitFinding?.severity).toBe('high');
  });

  it('reports defects and has_defects verdict on blank screen output', async () => {
    const payload = await auditTui({
      command: ['/bin/sh', '-c', 'true'], // exits immediately with no output
      cols: 60,
      rows: 10,
      outDir: './ui-crawl-out/test-tui-blank',
      probeControls: false,
    });

    expect(payload.summary.defects).toBeGreaterThanOrEqual(1);
    expect(payload.verdict).toBe('has_defects');
    const blankFinding = payload.actions.find((a) => a.type === 'page-load-error');
    expect(blankFinding).toBeDefined();
    expect(blankFinding?.title).toContain('failed to render any output');
  });

  it('resizes buffer and PTY to 36 rows without truncating to 6', async () => {
    const sess = await TuiSession.open({
      command: ['/bin/sh', '-c', 'echo "Before resize"; sleep 1'],
      cols: 80,
      rows: 24,
      outDir: './ui-crawl-out/test-tui-resize',
    });
    try {
      const res = await sess.act({ type: 'resize', width: 80, height: 36 });
      expect(res.ok).toBe(true);
      expect(sess.terminalRows).toBe(36);
      expect(sess.lines.length).toBe(36);
      expect(sess.lines.length).not.toBe(6);
    } finally {
      await sess.close();
    }
  });

  it('does not send Enter keypress on click actions', async () => {
    // Command reads a line with timeout. If Enter was sent, ENTER_RECEIVED is printed.
    const sess = await TuiSession.open({
      command: [
        '/bin/sh',
        '-c',
        'echo "[ Button ]"; read -t 1 ans; if [ -n "$ans" ]; then echo "ENTER_RECEIVED"; else echo "CLICK_ONLY"; fi',
      ],
      cols: 60,
      rows: 10,
      outDir: './ui-crawl-out/test-tui-noclick-enter',
    });
    try {
      const controls = await sess.snapshot();
      const btn = controls.find((c) => c.kind === 'button');
      expect(btn).toBeDefined();
      if (btn) {
        await sess.act({ type: 'click', index: btn.index });
        expect(sess.rawText).not.toContain('ENTER_RECEIVED');
      }
    } finally {
      await sess.close();
    }
  });
});

describe('MCP TUI integration', () => {
  it('opens, acts, and closes a TUI session over MCP', async () => {
    // 1. ui_tui_open
    const openRes = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'open-1',
      method: 'tools/call',
      params: {
        name: 'ui_tui_open',
        arguments: {
          command: '/bin/sh -c "echo \\"[ Click Me ]\\"; read l; echo \\"Done: $l\\""',
          cols: 60,
          rows: 10,
        },
      },
    });

    expect(openRes?.result).toBeDefined();
    const openData = JSON.parse((openRes?.result as any).content[0].text);
    const sessionId = openData.sessionId;
    expect(sessionId).toBeDefined();
    expect(sessionId.startsWith('tui_')).toBe(true);

    // 2. ui_snapshot
    const snapRes = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'snap-1',
      method: 'tools/call',
      params: {
        name: 'ui_snapshot',
        arguments: { sessionId },
      },
    });
    expect(snapRes?.result).toBeDefined();
    const snapText = (snapRes?.result as any).content[0].text;
    expect(snapText).toContain('Click Me');

    // 3. ui_act / ui_tui_act
    const actRes = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'act-1',
      method: 'tools/call',
      params: {
        name: 'ui_tui_act',
        arguments: {
          sessionId,
          action: 'write',
          text: 'hello\n',
        },
      },
    });
    expect(actRes?.result).toBeDefined();
    const actData = JSON.parse((actRes?.result as any).content[0].text);
    expect(actData.ok).toBe(true);
    expect(actData.verdict).toBe('ACTED');

    // 4. ui_close
    const closeRes = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'close-1',
      method: 'tools/call',
      params: {
        name: 'ui_close',
        arguments: { sessionId },
      },
    });
    expect(closeRes?.result).toBeDefined();
    const closeData = JSON.parse((closeRes?.result as any).content[0].text);
    expect(closeData.closed).toBe(sessionId);
  });
});

describe('CLI flags for TUI', () => {
  it('parses --tui flag properly', () => {
    const parsed = parseFlags(['--tui', 'python3 app.py', '--cols', '100', '--rows', '30']);
    expect(parsed.opts.tui).toBe('python3 app.py');
    expect(parsed.opts.cols).toBe('100');
    expect(parsed.opts.rows).toBe('30');
  });
});
