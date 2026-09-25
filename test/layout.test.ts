import { describe, it, expect, vi } from 'vitest';
import { boxIntersection, auditPageLayout } from '../src/layout.js';
import type { Box } from '../src/types.js';

describe('layout: boxIntersection', () => {
  it('returns 0 area for non-overlapping boxes', () => {
    const a: Box = { selector: 'a', x: 0, y: 0, w: 50, h: 50 };
    const b: Box = { selector: 'b', x: 60, y: 0, w: 50, h: 50 };
    expect(boxIntersection(a, b)).toEqual({ area: 0, frac: 0 });
  });

  it('calculates partial overlap accurately', () => {
    const a: Box = { selector: 'a', x: 0, y: 0, w: 100, h: 100 };
    const b: Box = { selector: 'b', x: 50, y: 50, w: 100, h: 100 };
    const res = boxIntersection(a, b);
    expect(res.area).toBe(2500);
    expect(res.frac).toBe(0.25);
  });

  it('calculates full containment accurately', () => {
    const a: Box = { selector: 'a', x: 0, y: 0, w: 100, h: 100 };
    const b: Box = { selector: 'b', x: 10, y: 10, w: 20, h: 20 };
    const res = boxIntersection(a, b);
    expect(res.area).toBe(400);
    expect(res.frac).toBe(1);
  });
});

describe('layout: auditPageLayout mapping', () => {
  it('maps evaluated container-overflow and sibling-overlap findings', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue([
        {
          kind: 'sibling-overlap',
          selector: '.section-intro',
          otherSelector: '.steps',
          overflowPx: 15,
          remediation: 'Fix margin',
        },
        {
          kind: 'container-overflow',
          selector: 'h2',
          otherSelector: '.section-intro',
          overflowPx: 12,
          remediation: 'Fix padding',
        },
      ]),
    } as unknown as import('playwright').Page;

    const findings = await auditPageLayout(mockPage, '/test');
    expect(findings.length).toBe(2);
    expect(findings[0].kind).toBe('sibling-overlap');
    expect(findings[0].evidence.selector).toBe('.section-intro');
    expect(findings[0].evidence.layout?.otherSelector).toBe('.steps');
    expect(findings[0].evidence.layout?.overflowPx).toBe(15);

    expect(findings[1].kind).toBe('container-overflow');
    expect(findings[1].evidence.selector).toBe('h2');
    expect(findings[1].evidence.layout?.otherSelector).toBe('.section-intro');
    expect(findings[1].evidence.layout?.overflowPx).toBe(12);
  });

  it('maps new macro layout and taste findings accurately', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue([
        {
          kind: 'text-border-collision',
          selector: 'p.descender',
          otherSelector: 'section.container',
          textSample: 'package you own.',
          remediation: 'Increase container padding-bottom or line-height.',
        },
        {
          kind: 'vertical-rhythm-drift',
          selector: 'section:nth(1)',
          rhythm: { minGapPx: 24, maxGapPx: 192, medianGapPx: 48, ratio: 8.0 },
          remediation: 'Standardize section padding using consistent spacing tokens.',
        },
        {
          kind: 'viewport-scale-imbalance',
          selector: 'h1',
          scale: { headingHeightPx: 320, viewportHeightPx: 800, occupancyRatio: 0.4, lineCount: 4 },
          remediation: 'Scale down heading font size clamp.',
        },
        {
          kind: 'unanchored-divider-bleed',
          selector: 'hr',
          divider: { lineWidthPx: 1024, contentWidthPx: 1004, bleedPx: 20 },
          remediation: 'Constrain divider width to match the content grid.',
        },
        {
          kind: 'adjacent-wordmark-echo',
          selector: '.hero .kicker',
          wordmark: { brandText: 'Æstrum', echoText: 'Æstrum outcome delivery', distancePx: 40 },
          remediation: 'Remove duplicate brand naming for cleaner visual hierarchy.',
        },
      ]),
    } as unknown as import('playwright').Page;

    const findings = await auditPageLayout(mockPage, '/test');
    expect(findings).toHaveLength(5);

    expect(findings[0].kind).toBe('text-border-collision');
    expect(findings[0].evidence.selector).toBe('p.descender');
    expect(findings[0].evidence.layout?.otherSelector).toBe('section.container');

    expect(findings[1].kind).toBe('vertical-rhythm-drift');
    expect(findings[1].evidence.rhythm?.maxGapPx).toBe(192);
    expect(findings[1].evidence.rhythm?.ratio).toBe(8.0);

    expect(findings[2].kind).toBe('viewport-scale-imbalance');
    expect(findings[2].evidence.scale?.occupancyRatio).toBe(0.4);
    expect(findings[2].evidence.scale?.lineCount).toBe(4);

    expect(findings[3].kind).toBe('unanchored-divider-bleed');
    expect(findings[3].evidence.divider?.bleedPx).toBe(20);

    expect(findings[4].kind).toBe('adjacent-wordmark-echo');
    expect(findings[4].evidence.wordmark?.brandText).toBe('Æstrum');
    expect(findings[4].evidence.wordmark?.distancePx).toBe(40);
  });
});
