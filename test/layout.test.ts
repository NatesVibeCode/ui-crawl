import { describe, it, expect } from 'vitest';
import { boxIntersection } from '../src/layout.js';
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
    // Intersection rect: x: 50..100 (50w), y: 50..100 (50h) => 2500 area
    // minArea: 10000 => frac: 0.25
    const res = boxIntersection(a, b);
    expect(res.area).toBe(2500);
    expect(res.frac).toBe(0.25);
  });

  it('calculates full containment accurately', () => {
    const a: Box = { selector: 'a', x: 0, y: 0, w: 100, h: 100 };
    const b: Box = { selector: 'b', x: 10, y: 10, w: 20, h: 20 };
    // Intersection rect: 400 area, minArea: 400 => frac: 1.0
    const res = boxIntersection(a, b);
    expect(res.area).toBe(400);
    expect(res.frac).toBe(1);
  });
});
