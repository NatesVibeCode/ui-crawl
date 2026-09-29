import { describe, it, expect } from 'vitest';
import { buildFindingsJson, buildAgentPayload, buildFixPlan } from '../src/report.js';
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

it('carries detectorFailures through every output shape so a crashed detector is never silent', () => {
  const failures = [{ route: '/x', detector: 'contrast', message: 'boom' }];
  const result = {
    baseUrl: 'http://x',
    startedAt: '',
    finishedAt: '',
    pages: [],
    findings: [],
    detectorFailures: failures,
  };
  const payload = buildAgentPayload(result);
  expect(payload.summary.detectorFailures).toEqual(failures);
  // An empty defect count with a crashed detector is NOT a clean bill of health.
  const plan = buildFixPlan(result);
  expect(plan.done).toBe(false);
  expect(plan.summary.detectorFailures).toEqual(failures);
  expect(plan.exitCriteria).toContain('crashed');
  const full = JSON.parse(buildFindingsJson(result));
  expect(full.summary.detectorFailures).toEqual(failures);
});

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

describe('buildAgentPayload: the vision channel', () => {
  it('carries per-page screenshot paths so a vision model can look at what was audited', () => {
    // Without this the crawl writes screenshots that no agent is ever told about.
    const payload = buildAgentPayload(result);
    expect(payload.pages).toHaveLength(1);
    expect(payload.pages[0]).toEqual({
      route: '/campaigns',
      screenshot: 'screenshots/campaigns.png',
      zoomShots: [],
      status: 200,
      controlCount: 4,
    });
    // Full-document and dark renders are opt-in keys, never null placeholders: absent
    // means "not captured", which is different from "captured and empty".
    expect('screenshotFull' in payload.pages[0]).toBe(false);
    expect('darkScreenshot' in payload.pages[0]).toBe(false);
  });

  it('includes zoom renders and probe counts when they exist', () => {
    const rich: CrawlResult = {
      ...result,
      pages: [
        {
          route: '/x',
          template: '/x',
          status: 200,
          screenshot: 'screenshots/x.png',
          zoomShots: [{ zoom: 1.5, screenshot: 'screenshots/x@150.png' }],
          consoleErrors: [],
          failedRequests: [],
          controlCount: 9,
          probedControls: 8,
          skippedControls: 1,
        },
      ],
    };
    const page = buildAgentPayload(rich).pages[0];
    expect(page.zoomShots).toEqual([{ zoom: 1.5, screenshot: 'screenshots/x@150.png' }]);
    expect(page.probedControls).toBe(8);
    expect(page.skippedControls).toBe(1);
  });

  it('reports a null screenshot rather than omitting the key, so the shape is stable', () => {
    const noShot: CrawlResult = {
      ...result,
      pages: [
        { route: '/y', template: '/y', status: null, consoleErrors: [], failedRequests: [], controlCount: 0 },
      ],
    };
    const page = buildAgentPayload(noShot).pages[0];
    expect(page.screenshot).toBeNull();
    expect(page.zoomShots).toEqual([]);
    // Absent, not zero: "the sweep was skipped" is different from "we probed nothing".
    expect('probedControls' in page).toBe(false);
  });

  it('passes a suggested replacement colour through to the action', () => {
    const withSuggestion: CrawlResult = {
      ...result,
      findings: [
        {
          route: '/x',
          type: 'low-contrast',
          bucket: 'defect',
          severity: 'high',
          title: 'Low text contrast',
          evidence: {
            selector: 'p.faint',
            contrast: {
              ratio: 1.99, fg: '#b4b4b4', bg: '#fafafa',
              fontSize: '13px', fontWeight: '400',
              suggestedFg: '#737373', suggestedRatio: 4.54,
            },
          },
          remediation: 'Set color to #737373',
        },
      ],
    };
    const action = buildAgentPayload(withSuggestion).actions[0];
    expect(action.evidence?.contrast?.suggestedFg).toBe('#737373');
    expect(action.remediation).toBe('Set color to #737373');
  });

  it('findings.json records the report path the screenshot paths are relative to', () => {
    const parsed = JSON.parse(buildFindingsJson({ ...result, reportPath: '/tmp/out' }));
    expect(parsed.reportPath).toBe('/tmp/out');
  });
});

