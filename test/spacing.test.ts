import { describe, it, expect } from 'vitest';
import { edgeDistance } from '../src/spacing.js';
import type { Box } from '../src/types.js';

describe('spacing: edgeDistance', () => {
  it('returns 0 for colliding boxes', () => {
    const a: Box = { selector: 'a', x: 10, y: 10, w: 50, h: 50 };
    const b: Box = { selector: 'b', x: 20, y: 20, w: 50, h: 50 };
    expect(edgeDistance(a, b)).toBe(0);
  });

  it('calculates side-by-side gap accurately', () => {
    const a: Box = { selector: 'a', x: 0, y: 10, w: 50, h: 30 };
    const b: Box = { selector: 'b', x: 60, y: 10, w: 50, h: 30 };
    expect(edgeDistance(a, b)).toBe(10);
  });

  it('calculates vertically stacked gap accurately', () => {
    const a: Box = { selector: 'a', x: 10, y: 0, w: 50, h: 30 };
    const b: Box = { selector: 'b', x: 10, y: 35, w: 50, h: 30 };
    expect(edgeDistance(a, b)).toBe(5);
  });

  it('calculates diagonal gap accurately', () => {
    const a: Box = { selector: 'a', x: 0, y: 0, w: 10, h: 10 };
    const b: Box = { selector: 'b', x: 13, y: 14, w: 10, h: 10 };
    // dx = 3, dy = 4, sqrt(3^2 + 4^2) = 5
    expect(edgeDistance(a, b)).toBe(5);
  });
});
