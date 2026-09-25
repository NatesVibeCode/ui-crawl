import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { crawl } from './index.js';
import { openDatabase, getRunHistory, getDiff, getFindingById } from './db.js';
import { snapshotUrl, formatSnapshot } from './snapshot.js';
import { serveStatic, discoverHtmlRoutes, type StaticServer } from './serve.js';
import { buildAgentPayload, buildFindingsJson } from './report.js';
import type { CrawlConfig } from './config.js';

export interface UiServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface UiServerOptions {
  port?: number;
  dbPath?: string;
}


interface SseClient {
  id: number;
  res: ServerResponse;
}

const sseClients: SseClient[] = [];
let nextClientId = 1;

export function broadcastEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].res.write(payload);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ui-crawl — Machine UI Audit Console</title>
<style>
  :root {
    --bg: #0f1110;
    --surface: #181c19;
    --surface-raised: #202622;
    --border: #2e3831;
    --fg: #e8ebe8;
    --muted: #88948b;
    --accent: #6ee7b7;
    --accent-dim: #1e3a2f;
    --defect: #f87171;
    --defect-dim: #3b1a1a;
    --taste: #fbbf24;
    --taste-dim: #362912;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--sans);
    line-height: 1.5;
    padding: 24px;
    max-width: 1300px;
    margin: 0 auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  .logo { font-size: 1.3rem; font-weight: 700; letter-spacing: -0.02em; font-family: var(--mono); color: var(--accent); }
  .tagline { color: var(--muted); font-size: 0.85rem; }
  .grid { display: grid; grid-template-columns: 360px 1fr; gap: 24px; }
  @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px;
    margin-bottom: 20px;
  }
  h2 { font-size: 1rem; font-weight: 600; margin-bottom: 12px; color: var(--fg); }
  .field { margin-bottom: 14px; }
  label { display: block; font-size: 0.8rem; font-weight: 500; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  input[type="text"], select {
    width: 100%;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg);
    padding: 8px 10px;
    font-family: var(--mono);
    font-size: 0.85rem;
  }
  input[type="text"]:focus, select:focus { outline: none; border-color: var(--accent); }
  .checkbox-group { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 6px; }
  .checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--fg); text-transform: none; cursor: pointer; }
  .btn-row { display: flex; gap: 10px; margin-top: 18px; }
  button {
    background: var(--accent);
    color: #052e16;
    border: none;
    border-radius: 6px;
    padding: 8px 14px;
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  button:hover { opacity: 0.9; }
  button.secondary { background: var(--surface-raised); color: var(--fg); border: 1px solid var(--border); }
  #progress {
    font-family: var(--mono);
    font-size: 0.8rem;
    padding: 10px;
    background: var(--bg);
    border-radius: 6px;
    border: 1px solid var(--border);
    min-height: 52px;
    max-height: 140px;
    overflow-y: auto;
    color: var(--muted);
    white-space: pre-wrap;
  }
  .verdict-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-radius: 6px;
    margin-bottom: 16px;
    font-weight: 600;
  }
  .verdict-clean { background: var(--accent-dim); color: var(--accent); border: 1px solid var(--accent); }
  .verdict-defects { background: var(--defect-dim); color: var(--defect); border: 1px solid var(--defect); }
  .finding-card {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px;
    margin-bottom: 12px;
  }
  .finding-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    font-family: var(--mono);
  }
  .badge-defect { background: var(--defect-dim); color: var(--defect); border: 1px solid var(--defect); }
  .badge-taste { background: var(--taste-dim); color: var(--taste); border: 1px solid var(--taste); }
  .finding-title { font-weight: 600; font-size: 0.95rem; margin-right: 8px; }
  .finding-meta { font-family: var(--mono); font-size: 0.8rem; color: var(--muted); margin-bottom: 8px; }
  .remediation {
    background: var(--bg);
    border-left: 3px solid var(--accent);
    padding: 8px 12px;
    font-size: 0.82rem;
    font-family: var(--mono);
    color: var(--fg);
    margin-top: 8px;
    border-radius: 0 4px 4px 0;
  }
  .crop-preview { margin-top: 10px; max-width: 200px; border-radius: 4px; border: 1px solid var(--border); display: block; }
  .table { width: 100%; border-collapse: collapse; font-size: 0.82rem; font-family: var(--mono); }
  .table th, .table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .table th { color: var(--muted); font-weight: 500; }
</style>
</head>
<body>
<header>
  <div>
    <div class="logo">ui-crawl // console</div>
    <div class="tagline">Deterministic UI inspection & differential audit engine</div>
  </div>
  <div style="font-family: var(--mono); font-size: 0.8rem; color: var(--muted);">v0.1.0</div>
</header>