describe('buildAgentPayload: crop files and alternate renders', () => {
  it('exposes the crop file path next to the inline bytes', () => {
    const withCrop: CrawlResult = {
      ...result,
      findings: [
        {
          route: '/x',
          type: 'layout-overlap',
          bucket: 'defect',
          severity: 'high',
          title: 'collide',
          evidence: {
            selector: '.a',
            cropBase64: 'data:image/png;base64,AAA',
            crop: 'crops/x_0.png',
          },
        },
      ],
    };
    const action = buildAgentPayload(withCrop).actions[0];
    expect(action.cropBase64).toBe('data:image/png;base64,AAA');
    expect(action.crop).toBe('crops/x_0.png');
  });

  it('omits the crop keys entirely when there is no image, rather than nulling them', () => {
    const action = buildAgentPayload(result).actions[0];
    expect('cropBase64' in action).toBe(false);
    expect('crop' in action).toBe(false);
  });

  it('carries full-document and dark renders when the crawl captured them', () => {
    const rich: CrawlResult = {
      ...result,
      pages: [
        {
          route: '/x',
          template: '/x',
          status: 200,
          screenshot: 'screenshots/x.png',
          screenshotFull: 'screenshots/x@full.png',
          darkScreenshot: 'screenshots/x--dark.png',
          zoomShots: [],
          consoleErrors: [],
          failedRequests: [],
          controlCount: 1,
        },
      ],
    };
    const page = buildAgentPayload(rich).pages[0];
    expect(page.screenshotFull).toBe('screenshots/x@full.png');
    expect(page.darkScreenshot).toBe('screenshots/x--dark.png');
  });
});

describe('capFindings', () => {
  const mk = (route: string, bucket: 'defect' | 'taste', severity: 'high' | 'medium' | 'low', type: string = 'low-contrast') => ({
    route, type: type as never, bucket, severity,
    title: `${type} ${severity}`,
    evidence: {},
  });

  it('keeps defects over taste and high over low, stably', async () => {
    const { capFindings } = await import('../src/report.js');
    const findings = [
      mk('/a', 'taste', 'low'),
      mk('/a', 'taste', 'medium'),
      mk('/a', 'defect', 'low'),
      mk('/a', 'defect', 'high'),
    ];
    const { findings: kept, truncated } = capFindings(findings, 2);
    // Ranking decides WHAT survives; original order is preserved, so repeats agree.
    expect(kept.map((f) => f.severity)).toEqual(['low', 'high']);
    expect(kept.every((f) => f.bucket === 'defect')).toBe(true);
    expect(truncated).toBe(2);
  });

  it('caps per route, so one bad page cannot starve the rest', async () => {
    const { capFindings } = await import('../src/report.js');
    const findings = [
      mk('/bad', 'taste', 'low'), mk('/bad', 'taste', 'low'), mk('/bad', 'taste', 'low'),
      mk('/good', 'taste', 'low'),
    ];
    const { findings: kept, truncated } = capFindings(findings, 2);
    expect(kept.map((f) => f.route)).toEqual(['/bad', '/bad', '/good']);
    expect(truncated).toBe(1);
  });

  it('reports zero truncation when nothing was dropped', async () => {
    const { capFindings } = await import('../src/report.js');
    const { findings, truncated } = capFindings([mk('/a', 'defect', 'high')], 200);
    expect(findings).toHaveLength(1);
    expect(truncated).toBe(0);
  });
});

describe('buildGroups + sortActions', () => {
  const act = (over: Partial<import('../src/report.js').AgentAction> = {}): import('../src/report.js').AgentAction => ({
    route: '/x', type: 'low-contrast', bucket: 'taste', severity: 'medium', title: 't',
    ...over,
  });

  it('groups actions that share a fix site and counts them', async () => {
    const { buildGroups } = await import('../src/report.js');
    const src = { file: 'src/theme.css', line: 8 };
    const groups = buildGroups([
      act({ source: src, remediation: 'Set color to #737373', fingerprint: 'f1' }),
      act({ source: src, remediation: 'Set color to #737373', fingerprint: 'f2' }),
      act({ type: 'layout-overlap', remediation: 'other', fingerprint: 'f3' }),
    ]);
    expect(groups).toHaveLength(2);
    const [first, second] = groups;
    expect(first.count).toBe(2);
    expect(first.key).toBe('src:src/theme.css:8');
    expect(first.fingerprints).toEqual(['f1', 'f2']);
    expect(second.count).toBe(1);
  });

  it('promotes a group to defect when any member is one', async () => {
    const { buildGroups } = await import('../src/report.js');
    const src = { file: 'src/a.tsx', line: 1 };
    const [g] = buildGroups([
      act({ source: src, bucket: 'taste', severity: 'low' }),
      act({ source: src, bucket: 'defect', severity: 'medium' }),
    ]);
    expect(g.bucket).toBe('defect');
    expect(g.severity).toBe('medium');
    expect(g.count).toBe(2);
  });

  it('groups unsourced findings by type and remediation, not by title', async () => {
    const { buildGroups } = await import('../src/report.js');
    const groups = buildGroups([
      act({ title: 'one element', remediation: 'same fix' }),
      act({ title: 'another element', remediation: 'same fix' }),
      act({ title: 'another element', remediation: 'different fix' }),
    ]);
    expect(groups.map((g) => g.count).sort()).toEqual([1, 2]);
  });

  it('orders actions defects-first, then by severity, stably', () => {
    const payload = buildAgentPayload({
      ...result,
      findings: [
        { route: '/', type: 'clipped-text', bucket: 'taste', severity: 'low', title: 't1', evidence: {} },
        { route: '/', type: 'dead-button', bucket: 'defect', severity: 'high', title: 'd1', evidence: {} },
        { route: '/', type: 'console-error', bucket: 'defect', severity: 'medium', title: 'd2', evidence: {} },
      ],
    });
    expect(payload.actions.map((a) => a.title)).toEqual(['d1', 'd2', 't1']);
    expect(payload.groups.map((g) => g.bucket)).toEqual(['defect', 'defect', 'taste']);
  });
});

