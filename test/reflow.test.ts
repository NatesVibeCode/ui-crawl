import { describe, it, expect } from 'vitest';
import { detectReflow } from '../src/reflow.js';
import type { Box } from '../src/types.js';

const VP = { w: 1000, h: 800 };

function box(selector: string, x: number, y: number, w: number, h: number): Box {
  return { selector, x, y, w, h };
}

describe('detectReflow', () => {
  it('flags horizontal overflow as a clip', () => {
    const issues = detectReflow({ viewport: VP, zoom: 2, boxes: [box('header', 0, 0, 1200, 60)] });
    expect(issues.some((i) => i.kind === 'zoom-clip' && i.selector === 'header')).toBe(true);
  });

  it('ignores elements within the viewport', () => {
    const issues = detectReflow({ viewport: VP, zoom: 2, boxes: [box('main', 0, 0, 900, 400)] });
    expect(issues).toHaveLength(0);
  });

  it('flags clear sibling overlap as a defect (not ambiguous)', () => {
    const issues = detectReflow({
      viewport: VP,
      zoom: 2,
      boxes: [box('a.btn', 0, 0, 100, 40), box('b.btn', 50, 0, 100, 40)],
    });
    const overlap = issues.find((i) => i.kind === 'zoom-overlap');
    expect(overlap).toBeDefined();
    expect(overlap?.ambiguous).toBe(false);
  });

  it('marks a small overlap ambiguous (vision-eligible)', () => {
    // ~9% of the smaller box: above the ambiguous floor, below the defect threshold.
    const issues = detectReflow({
      viewport: VP,
      zoom: 2,
      boxes: [box('a', 0, 0, 100, 100), box('b', 70, 70, 100, 100)],
    });
    const overlap = issues.find((i) => i.kind === 'zoom-overlap');
    expect(overlap).toBeDefined();
    expect(overlap?.ambiguous).toBe(true);
  });

  it('does not treat parent/child containment as a collision', () => {
    const issues = detectReflow({
      viewport: VP,
      zoom: 2,
      boxes: [box('parent', 0, 0, 400, 400), box('child', 10, 10, 100, 100)],
    });
    expect(issues.filter((i) => i.kind === 'zoom-overlap')).toHaveLength(0);
  });
});
