import { describe, it, expect, vi } from 'vitest';
import { classifySvgSnapshot, auditPageSvg, type SvgSnapshot } from '../src/svg.js';

function svg(over: Partial<SvgSnapshot>): SvgSnapshot {
  return {
    selector: 'svg:nth(0)',
    viewport: { x: 0, y: 0, w: 400, h: 300 },
    viewBox: null,
    scale: 1,
    shapes: [],
    ...over,
  };
}

describe('svg: transposed viewBox (mdview flowchart LR regression)', () => {
  it('fires aspect-mismatch and outside-viewbox on a portrait box around landscape content', () => {
    const issues = classifySvgSnapshot(svg({
      selector: 'svg.flowchart:nth(0)',
      viewport: { x: 10, y: 10, w: 100, h: 800 },
      viewBox: { x: 0, y: 0, w: 46, h: 422 },
      scale: 100 / 46,
      shapes: [
        { selector: 'rect:nth(0)', tag: 'rect', box: { x: 10, y: 20, w: 300, h: 40 }, fill: '#f0eadc', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 20, y: 30, w: 60, h: 14 }, text: 'revise', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#f0eadc' },
      ],
    }));
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain('svg-viewbox-aspect-mismatch');
    expect(kinds).toContain('svg-geometry-outside-viewbox');
    const aspect = issues.find((i) => i.kind === 'svg-viewbox-aspect-mismatch');
    expect(aspect?.contentAspect).toBeGreaterThan(2);
    expect(aspect?.viewBoxAspect).toBeLessThan(0.5);
  });

  it('stays silent when box and content orientations agree', () => {
    const issues = classifySvgSnapshot(svg({
      viewport: { x: 0, y: 0, w: 400, h: 120 },
      viewBox: { x: 0, y: 0, w: 400, h: 120 },
      scale: 1,
      shapes: [
        { selector: 'rect:nth(0)', tag: 'rect', box: { x: 10, y: 10, w: 100, h: 40 }, fill: '#f0eadc', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 20, y: 20, w: 60, h: 14 }, text: 'ok', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#f0eadc' },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('svg-viewbox-aspect-mismatch');
    expect(issues.map((i) => i.kind)).not.toContain('svg-geometry-outside-viewbox');
  });
});

describe('svg: negative coordinates outside the viewport', () => {
  it('fires outside-viewbox with the overflow distance', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'rect:nth(0)', tag: 'rect', box: { x: -50, y: 10, w: 100, h: 40 }, fill: '#f0eadc', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 10, y: 60, w: 60, h: 14 }, text: 'node', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    const hit = issues.find((i) => i.kind === 'svg-geometry-outside-viewbox');
    expect(hit).toBeDefined();
    expect(hit?.overflowPx).toBe(50);
  });

  it('ignores sub-tolerance stroke-width bleed', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'rect:nth(0)', tag: 'rect', box: { x: -2, y: 10, w: 100, h: 40 }, fill: '#f0eadc', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 10, y: 60, w: 60, h: 14 }, text: 'node', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('svg-geometry-outside-viewbox');
  });

  it('checks horizontal and vertical lines even when one box dimension is zero', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'line:nth(0)', tag: 'line', box: { x: -20, y: 50, w: 80, h: 0 }, visiblePaint: true },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 100, y: 100, w: 40, h: 14 }, text: 'axis', specifiedFontPx: 11 },
      ],
    }));
    const hit = issues.find((i) => i.kind === 'svg-geometry-outside-viewbox');
    expect(hit?.overflowPx).toBe(20);
  });

  it('does not call intentional overflow a clipping defect', () => {
    const issues = classifySvgSnapshot(svg({
      clipsOverflow: false,
      shapes: [
        { selector: 'rect:nth(0)', tag: 'rect', box: { x: -50, y: 10, w: 100, h: 40 }, fill: '#f0eadc', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 10, y: 60, w: 60, h: 14 }, text: 'node', specifiedFontPx: 11 },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('svg-geometry-outside-viewbox');
  });
});

describe('svg: label collisions', () => {
  it('fires on two labels sharing pixels', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'text:nth(0)', tag: 'text', box: { x: 10, y: 10, w: 60, h: 14 }, text: 'revise', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 20, y: 12, w: 60, h: 14 }, text: 'submit', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    const hit = issues.find((i) => i.kind === 'svg-text-overlap');
    expect(hit).toBeDefined();
    expect(hit?.otherSelector).toBe('text:nth(1)');
  });

  it('skips rotated text pairs (bbox overlap without glyph overlap)', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'text:nth(0)', tag: 'text', box: { x: 10, y: 10, w: 60, h: 14 }, text: 'a', rotated: true, specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 20, y: 12, w: 60, h: 14 }, text: 'b', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('svg-text-overlap');
  });

  it('leaves deliberately centered value labels alone', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'rect:nth(0)', tag: 'rect', box: { x: 10, y: 10, w: 100, h: 40 }, fill: '#2a4d3a', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 45, y: 23, w: 30, h: 14 }, text: '39', specifiedFontPx: 11, fill: '#ffffff', fillNone: false, behindFill: '#2a4d3a' },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('svg-text-overlap');
  });

  it('does not treat an intentionally placed label inside a shape as a collision', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'rect:nth(0)', tag: 'rect', box: { x: 10, y: 10, w: 100, h: 40 }, fill: '#f0eadc', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 70, y: 25, w: 60, h: 14 }, text: 'edge label', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('svg-text-overlap');
  });
});

