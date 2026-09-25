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
});
