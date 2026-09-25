import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startUiServer, broadcastEvent, type UiServer } from '../src/index.js';

describe('server: local UI console and REST endpoints', () => {
  let server: UiServer;

  beforeAll(async () => {
    // Port 0 binds to an ephemeral port
    server = await startUiServer({ port: 0, dbPath: ':memory:' });
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  it('binds to an ephemeral port and reports url', () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toContain(`http://127.0.0.1:${server.port}`);
  });

  it('serves dashboard HTML on GET / and GET /index.html', async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('ui-crawl // console');
    expect(html).toContain('<title>ui-crawl — Machine UI Audit Console</title>');

    const res2 = await fetch(`${server.url}/index.html`);
    expect(res2.status).toBe(200);
  });

  it('handles CORS preflight', async () => {
    const res = await fetch(`${server.url}/api/runs`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns empty runs list on GET /api/runs with fresh db', async () => {
    const res = await fetch(`${server.url}/api/runs`);
    expect(res.status).toBe(200);
    const runs = await res.json();
    expect(Array.isArray(runs)).toBe(true);
    expect(runs).toHaveLength(0);
  });

  it('returns 404 for nonexistent finding ID on GET /api/finding/:id', async () => {
    const res = await fetch(`${server.url}/api/finding/f-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Finding not found');
  });

  it('returns 404 for unknown endpoints', async () => {
    const res = await fetch(`${server.url}/unknown/endpoint`);
    expect(res.status).toBe(404);
  });

  it('streams events over GET /api/events', async () => {
    const controller = new AbortController();
    const res = await fetch(`${server.url}/api/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let text = '';
    // Read the first chunk (connected event)
    const { value } = await reader!.read();
    text += decoder.decode(value);
    expect(text).toContain('event: connected');
    expect(text).toContain('clientId');

    // Broadcast a custom test event
    broadcastEvent('custom-ping', { hello: 'world' });
    const { value: pingVal } = await reader!.read();
    const pingText = decoder.decode(pingVal);
    expect(pingText).toContain('event: custom-ping');
    expect(pingText).toContain('"hello":"world"');

    controller.abort();
  });
});