describe('svg: viewBox-only sizing blowup', () => {
  it('fires when 11px type renders near 100px', () => {
    const issues = classifySvgSnapshot(svg({
      viewport: { x: 0, y: 0, w: 860, h: 100 },
      viewBox: { x: 0, y: 0, w: 100, h: 12 },
      scale: 8.6,
      shapes: [
        { selector: 'text:nth(0)', tag: 'text', box: { x: 10, y: 10, w: 300, h: 80 }, text: 'blown up', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    const hit = issues.find((i) => i.kind === 'svg-text-scaled');
    expect(hit).toBeDefined();
    expect(hit?.effectiveFontPx).toBeCloseTo(94.6, 0);
  });

  it('stays silent at sane scales', () => {
    const issues = classifySvgSnapshot(svg({
      scale: 1.2,
      shapes: [
        { selector: 'text:nth(0)', tag: 'text', box: { x: 10, y: 10, w: 60, h: 14 }, text: 'fine', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('svg-text-scaled');
  });

  it('uses measured text scaling instead of the width-to-viewBox ratio', () => {
    const issues = classifySvgSnapshot(svg({
      scale: 8.95,
      shapes: [
        { selector: 'text:nth(0)', tag: 'text', box: { x: 10, y: 10, w: 12, h: 6 }, text: 'small', specifiedFontPx: 11, effectiveFontPx: 5.2 },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('svg-text-scaled');
  });

  it('still catches a large per-label transform when the root scale is small', () => {
    const issues = classifySvgSnapshot(svg({
      scale: 0.47,
      shapes: [
        { selector: 'text:nth(0)', tag: 'text', box: { x: 10, y: 10, w: 200, h: 90 }, text: 'large', specifiedFontPx: 11, effectiveFontPx: 85.8 },
      ],
    }));
    expect(issues.map((i) => i.kind)).toContain('svg-text-scaled');
  });
});

describe('svg: degenerate geometry (mdview negative-bar regression)', () => {
  it('fires on a filled zero-height rect', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'rect.bar:nth(2)', tag: 'rect', box: { x: 10, y: 100, w: 40, h: 0 }, fill: '#2a4d3a', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(3)', tag: 'text', box: { x: 10, y: 110, w: 40, h: 14 }, text: '-5', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    expect(issues.map((i) => i.kind)).toContain('svg-degenerate-geometry');
  });

  it('ignores stroked axis lines and flat connectors', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'rect.axis:nth(0)', tag: 'rect', box: { x: 0, y: 100, w: 400, h: 1 }, fillNone: true, fillOpacity: 1 },
        { selector: 'line:nth(1)', tag: 'line', box: { x: 0, y: 50, w: 400, h: 0 }, fillNone: true, fillOpacity: 1 },
        { selector: 'path:nth(2)', tag: 'path', box: { x: 0, y: 50, w: 400, h: 0 }, fillNone: true, fillOpacity: 1 },
        { selector: 'text:nth(3)', tag: 'text', box: { x: 10, y: 10, w: 40, h: 14 }, text: 'ok', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('svg-degenerate-geometry');
  });

  it('finds a collapsed filled mark even when the SVG has no text', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'rect.bar:nth(0)', tag: 'rect', box: { x: 10, y: 100, w: 40, h: 0 }, fill: '#2a4d3a', fillNone: false, fillOpacity: 1 },
      ],
    }));
    expect(issues.map((i) => i.kind)).toContain('svg-degenerate-geometry');
  });
});

describe('svg: text without text, and empty input', () => {
  it('skips decorative SVGs with no text for geometry checks', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'path:nth(0)', tag: 'path', box: { x: -100, y: -100, w: 600, h: 500 }, fillNone: true, fillOpacity: 1 },
      ],
    }));
    expect(issues).toEqual([]);
  });

  it('returns no issues for an empty snapshot', () => {
    expect(classifySvgSnapshot(svg({}))).toEqual([]);
  });
});

