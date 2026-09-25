import { describe, it, expect } from 'vitest';
import { buildFindingsJson, buildAgentPayload } from '../src/report.js';
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
    {
      route: '/campaigns',
      type: 'dead-button',
      bucket: 'defect',
      severity: 'high',
      title: 'Dead: "Send"',
      evidence: { selector: 'button:nth(2)' },
      remediation: 'Ensure click handler attaches to button:nth(2)',
    },
    {
      route: '/campaigns',
      type: 'maybe-contextual-button',
      bucket: 'taste',
      severity: 'medium',
      title: 'Did nothing: "<script>"',
      evidence: {},
    },
  ],
};

describe('report builders', () => {
  it('findings json carries a summary', () => {
    const parsed = JSON.parse(buildFindingsJson(result));
    expect(parsed.summary.defects).toBe(1);
    expect(parsed.summary.taste).toBe(1);
    expect(parsed.findings).toHaveLength(2);
  });

  it('buildAgentPayload produces machine-consumable action plan with verdict has_defects', () => {
    const payload = buildAgentPayload(result);
    expect(payload.verdict).toBe('has_defects');
    expect(payload.summary.defects).toBe(1);
    expect(payload.summary.taste).toBe(1);
    expect(payload.summary.pagesCrawled).toBe(1);
    expect(payload.routes).toEqual(['/campaigns']);
    expect(payload.actions).toHaveLength(2);

    const first = payload.actions[0];
    expect(first.route).toBe('/campaigns');
    expect(first.type).toBe('dead-button');
    expect(first.bucket).toBe('defect');
    expect(first.severity).toBe('high');
    expect(first.selector).toBe('button:nth(2)');
    expect(first.remediation).toBe('Ensure click handler attaches to button:nth(2)');
  });

  it('buildAgentPayload correctly marks taste questions vs clean verdict', () => {
    const tasteOnly: CrawlResult = {
      ...result,
      findings: [
        {
          route: '/campaigns',
          type: 'low-contrast',
          bucket: 'taste',
          severity: 'medium',
          title: 'Low contrast',
          evidence: {},
        },
      ],
    };
    expect(buildAgentPayload(tasteOnly).verdict).toBe('has_taste_questions');

    const cleanResult: CrawlResult = {
      ...result,
      findings: [],
    };
    expect(buildAgentPayload(cleanResult).verdict).toBe('clean');
  });

  it('preserves contrast, layout, and remediation in agent actions', () => {
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
          remediation: 'Change color from #777777 to darker tone #595959 for 4.5:1 contrast against #ffffff',
        },
        {
          route: '/dashboard',
          type: 'layout-overlap',
          bucket: 'defect',
          severity: 'high',
          title: 'In-flow elements collide',
          evidence: {
            selector: '.card-index',
            layout: {
              otherSelector: '.badge',
              overlapFrac: 0.35,
            },
          },
          remediation: 'Add flex-wrap: wrap to container',
        },
      ],
    };

    const payload = buildAgentPayload(richResult);
    expect(payload.verdict).toBe('has_defects');
    expect(payload.actions).toHaveLength(2);

    const contrastAct = payload.actions.find((a) => a.type === 'low-contrast')!;
    expect(contrastAct.selector).toBe('p.muted');
    expect(contrastAct.remediation).toContain('#595959');
    expect(contrastAct.evidence?.contrast?.ratio).toBe(4.1);

    const layoutAct = payload.actions.find((a) => a.type === 'layout-overlap')!;
    expect(layoutAct.selector).toBe('.card-index');
    expect(layoutAct.evidence?.layout?.otherSelector).toBe('.badge');
    expect(layoutAct.remediation).toBe('Add flex-wrap: wrap to container');
  });
});