describe('snapshotIndex passthrough', () => {
  it('carries the badge index from evidence to action, and omits the key when absent', () => {
    const payload = buildAgentPayload({
      ...result,
      findings: [
        { route: '/', type: 'dead-button', bucket: 'defect', severity: 'high', title: 'd', evidence: { snapshotIndex: 3 } },
        { route: '/', type: 'clipped-text', bucket: 'taste', severity: 'low', title: 't', evidence: {} },
      ],
    });
    expect(payload.actions[0].snapshotIndex).toBe(3);
    expect('snapshotIndex' in payload.actions[1]).toBe(false);
  });
});

describe('buildFixPlan', () => {
  const base: CrawlResult = {
    ...result,
    findings: [
      { route: '/', type: 'low-contrast', bucket: 'defect', severity: 'high', title: 'faint',
        evidence: { selector: 'p#faint', snapshotIndex: 4, contrast: { ratio: 1.99, fg: '#b4b4b4', bg: '#fafafa', fontSize: '13px', fontWeight: '400', suggestedFg: '#737373' } },
        remediation: 'Set color to #737373', fingerprint: 'f1',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html', tags: ['wcag2aa'] },
      // Same site + same fix as above: one root cause, not two.
      { route: '/', type: 'low-contrast', bucket: 'defect', severity: 'high', title: 'faint again',
        evidence: { selector: 'p#other', contrast: { ratio: 1.99, fg: '#b4b4b4', bg: '#fafafa', fontSize: '13px', fontWeight: '400', suggestedFg: '#737373' } },
        remediation: 'Set color to #737373', fingerprint: 'f2' },
      { route: '/', type: 'clipped-text', bucket: 'taste', severity: 'low', title: 'clipped', evidence: {}, fingerprint: 'f3' },
    ],
  };

  it('collapses same-fix findings into one step that clears them all', () => {
    const plan = buildFixPlan(base);
    const contrast = plan.steps.filter((s) => s.types.includes('low-contrast'));
    expect(contrast).toHaveLength(1);
    expect(contrast[0].count).toBe(2);
    expect(contrast[0].do).toContain('#737373');
  });

  it('keeps taste out of the work order but still reports it', () => {
    const plan = buildFixPlan(base);
    expect(plan.steps.every((s) => !s.types.includes('clipped-text'))).toBe(true);
    expect(plan.tasteQuestions).toHaveLength(1);
  });

  it('states the stopping condition, and reports done only when no defect group remains', () => {
    const open = buildFixPlan(base);
    expect(open.done).toBe(false);
    expect(open.summary.remainingGroups).toBeGreaterThan(0);
    expect(open.exitCriteria).toMatch(/root cause/);

    const clean = buildFixPlan({ ...base, findings: [base.findings[2]] });
    expect(clean.done).toBe(true);
    expect(clean.steps).toHaveLength(0);
    expect(clean.exitCriteria).toMatch(/done/i);
  });

  it('carries the evidence an agent needs to act: route, badge, ground truth', () => {
    const plan = buildFixPlan(base);
    const step = plan.steps.find((s) => s.types.includes('low-contrast'))!;
    expect(step.route).toBe('/');
    expect(step.snapshotIndex).toBe(4);
    expect(step.helpUrl).toMatch(/contrast-minimum/);
    expect(step.tags).toContain('wcag2aa');
  });

  it('surfaces regressions and fixed count from a diff when one exists', () => {
    const plan = buildFixPlan(base, {
      runA: 'a', runB: 'b',
      fixed: [{ route: '/', type: 'layout-overlap', bucket: 'defect', severity: 'high', title: 'was broken', evidence: {} }],
      regressions: [],
      persistent: [],
    });
    expect(plan.fixed).toBe(1);
    expect(plan.regressions).toEqual([]);
  });
});
