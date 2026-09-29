import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { crawl } from '../src/index.js';
import { buildAgentPayload } from '../src/report.js';

/**
 * Vision-channel coverage against a real renderer. The bugs this guards are the ones that
 * only exist with real pixels: below-fold crops (Playwright clips against the viewport
 * image, not the document), viewport vs full-page screenshot sizes, and crop files that
 * the payload claims exist but do not.
 *
 * Gated behind UI_CRAWL_LIVE=1 like the other browser suites. Run with `npm run test:live`.
 */
const LIVE = process.env.UI_CRAWL_LIVE === '1';

/** PNG IHDR width/height without any dependency. */
function pngSize(abs: string): { width: number; height: number } {
  const buf = readFileSync(abs);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe.skipIf(!LIVE)('vision channel (live)', () => {
  const root = path.join(tmpdir(), `uic-vision-${process.pid}`);
  const outDir = path.join(root, 'out');

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    // The defect lives ~3200px down the document: far enough that no viewport-sized
    // image taken at scroll 0 contains it.
    writeFileSync(
      path.join(root, 'index.html'),
      '<!doctype html><html><body>' +
        '<div style="height:3000px"><p>scroll down</p></div>' +
        '<p id="faint" style="color:#b4b4b4;background:#fafafa">faint deep text</p>' +
        '<div style="height:2000px"></div>' +
        '</body></html>',
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('photographs a below-fold finding instead of silently skipping it', async () => {
    const { serveStatic } = await import('../src/serve.js');
    const server = await serveStatic(root);
    try {
      const result = await crawl({
        baseUrl: server.url,
        routes: ['/index.html'],
        outDir,
        dbPath: ':memory:',
        captureCrops: true,
        skipInteractionSweep: true,
        skipZoom: true,
        guidance: false,
        networkInventory: false,
      });

      const payload = buildAgentPayload(result);
      const failing = payload.actions.filter((a) => a.type === 'low-contrast');
      expect(failing.length).toBeGreaterThan(0);

      for (const action of failing) {
        // Inline pixels for callers without filesystem access…
        expect(action.cropBase64).toMatch(/^data:image\/png;base64,/);
        // …and a file for callers with it. The payload must never claim a file that is
        // not on disk.
        expect(action.crop).toBeTypeOf('string');
        expect(existsSync(path.join(outDir, action.crop!))).toBe(true);
      }
    } finally {
      await server.close();
    }
  }, 120000);

  it('keeps the readable viewport shot separate from the whole-document map', async () => {
    const { serveStatic } = await import('../src/serve.js');
    const server = await serveStatic(root);
    try {
      const result = await crawl({
        baseUrl: server.url,
        routes: ['/index.html'],
        outDir,
        dbPath: ':memory:',
        skipInteractionSweep: true,
        skipZoom: true,
        guidance: false,
        networkInventory: false,
      });
      const payload = buildAgentPayload(result);
      const page = payload.pages[0];

      // The viewport shot is model-legible…
      const shot = pngSize(path.join(outDir, page.screenshot!));
      expect(shot.width).toBe(1280);
      expect(shot.height).toBe(800);

      // …and the full document render exists separately because this page is tall.
      expect(page.screenshotFull).toBeTypeOf('string');
      const full = pngSize(path.join(outDir, page.screenshotFull!));
      expect(full.width).toBe(1280);
      expect(full.height).toBeGreaterThan(800);
    } finally {
      await server.close();
    }
  }, 120000);
});

describe.skipIf(!LIVE)('MCP image delivery (live)', () => {
  it('ui_open and ui_act return viewable image blocks, not just paths', async () => {
    const { handleMcpMessage } = await import('../src/mcp.js');

    const opened = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ui_open',
        arguments: { dir: 'fixtures/static-site', route: '/index.html', outDir: `${tmpdir()}/uic-mcp-img` },
      },
    });
    const openContent = (opened?.result as { content: Array<{ type: string }> }).content;
    const openState = JSON.parse((openContent[0] as unknown as { text: string }).text);
    expect(openState.sessionId).toMatch(/^sess_/);
    const openImage = openContent.find((c) => c.type === 'image') as unknown as { data: string; mimeType: string };
    expect(openImage.mimeType).toBe('image/png');
    // A real PNG, not a JSON error serialized as base64.
    expect(Buffer.from(openImage.data, 'base64').subarray(1, 4).toString()).toBe('PNG');

    const acted = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'ui_act',
        arguments: { sessionId: openState.sessionId, action: 'click', index: 0 },
      },
    });
    const actContent = (acted?.result as { content: Array<{ type: string }> }).content;
    const actState = JSON.parse((actContent[0] as unknown as { text: string }).text);
    expect(actState.verdict).toBe('ACTED');
    expect(actContent.some((c) => c.type === 'image')).toBe(true);

    await handleMcpMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ui_close', arguments: { sessionId: openState.sessionId } },
    });
  }, 120000);
});