<div class="grid">
  <!-- LEFT: AUDIT CONTROLS -->
  <div>
    <div class="card">
      <h2>Run Audit</h2>
      <div class="field">
        <label for="target">Target URL or Directory</label>
        <input type="text" id="target" placeholder="http://localhost:3000 or ./dist" value="http://localhost:3000">
      </div>
      <div class="field">
        <label for="routes">Routes (comma-separated, optional)</label>
        <input type="text" id="routes" placeholder="Leave empty to auto-discover">
      </div>
      <div class="field">
        <label for="browser">Browser Engine</label>
        <select id="browser">
          <option value="chromium" selected>Chromium</option>
          <option value="webkit">WebKit (Safari)</option>
          <option value="firefox">Firefox</option>
        </select>
      </div>
      <div class="field">
        <label>Options</label>
        <div class="checkbox-group">
          <label class="checkbox-label"><input type="checkbox" id="quick" checked> Fast sweep (--quick)</label>
          <label class="checkbox-label"><input type="checkbox" id="themeSweep"> Dark theme sweep</label>
          <label class="checkbox-label"><input type="checkbox" id="crops" checked> Capture crops</label>
          <label class="checkbox-label"><input type="checkbox" id="defectsOnly"> Defects only</label>
        </div>
      </div>
      <div class="btn-row">
        <button id="btnRun" onclick="triggerAudit()">Launch Audit</button>
        <button class="secondary" onclick="triggerSnapshot()">Snapshot DOM</button>
      </div>
    </div>

    <div class="card">
      <h2>Live Progress</h2>
      <div id="progress">Idle. Ready for audit run.</div>
    </div>

    <div class="card">
      <h2>Recent Runs</h2>
      <table class="table" id="runsTable">
        <thead>
          <tr><th>Run ID</th><th>Defects</th><th>Taste</th><th>Pages</th></tr>
        </thead>
        <tbody>
          <tr><td colspan="4" style="color:var(--muted)">Loading history...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- RIGHT: AUDIT RESULTS -->
  <div>
    <div id="resultsContainer">
      <div class="card" style="text-align: center; color: var(--muted); padding: 48px;">
        Run an audit or select a past run from the left panel to inspect findings.
      </div>
    </div>
  </div>
</div>