describe('svg: local text contrast (heatmap regression)', () => {
  it('reuses low-contrast for unreadable text on a dark cell', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'text:nth(0)', tag: 'text', box: { x: 10, y: 10, w: 30, h: 14 }, text: '0.2', specifiedFontPx: 11, fill: '#5a5a5a', fillNone: false, behindFill: '#3a3a3a' },
      ],
    }));
    const hit = issues.find((i) => i.kind === 'low-contrast');
    expect(hit).toBeDefined();
    expect(hit?.contrast?.ratio).toBeLessThan(4.5);
  });

  it('stays silent on legible SVG text', () => {
    const issues = classifySvgSnapshot(svg({
      shapes: [
        { selector: 'text:nth(0)', tag: 'text', box: { x: 10, y: 10, w: 30, h: 14 }, text: '0.9', specifiedFontPx: 11, fill: '#000000', fillNone: false, behindFill: '#ffffff' },
      ],
    }));
    expect(issues.map((i) => i.kind)).not.toContain('low-contrast');
  });

  it('respects the existing contrast opt-out', async () => {
    const snapshot = svg({
      shapes: [
        { selector: 'text:nth(0)', tag: 'text', box: { x: 10, y: 10, w: 30, h: 14 }, text: '0.2', specifiedFontPx: 11, fill: '#5a5a5a', fillNone: false, fillOpacity: 1, behindFill: '#3a3a3a' },
      ],
    });
    const mockPage = { evaluate: vi.fn().mockResolvedValue([snapshot]) } as unknown as import('playwright').Page;
    const findings = await auditPageSvg(mockPage, '/contrast', { skipContrast: true });
    expect(findings).toEqual([]);
  });
});

describe('svg: auditPageSvg mapping', () => {
  it('maps classifier issues to RawFindings with svg evidence', async () => {
    const snapshot = svg({
      shapes: [
        { selector: 'rect:nth(0)', tag: 'rect', box: { x: -50, y: 10, w: 100, h: 40 }, fill: '#f0eadc', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 10, y: 60, w: 60, h: 14 }, text: 'node', specifiedFontPx: 11, fill: '#080b08', fillNone: false, behindFill: '#ffffff' },
      ],
    });
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue([snapshot]),
    } as unknown as import('playwright').Page;
    const findings = await auditPageSvg(mockPage, '/shapes');
    expect(findings.length).toBeGreaterThan(0);
    const hit = findings.find((f) => f.kind === 'svg-geometry-outside-viewbox');
    expect(hit).toBeDefined();
    expect(hit?.route).toBe('/shapes');
    expect(hit?.evidence.selector).toBe('rect:nth(0)');
    expect(hit?.evidence.svg?.svgSelector).toBe('svg:nth(0)');
    expect(hit?.evidence.svg?.overflowPx).toBe(50);
    expect(hit?.evidence.remediation).toMatch(/viewBox/);
  });

  it('returns no findings for a clean snapshot', async () => {
    const snapshot = svg({
      viewport: { x: 0, y: 0, w: 400, h: 120 },
      viewBox: { x: 0, y: 0, w: 400, h: 120 },
      scale: 1,
      shapes: [
        { selector: 'rect:nth(0)', tag: 'rect', box: { x: 10, y: 10, w: 100, h: 40 }, fill: '#2a4d3a', fillNone: false, fillOpacity: 1 },
        { selector: 'text:nth(1)', tag: 'text', box: { x: 45, y: 23, w: 30, h: 14 }, text: '39', specifiedFontPx: 11, fill: '#ffffff', fillNone: false, behindFill: '#2a4d3a' },
      ],
    });
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue([snapshot]),
    } as unknown as import('playwright').Page;
    const findings = await auditPageSvg(mockPage, '/clean');
    // The centered white-on-green label passes contrast (high) and geometry is clean.
    expect(findings).toEqual([]);
  });

  it('lets page evaluation failures reach the detector failure handler', async () => {
    const mockPage = { evaluate: vi.fn().mockRejectedValue(new Error('page closed')) } as unknown as import('playwright').Page;
    await expect(auditPageSvg(mockPage, '/broken')).rejects.toThrow('page closed');
  });
});