describe.skipIf(!LIVE)('login flow (live)', () => {
  it('replays a login, captures state, and reuses it for an authed audit', async () => {
    const { handleMcpMessage } = await import('../src/mcp.js');
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { default: path } = await import('node:path');

    // A toy gated app: /login sets localStorage and links onward; /app shows the secret.
    const root = path.join(tmpdir(), `uic-login-${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, 'login.html'),
      '<!doctype html><html><body>' +
        '<input id="user" aria-label="Username"><button id="go">Sign in</button>' +
        '<script>document.getElementById("go").onclick = () => {' +
        'localStorage.setItem("authed", document.getElementById("user").value || "anon");' +
        'location.href = "/app.html";};</script></body></html>',
    );
    writeFileSync(
      path.join(root, 'app.html'),
      '<!doctype html><html><body><p id="secret">dashboard-secret</p></body></html>',
    );

    try {
      const login = await handleMcpMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ui_login',
          arguments: {
            dir: root,
            route: '/login.html',
            steps: [
              { action: 'fill', index: 0, value: 'nate' },
              { action: 'click', index: 1 },
            ],
          },
        },
      });
      const loginContent = (login?.result as { content: Array<{ type: string }> }).content;
      const body = JSON.parse((loginContent[0] as unknown as { text: string }).text);
      expect(body.steps).toHaveLength(2);
      // The captured state really holds the login's localStorage write.
      const origins = (body.storageState as { origins: Array<{ localStorage: Array<{ name: string; value: string }> }> }).origins;
      const stored = origins.flatMap((o) => o.localStorage);
      expect(stored).toContainEqual({ name: 'authed', value: 'nate' });
      // …and the final render is attached for a vision caller to confirm.
      expect(loginContent.some((c) => c.type === 'image')).toBe(true);

      // The state object feeds straight back into an audit as an authenticated context.
      const { serveStatic } = await import('../src/serve.js');
      const { crawl } = await import('../src/index.js');
      const server = await serveStatic(root);
      try {
        const result = await crawl({
          baseUrl: server.url,
          routes: ['/app.html'],
          outDir: path.join(root, 'out'),
          dbPath: ':memory:',
          storageState: body.storageState,
          skipInteractionSweep: true,
          skipZoom: true,
          guidance: false,
          networkInventory: false,
        });
        expect(result.pages[0].status).toBe(200);
      } finally {
        await server.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);

  it('rejects an empty step list instead of opening a browser for nothing', async () => {
    const { handleMcpMessage } = await import('../src/mcp.js');
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ui_login', arguments: { url: 'http://localhost:1', steps: [] } },
    });
    const result = res?.result as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});

describe.skipIf(!LIVE)('MCP server lifecycle (live)', () => {
  it('exits after stdin closes even with a session left open', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['bin/ui-crawl.js', '--mcp'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const out: string[] = [];
    child.stdout.on('data', (d) => out.push(d.toString()));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'ui_open',
          arguments: { dir: 'fixtures/static-site', route: '/index.html', outDir: `${tmpdir()}/uic-mcp-hang` },
        },
      }) + '\n',
    );
    // Wait for the opened response, then close stdin WITHOUT ui_close.
    const opened = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ui_open response')), 60000);
      const onData = () => {
        const text = out.join('');
        if (text.includes('"id":1')) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve(text);
        }
      };
      child.stdout.on('data', onData);
    });
    expect(opened).toContain('sessionId');
    child.stdin.end();

    // An orphaned browser would wedge shutdown indefinitely; it must exit promptly.
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve('TIMEOUT' as unknown as null);
      }, 30000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(0);
  }, 120000);
});

describe.skipIf(!LIVE)('remediation verification (live)', () => {
  it('proves a suggestion works, warns on !important, and catches text-fill overrides', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { default: path } = await import('node:path');
    const { serveStatic } = await import('../src/serve.js');
    const { auditPageColors } = await import('../src/index.js');
    const { chromium } = await import('playwright');

    const root = path.join(tmpdir(), `uic-verify-${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, 'index.html'),
      '<!doctype html><html><head><style>' +
        'p#stubborn { color: #b4b4b4 !important; background: #fafafa; }' +
        'p#painted { color: #a8a8a8; background: #f8f8f8; -webkit-text-fill-color: #a8a8a8; }' +
        'p#plain { color: #9a9a9a; background: #f5f5f5; }' +
        '</style></head><body>' +
        '<p id="stubborn">stubborn</p><p id="painted">painted</p><p id="plain">plain</p>' +
        '</body></html>',
    );

    const server = await serveStatic(root);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(server.url + '/index.html', { waitUntil: 'domcontentloaded' });
      const { rawFindings } = await auditPageColors(page, '/index.html');
      expect(rawFindings).toHaveLength(3);

      const bySelector = new Map(rawFindings.map((f) => [f.evidence.selector, f]));
      // Plain case: suggestion verified, ratio re-measured in-page.
      const plain = bySelector.get('p#plain')!.evidence.contrast!;
      expect(plain.verified).toBe(true);
      expect(plain.verifiedRatio).toBeGreaterThanOrEqual(4.5);
      // !important case: value works, but the agent must match cascade weight.
      const stubborn = bySelector.get('p#stubborn')!.evidence.contrast!;
      expect(stubborn.verified).toBe(true);
      expect(bySelector.get('p#stubborn')!.evidence.remediation).toContain('!important');
      // Text-fill case: the suggestion is right and useless — the finding says so.
      const painted = bySelector.get('p#painted')!.evidence.contrast!;
      expect(painted.verified).toBe(false);
      expect(bySelector.get('p#painted')!.evidence.remediation).toContain('-webkit-text-fill-color');
    } finally {
      await browser.close().catch(() => {});
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});

describe.skipIf(!LIVE)('badge legend (live)', () => {
  it('actions name the snapshot index their element wears in marked renders', async () => {
    const { serveStatic } = await import('../src/serve.js');
    const { crawl } = await import('../src/index.js');
    const { snapshotUrl } = await import('../src/snapshot.js');
    const { tmpdir } = await import('node:os');

    const server = await serveStatic('fixtures/static-site');
    try {
      const entries = await snapshotUrl({ url: `${server.url}/index.html` });
      const throwsEntry = entries.find((e) => e.name === 'Throws on click')!;
      expect(throwsEntry.index).toBe(3);

      const result = await crawl({
        baseUrl: server.url,
        routes: ['/index.html'],
        outDir: `${tmpdir()}/uic-legend-${process.pid}`,
        dbPath: ':memory:',
        captureCrops: true,
        skipInteractionSweep: false,
        skipZoom: true,
        guidance: false,
        networkInventory: false,
      });
      const threw = result.findings.find((f) => f.type === 'button-threw')!;
      // Badge 3 sits on "Throws on click" in the marked render; the action says [3].
      expect(threw.evidence.snapshotIndex).toBe(throwsEntry.index);
      // A non-interactive element wears no badge and claims none.
      const faint = result.findings.find(
        (f) => f.type === 'low-contrast' && f.evidence.selector === 'button#disabledBtn',
      )!;
      expect(faint.evidence.snapshotIndex).toBe(6);
    } finally {
      await server.close();
      const { rmSync } = await import('node:fs');
      rmSync(`${tmpdir()}/uic-legend-${process.pid}`, { recursive: true, force: true });
    }
  }, 180000);
});

describe.skipIf(!LIVE)('interaction primitives (live)', () => {
  it('hover reveals a menu, dialog decisions commit, fillForm fills once', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { default: path } = await import('node:path');
    const { UiSession } = await import('../src/session.js');

    const root = path.join(tmpdir(), `uic-acts-${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, 'index.html'),
      '<!doctype html><html><body>' +
        '<button id="m">Menu</button><div id="panel" hidden><a href="/go?a=1">item</a></div>' +
        '<script>document.getElementById("m").addEventListener("mouseenter", () => {' +
        'document.getElementById("panel").hidden = false; });</script>' +
        '<button id="del">Delete</button><p id="out">pending</p>' +
        '<script>document.getElementById("del").onclick = () => {' +
        'document.getElementById("out").textContent = confirm("sure?") ? "deleted" : "kept"; };</script>' +
        '<form action="/go" method="get"><input name="a" aria-label="A">' +
        '<input name="b" aria-label="B"><button>Go</button></form>' +
        '</body></html>',
    );

    const s = await UiSession.open({ dir: root }, { outDir: path.join(root, 'out') });
    try {
      const entries = await s.snapshot();
      const byName = new Map(entries.map((e) => [e.name, e]));

      // Hover: the menu reveals via a hidden-attribute toggle — a semantic mutation.
      const hovered = await s.act({ type: 'hover', index: byName.get('Menu')!.index });
      expect(hovered.ok).toBe(true);
      expect(hovered.verdict).toBe('ACTED');
      expect(hovered.snapshot).toContain('item');

      // Dialog accept: the confirm commits and the page shows it.
      const accepted = await s.act(
        { type: 'click', index: byName.get('Delete')!.index },
        { dialog: { decision: 'accept' } },
      );
      expect(accepted.dialog?.decision).toBe('accepted');
      expect(accepted.verdict).toBe('ACTED');

      // fillForm: both fields in one step, proven by the GET query the submit carries.
      const fresh = await s.snapshot();
      const freshByName = new Map(fresh.map((e) => [e.name, e]));
      const filled = await s.act({
        type: 'fillForm',
        fields: [
          { index: freshByName.get('A')!.index, value: 'hello' },
          { index: freshByName.get('B')!.index, value: 'world' },
        ],
      });
      expect(filled.ok).toBe(true);
      const go = (await s.snapshot()).find((e) => e.name === 'Go')!;
      const submitted = await s.act({ type: 'click', index: go.index });
      expect(submitted.navigated).toBe(true);
      expect(submitted.url).toContain('a=hello');
      expect(submitted.url).toContain('b=world');
    } finally {
      await s.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180000);
});

describe.skipIf(!LIVE)('shadow DOM coverage (live)', () => {
  it('lists, badges, probes, and resolves controls inside an open shadow root', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { default: path } = await import('node:path');
    const { serveStatic } = await import('../src/serve.js');
    const { buildSnapshot, markControls, formatSnapshot } = await import('../src/snapshot.js');
    const { enumerateControls, resolveControl } = await import('../src/interactions.js');
    const { chromium } = await import('playwright');

    const root = path.join(tmpdir(), `uic-shadow-${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, 'index.html'),
      '<!doctype html><html><body><button id="light">Light button</button><div id="host"></div>' +
        '<script>const r = document.getElementById("host").attachShadow({ mode: "open" });' +
        'r.innerHTML = \'<button id="shadow-btn">Shadow button</button>\' +' +
        '  \'<div id="deep"></div>\';' +
        'r.getElementById("shadow-btn").addEventListener("click", () => {' +
        '  document.getElementById("light").textContent = "shadow click landed"; });' +
        'r.getElementById("deep").innerHTML = "<button>deep shadow button</button>";</script>' +
        '</body></html>',
    );

    const server = await serveStatic(root);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(server.url + '/index.html', { waitUntil: 'domcontentloaded' });

      // 1. The snapshot sees through the shadow boundary.
      const entries = await buildSnapshot(page);
      const names = entries.map((e) => e.name);
      expect(names).toContain('Shadow button');
      expect(names).toContain('deep shadow button');
      expect(formatSnapshot(entries)).toMatch(/\[1\] button "Shadow button"/);

      // 2. The addressing invariant: [n] is the same element the sweep and badges use.
      const controls = await enumerateControls(page);
      expect(controls.map((c) => c.accessibleName)).toContain('Shadow button');
      for (const c of controls) {
        const entry = entries.find((e) => e.index === c.index);
        expect(entry, `snapshot entry for control index ${c.index}`).toBeDefined();
        const locator = await resolveControl(page, c);
        expect(((await locator!.textContent()) ?? '').trim()).toBe(entry!.name);
        expect(c.snapshotIndex).toBe(entry!.index);
      }

      // 3. A click by index reaches into the shadow root.
      const shadow = entries.find((e) => e.name === 'Shadow button')!;
      await page.locator('button').nth(shadow.index).click();
      expect(await page.locator('#light').textContent()).toBe('shadow click landed');

      // 4. Badges land on shadow controls, and leave nothing behind.
      const marks = await markControls(page);
      expect(marks.count).toBe(entries.filter((e) => e.visible).length);
      await marks.cleanup();
      expect(await page.locator('[data-uicrawl-marks]').count()).toBe(0);
    } finally {
      await browser.close().catch(() => {});
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180000);
});

describe.skipIf(!LIVE)('shadow DOM: end-to-end audit (live)', () => {
  it('finds, locates, badges, and crops defects inside a shadow root', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { default: path } = await import('node:path');
    const { serveStatic } = await import('../src/serve.js');
    const { crawl } = await import('../src/index.js');
    const { buildAgentPayload } = await import('../src/report.js');

    const root = path.join(tmpdir(), `uic-shadow-audit-${process.pid}`);
    const outDir = path.join(root, 'out');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, 'index.html'),
      '<!doctype html><html><body><button id="light">Light</button><div id="host"></div><script>' +
        'const r = document.getElementById("host").attachShadow({ mode: "open" });' +
        'r.innerHTML = \'<button id="shadow-btn">Shadow button</button>\' +' +
        '  \'<img src="x.png">\' +' +
        'r.getElementById("shadow-btn").addEventListener("click", () => {});' +
        '</script></body></html>',
    );

    const server = await serveStatic(root);
    try {
      const result = await crawl({
        baseUrl: server.url,
        routes: ['/index.html'],
        outDir,
        dbPath: ':memory:',
        captureCrops: true,
        skipInteractionSweep: true,
        skipZoom: true,
        guidance: false,
        networkInventory: false,
      });
      const payload = buildAgentPayload(result);
      expect(payload.actions.length).toBeGreaterThan(0);
      // The fixture plants a shadow <img src="x.png"> with no alt and a shadow <button>.
      // Assert the specific defect types the piercing is supposed to surface, not just
      // "something" — otherwise a detector silently dropping its shadow findings still
      // passes as long as one unrelated finding survives.
      const types = payload.actions.map((a) => a.type);
      expect(types, `shadow audit finding types: ${types.join(', ')}`).toContain('missing-image-alt');
      // Coverage is only trustworthy if no detector crashed silently.
      expect(payload.summary.detectorFailures).toEqual([]);
      for (const action of payload.actions) {
        // Every finding in a shadow root must still be locatable, photographable, and
        // tied to a badge — otherwise the crop would silently be missing.
        expect(action.cropBase64, `crop for ${action.type} ${action.selector ?? ''}`).toMatch(
          /^data:image\/png;base64,/,
        );
        expect(action.snapshotIndex, `badge for ${action.type} ${action.selector ?? ''}`).toBeTypeOf(
          'number',
        );
      }
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180000);
});
