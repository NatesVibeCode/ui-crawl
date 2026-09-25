import { describe, it, expect } from 'vitest';
import { resolveConfig, crawlUserAgent } from '../src/config.js';

describe('resolveConfig', () => {
  it('requires baseUrl', () => {
    // @ts-expect-error intentionally missing
    expect(() => resolveConfig({})).toThrow(/baseUrl is required/);
  });

  it('rejects an invalid baseUrl', () => {
    expect(() => resolveConfig({ baseUrl: 'not a url' })).toThrow(/not a valid URL/);
  });

  it('rejects invalid numeric guardrails', () => {
    expect(() => resolveConfig({ baseUrl: 'http://localhost:3000', maxPages: 0 })).toThrow(/invalid maxPages/);
    expect(() => resolveConfig({ baseUrl: 'http://localhost:3000', zoomLevels: [Infinity] })).toThrow(/invalid zoom level/);
    expect(() => resolveConfig({ baseUrl: 'http://localhost:3000', interactionTimeoutMs: -1 })).toThrow(/invalid interactionTimeoutMs/);
    expect(() => resolveConfig({ baseUrl: 'http://localhost:3000', navTimeoutMs: 0 })).toThrow(/invalid navTimeoutMs/);
  });

  it('rejects invalid viewports', () => {
    expect(() =>
      resolveConfig({ baseUrl: 'http://localhost:3000', viewports: [{ width: 0, height: 800, label: 'broken' }] }),
    ).toThrow(/invalid viewport/);
  });

  it('fills defaults and computes origin', () => {
    const c = resolveConfig({ baseUrl: 'http://localhost:3000/' });
    expect(c.baseUrl).toBe('http://localhost:3000');
    expect(c.origin).toBe('http://localhost:3000');
    expect(c.routes).toBe('discover');
    expect(c.maxPages).toBe(25);
    expect(c.zoomLevels).toEqual([1, 1.5, 2]);
    expect(c.interactionTimeoutMs).toBe(1500);
    expect(c.headless).toBe(true);
    expect(c.observeControls).toBe(false);
    expect(c.guidance).toBe(true);
    expect(c.networkInventory).toBe(true);
    expect(c.userAgent).toBeUndefined();
  });

  it('honors observeControls when explicitly enabled', () => {
    const c = resolveConfig({ baseUrl: 'http://x', observeControls: true });
    expect(c.observeControls).toBe(true);
  });

  it('honors guidance / networkInventory / userAgent overrides', () => {
    const c = resolveConfig({
      baseUrl: 'http://example.com',
      guidance: false,
      networkInventory: false,
      userAgent: 'my-bot/1.0',
    });
    expect(c.guidance).toBe(false);
    expect(c.networkInventory).toBe(false);
    expect(c.userAgent).toBe('my-bot/1.0');
  });

  it('crawlUserAgent: undefined on loopback, ui-crawl/ on real hosts, override wins', () => {
    expect(crawlUserAgent('http://localhost:3000')).toBeUndefined();
    expect(crawlUserAgent('http://127.0.0.1:8080')).toBeUndefined();
    expect(crawlUserAgent('https://example.com')).toMatch(/^ui-crawl\//);
    expect(crawlUserAgent('https://example.com', 'custom/1')).toBe('custom/1');
  });

  it('honors overrides', () => {
    const c = resolveConfig({ baseUrl: 'http://x', routes: ['/a'], maxPages: 3, skipZoom: true, headless: false });
    expect(c.routes).toEqual(['/a']);
    expect(c.maxPages).toBe(3);
    expect(c.skipZoom).toBe(true);
    expect(c.headless).toBe(false);
  });
});
