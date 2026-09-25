import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { serveStatic, discoverHtmlRoutes } from '../src/serve.js';

describe('serve: clean URLs and discovery', () => {
  it('discovers html routes in fixtures/static-site', () => {
    const fixtureDir = path.resolve(__dirname, '../fixtures/static-site');
    const routes = discoverHtmlRoutes(fixtureDir);
    expect(routes).toContain('/index.html');
    expect(routes).toContain('/contrast.html');
    expect(routes[0]).toBe('/index.html');
  });

  it('serves clean URLs without .html extension', async () => {
    const fixtureDir = path.resolve(__dirname, '../fixtures/static-site');
    const server = await serveStatic(fixtureDir);
    try {
      // Fetch /contrast (clean URL) which maps to /contrast.html
      const res = await fetch(`${server.url}/contrast`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('contrast fixture');
    } finally {
      await server.close();
    }
  });

  it('serves / as index.html', async () => {
    const fixtureDir = path.resolve(__dirname, '../fixtures/static-site');
    const server = await serveStatic(fixtureDir);
    try {
      const res = await fetch(`${server.url}/`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('UI Crawl Fixture');
    } finally {
      await server.close();
    }
  });

  it('returns 404 for non-existent files', async () => {
    const fixtureDir = path.resolve(__dirname, '../fixtures/static-site');
    const server = await serveStatic(fixtureDir);
    try {
      const res = await fetch(`${server.url}/does-not-exist`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
