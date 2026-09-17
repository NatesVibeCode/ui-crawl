import { describe, it, expect } from 'vitest';
import { buildFindingsJson, buildGalleryHtml } from '../src/report.js';
import type { CrawlResult } from '../src/types.js';

const result: CrawlResult = {
  baseUrl: 'http://localhost:3000',
  startedAt: '2026-06-21T00:00:00.000Z',
  finishedAt: '2026-06-21T00:01:00.000Z',
  pages: [
    {
      route: '/campaigns',
      template: '/campaigns',
      status: 200,
      screenshot: 'screenshots/campaigns.png',
      zoomShots: [],
      consoleErrors: [],
      failedRequests: [],
      controlCount: 4,
    },
  ],
  findings: [
    { route: '/campaigns', type: 'dead-button', bucket: 'defect', severity: 'high', title: 'Dead: "Send"', evidence: { selector: 'button:nth(2)' } },
    { route: '/campaigns', type: 'maybe-contextual-button', bucket: 'taste', severity: 'medium', title: 'Did nothing: "<script>"', evidence: {} },
  ],
};

describe('report builders', () => {
  it('findings json carries a summary', () => {
    const parsed = JSON.parse(buildFindingsJson(result));
    expect(parsed.summary.defects).toBe(1);
    expect(parsed.summary.taste).toBe(1);
    expect(parsed.findings).toHaveLength(2);
  });

  it('gallery html is self-contained and escapes finding text', () => {
    const html = buildGalleryHtml(result);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('ui-crawl report');
    expect(html).toContain('/campaigns');
    expect(html).toContain('1 defects');
    // escaped, not injected:
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('Did nothing: "<script>"');
  });

  it('renders contrast swatches and palette dots when present', () => {
    const richResult: CrawlResult = {
      baseUrl: 'http://localhost:3000',
      startedAt: '2026-06-21T00:00:00.000Z',
      finishedAt: '2026-06-21T00:01:00.000Z',
      pages: [
        {
          route: '/dashboard',
          template: '/dashboard',
          status: 200,
          consoleErrors: [],
          failedRequests: [],
          controlCount: 2,
          palette: {
            backgrounds: ['#0d1117', '#161b22'],
            text: ['#c9d1d9'],
            accents: ['#58a6ff'],
          },
        },
      ],
      findings: [
        {
          route: '/dashboard',
          type: 'low-contrast',
          bucket: 'taste',
          severity: 'medium',
          title: 'Low text contrast',
          evidence: {
            selector: 'p.muted',
            contrast: {
              ratio: 4.1,
              fg: '#777777',
              bg: '#ffffff',
              fontSize: '14px',
              fontWeight: '400',
              textSample: 'Subtle caption',
            },
          },
        },
      ],
    };
    const html = buildGalleryHtml(richResult);
    expect(html).toContain('palette-bar');
    expect(html).toContain('#0d1117');
    expect(html).toContain('#58a6ff');
    expect(html).toContain('contrast-row');
    expect(html).toContain('4.1:1');
    expect(html).toContain('fg: #777777');
  });

  it('renders affordance badge and style transitions when present', () => {
    const affordanceResult: CrawlResult = {
      baseUrl: 'http://localhost:3000',
      startedAt: '2026-06-21T00:00:00.000Z',
      finishedAt: '2026-06-21T00:01:00.000Z',
      pages: [],
      findings: [
        {
          route: '/settings',
          type: 'missing-affordance',
          bucket: 'taste',
          severity: 'medium',
          title: 'Missing affordance on button',
          evidence: {
            selector: 'button:nth(0)',
            affordance: {
              checkedStyles: ['cursor', 'backgroundColor'],
              hadPointer: false,
              hadHoverChange: false,
              hadFocusChange: false,
              hadActiveChange: false,
            },
          },
        },
      ],
    };
    const html = buildGalleryHtml(affordanceResult);
    expect(html).toContain('affordance-row');
    expect(html).toContain('cursor: default');
    expect(html).toContain('no :hover delta');
  });
});
