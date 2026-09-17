import { describe, it, expect } from 'vitest';
import { parseColor, compositeColors, relativeLuminance, contrastRatio } from '../src/colors.js';

describe('colors: parseColor', () => {
  it('parses 3-digit and 6-digit hex colors', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('#112233')).toEqual({ r: 17, g: 34, b: 51, a: 1 });
  });

  it('parses 8-digit hex colors with alpha', () => {
    const res = parseColor('#ffffff80');
    expect(res?.r).toBe(255);
    expect(res?.g).toBe(255);
    expect(res?.b).toBe(255);
    expect(res?.a).toBeCloseTo(0.5, 1);
  });

  it('parses rgb and rgba strings with comma or modern space/slash syntax', () => {
    expect(parseColor('rgb(255, 128, 0)')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgb(255 128 0 / 50%)')).toEqual({ r: 255, g: 128, b: 0, a: 0.5 });
    expect(parseColor('rgb(0 100 200 / 0.25)')).toEqual({ r: 0, g: 100, b: 200, a: 0.25 });
    expect(parseColor('rgb(255.0, 128.4, 0.2)')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
  });

  it('handles named colors and transparent', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('black')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('returns null for invalid strings', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor('not-a-color')).toBeNull();
  });
});

describe('colors: compositeColors', () => {
  it('composites opaque color over another identically', () => {
    const fg = { r: 255, g: 0, b: 0, a: 1 };
    const bg = { r: 0, g: 0, b: 255, a: 1 };
    expect(compositeColors(fg, bg)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('blends 50% red over white to produce expected pink/red', () => {
    const fg = { r: 255, g: 0, b: 0, a: 0.5 };
    const bg = { r: 255, g: 255, b: 255, a: 1 };
    const res = compositeColors(fg, bg);
    expect(res.r).toBe(255);
    expect(res.g).toBe(128);
    expect(res.b).toBe(128);
    expect(res.a).toBe(1);
  });
});

describe('colors: relativeLuminance & contrastRatio', () => {
  it('computes black and white luminance correctly', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBe(1);
  });

  it('black on white yields maximum contrast 21:1', () => {
    const ratio = contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
    expect(ratio).toBe(21);
  });

  it('same color on same color yields 1:1', () => {
    const ratio = contrastRatio({ r: 100, g: 100, b: 100 }, { r: 100, g: 100, b: 100 });
    expect(ratio).toBe(1);
  });

  it('#767676 on white yields ~4.54:1 (WCAG AA boundary for body text)', () => {
    const gray = parseColor('#767676')!;
    const white = parseColor('#ffffff')!;
    const ratio = contrastRatio(gray, white);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(4.6);
  });
});
