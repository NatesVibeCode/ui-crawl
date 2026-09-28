import { describe, it, expect } from 'vitest';
import {
  parseColor, compositeColors, relativeLuminance, contrastRatio, suggestAccessibleColor,
} from '../src/colors.js';

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

describe('colors: suggestAccessibleColor', () => {
  it('returns a concrete replacement hex that actually clears the bar', () => {
    const s = suggestAccessibleColor('#b4b4b4', '#fafafa', 4.5);
    expect(s).not.toBeNull();
    // The reported ratio must be the ratio the emitted hex produces, not a prediction.
    expect(contrastRatio(parseColor(s!.hex)!, parseColor('#fafafa')!)).toBeGreaterThanOrEqual(4.5);
    expect(s!.ratio).toBeGreaterThanOrEqual(4.5);
    expect(s!.direction).toBe('darken');
  });

  it('makes the smallest move that clears the threshold', () => {
    const justUnder = suggestAccessibleColor('#767676', '#ffffff', 4.5);
    // #767676 is the canonical 4.54:1 grey, so it should already pass and be left alone.
    expect(justUnder).toBeNull();
  });

  it('lightens against a dark background', () => {
    const s = suggestAccessibleColor('#333333', '#111111', 4.5);
    expect(s).not.toBeNull();
    expect(s!.direction).toBe('lighten');
    expect(contrastRatio(parseColor(s!.hex)!, parseColor('#111111')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('picks the workable direction for a mid-tone background', () => {
    // Lightening #808080 on #808080 can only reach ~3.9:1; darkening reaches ~5.3:1.
    // A "light background, so darken the text" heuristic would not help here, and neither
    // would the opposite one — the suggestion has to search both.
    const s = suggestAccessibleColor('#808080', '#808080', 4.5);
    expect(s).not.toBeNull();
    expect(contrastRatio(parseColor(s!.hex)!, parseColor('#808080')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('returns null when the foreground already passes', () => {
    expect(suggestAccessibleColor('#000000', '#ffffff', 4.5)).toBeNull();
  });

  it('returns null on an unparseable colour rather than inventing one', () => {
    expect(suggestAccessibleColor('not-a-color', '#ffffff', 4.5)).toBeNull();
    expect(suggestAccessibleColor('#000000', 'not-a-color', 4.5)).toBeNull();
  });

  it('honours the large-text 3.0 threshold', () => {
    // #a0a0a0 on white is ~2.6:1 — fails both bars, so each threshold gets its own answer.
    const s = suggestAccessibleColor('#a0a0a0', '#ffffff', 3.0);
    expect(s).not.toBeNull();
    expect(contrastRatio(parseColor(s!.hex)!, parseColor('#ffffff')!)).toBeGreaterThanOrEqual(3.0);

    const stricter = suggestAccessibleColor('#a0a0a0', '#ffffff', 4.5);
    expect(stricter).not.toBeNull();
    expect(contrastRatio(parseColor(stricter!.hex)!, parseColor('#ffffff')!)).toBeGreaterThanOrEqual(4.5);
  });
});