<script>
  let evtSource;
  function initSse() {
    evtSource = new EventSource('/api/events');
    evtSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      const box = document.getElementById('progress');
      box.textContent = data.message || JSON.stringify(data);
      box.scrollTop = box.scrollHeight;
    });
  }
  initSse();

  async function loadHistory() {
    try {
      const res = await fetch('/api/runs');
      const runs = await res.json();
      const tbody = document.querySelector('#runsTable tbody');
      if (!runs || !runs.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No past runs found in database.</td></tr>';
        return;
      }
      tbody.innerHTML = runs.map(r => \`
        <tr style="cursor:pointer;" onclick="loadDiff('\${r.id}')">
          <td>\${r.id.slice(0, 16)}</td>
          <td style="color:\${r.defects_count > 0 ? 'var(--defect)' : 'var(--accent)'}">\${r.defects_count}</td>
          <td>\${r.taste_count}</td>
          <td>\${r.pages_count}</td>
        </tr>
      \`).join('');
    } catch {}
  }
  loadHistory();

  async function triggerAudit() {
    const btn = document.getElementById('btnRun');
    btn.disabled = true;
    btn.textContent = 'Auditing...';
    const target = document.getElementById('target').value.trim();
    const routesVal = document.getElementById('routes').value.trim();
    const browser = document.getElementById('browser').value;
    const quick = document.getElementById('quick').checked;
    const themeSweep = document.getElementById('themeSweep').checked;
    const crops = document.getElementById('crops').checked;
    const defectsOnly = document.getElementById('defectsOnly').checked;

    const payload = {
      target,
      routes: routesVal ? routesVal.split(',').map(s => s.trim()) : undefined,
      browser,
      quick,
      themeSweep,
      crops,
      defectsOnly
    };

    try {
      const res = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      renderResults(data);
      loadHistory();
    } catch (err) {
      alert('Audit failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Launch Audit';
    }
  }

  async function triggerSnapshot() {
    const target = document.getElementById('target').value.trim();
    try {
      const res = await fetch('/api/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
      });
      const data = await res.json();
      renderSnapshot(data);
    } catch (err) {
      alert('Snapshot failed: ' + err.message);
    }
  }

  function renderResults(payload) {
    const container = document.getElementById('resultsContainer');
    const isClean = payload.verdict === 'clean' || (payload.summary && payload.summary.defects === 0);
    const actions = payload.actions || [];

    let html = \`
      <div class="verdict-banner \${isClean ? 'verdict-clean' : 'verdict-defects'}">
        <div>Verdict: \${payload.verdict}</div>
        <div>\${payload.summary?.defects ?? 0} defects, \${payload.summary?.taste ?? 0} taste (\${payload.summary?.pagesCrawled ?? 0} pages)</div>
      </div>
    \`;

    if (!actions.length) {
      html += \`<div class="card" style="text-align: center; color: var(--accent); padding: 32px;">No defects or taste items detected. Clean run!</div>\`;
    } else {
      for (const a of actions) {
        html += \`
          <div class="finding-card">
            <div class="finding-header">
              <span class="finding-title">\${a.title}</span>
              <span class="badge badge-\${a.bucket}">\${a.type}</span>
            </div>
            <div class="finding-meta">\${a.route} &bull; \${a.selector}</div>
            \${a.remediation ? \`<div class="remediation">\${a.remediation}</div>\` : ''}
            \${a.cropBase64 ? \`<img class="crop-preview" src="\${a.cropBase64}" alt="Micro-crop evidence">\` : ''}
          </div>
        \`;
      }
    }
    container.innerHTML = html;
  }

  function renderSnapshot(entries) {
    const container = document.getElementById('resultsContainer');
    const text = Array.isArray(entries) ? entries.map(e => \`[\${e.index}] \${e.tag} "\${e.accessibleName}" \${e.disabled ? 'disabled' : ''}\`).join('\\n') : JSON.stringify(entries, null, 2);
    container.innerHTML = \`
      <div class="card">
        <h2>Semantic DOM Snapshot</h2>
        <pre style="background:var(--bg); border:1px solid var(--border); padding:14px; border-radius:6px; font-family:var(--mono); font-size:0.82rem; overflow-x:auto;">\${text}</pre>
      </div>
    \`;
  }
</script>
</body>
</html>`;

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const reqPort = options.port !== undefined ? options.port : 49152;
  const dbPath = options.dbPath ?? '.ui-crawl.db';

  const server: Server = createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    const method = req.method?.toUpperCase();

    // CORS headers for integration
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // SSE Endpoint
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const client = { id: nextClientId++, res };
      sseClients.push(client);
      req.on('close', () => {
        const idx = sseClients.indexOf(client);
        if (idx !== -1) sseClients.splice(idx, 1);
      });
      res.write(`event: connected\ndata: {"clientId": ${client.id}}\n\n`);
      return;
    }

    // Dashboard UI
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    // API: Runs History
    if (pathname === '/api/runs' && method === 'GET') {
      try {
        const db = openDatabase(dbPath);
        const limit = Number(urlObj.searchParams.get('limit') || 20);
        const runs = getRunHistory(db, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runs));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // API: Run Diff
    if (pathname === '/api/diff' && method === 'GET') {
      try {
        const db = openDatabase(dbPath);
        const runB = urlObj.searchParams.get('runB') || undefined;
        const runA = urlObj.searchParams.get('runA') || undefined;
        const diffRes = getDiff(db, runB ?? '', runA);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(diffRes));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // API: Finding by ID
    if (pathname.startsWith('/api/finding/') && method === 'GET') {
      try {
        const id = pathname.slice('/api/finding/'.length);
        const db = openDatabase(dbPath);
        const finding = getFindingById(db, id);
        if (!finding) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Finding not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finding));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // API: Snapshot
    if (pathname === '/api/snapshot' && method === 'POST') {
      try {
        const body = await parseJsonBody<{ target?: string; cap?: number }>(req);
        const target = body.target || '';
        const isUrl = target.startsWith('http://') || target.startsWith('https://');
        const entries = await snapshotUrl({
          url: isUrl ? target : undefined,
          dir: !isUrl ? target : undefined,
          cap: body.cap,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entries));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // API: Trigger Audit
    if (pathname === '/api/audit' && method === 'POST') {
      try {
        const body = await parseJsonBody<{
          target?: string;
          routes?: string[];
          browser?: 'chromium' | 'webkit' | 'firefox';
          quick?: boolean;
          themeSweep?: boolean;
          crops?: boolean;
          defectsOnly?: boolean;
          concurrency?: number;
        }>(req);

        let staticServer: StaticServer | undefined;
        let baseUrl = body.target || '';
        let routes = body.routes;

        if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
          staticServer = await serveStatic(baseUrl);
          baseUrl = staticServer.url;
          if (!routes || routes.length === 0) {
            routes = discoverHtmlRoutes(body.target || '');
          }
        }

        const crawlCfg: CrawlConfig = {
          baseUrl,
          routes,
          browser: body.browser ?? 'chromium',
          quick: body.quick ?? true,
          themeSweep: body.themeSweep ?? false,
          captureCrops: body.crops ?? true,
          concurrency: body.concurrency,
          dbPath,
          onProgress: (evt) => {
            broadcastEvent('progress', evt);
          },
        };

        try {
          const result = await crawl(crawlCfg);
          let payload = buildAgentPayload(result);
          if (body.defectsOnly) {
            payload.actions = payload.actions.filter((a) => a.bucket === 'defect');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } finally {
          if (staticServer) await staticServer.close();
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(reqPort, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const addr = server.address() as { port: number };
  const actualPort = addr.port;
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    url,
    port: actualPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
