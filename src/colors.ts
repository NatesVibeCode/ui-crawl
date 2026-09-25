import type { Page } from 'playwright';
import type { RawFinding, ColorPalette } from './types.js';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(str: string): Rgba | null {
  if (!str) return null;
  const s = str.trim().toLowerCase();

  // Hex colors
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    return null;
  }

  // rgb(...) or rgba(...) with comma or modern space/slash syntax, supports integers and decimals
  const rgbMatch = s.match(
    /^rgba?\s*\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/,
  );
  if (rgbMatch) {
    let a = 1;
    if (rgbMatch[4] !== undefined) {
      a = rgbMatch[4].endsWith('%') ? parseFloat(rgbMatch[4]) / 100 : parseFloat(rgbMatch[4]);
      a = Math.min(1, Math.max(0, a));
    }
    return {
      r: Math.min(255, Math.max(0, Math.round(parseFloat(rgbMatch[1])))),
      g: Math.min(255, Math.max(0, Math.round(parseFloat(rgbMatch[2])))),
      b: Math.min(255, Math.max(0, Math.round(parseFloat(rgbMatch[3])))),
      a,
    };
  }

  // named colors fallback
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };

  return null;
}

/** Composite a foreground color with alpha over a background color. */
export function compositeColors(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 255, g: 255, b: 255, a: 0 };
  const r = Math.round((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a);
  const g = Math.round((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a);
  const b = Math.round((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a);
  return { r, g, b, a };
}

/** Calculate WCAG 2.1 relative luminance for an opaque sRGB color (0.0 - 1.0). */
export function relativeLuminance(c: { r: number; g: number; b: number }): number {
  const toLinear = (val: number) => {
    const s = val / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** Calculate WCAG 2.1 contrast ratio between two colors (1.0 to 21.0). */
export function contrastRatio(c1: { r: number; g: number; b: number }, c2: { r: number; g: number; b: number }): number {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return Math.round(ratio * 100) / 100;
}

export interface ContrastSample {
  selector: string;
  textSample: string;
  /** Offsets of `textSample` within the page's normalized visible text; null when unlocatable. */
  textStart: number | null;
  textEnd: number | null;
  fg: string;
  bg: string;
  ratio: number;
  fontSize: string;
  fontWeight: string;
  isLargeText: boolean;
  requiredRatio: number;
  passes: boolean;
}

/** In-browser evaluation querying visible text and extracting computed colors and palette. */
export async function auditPageColors(
  page: Page,
  route: string,
): Promise<{ rawFindings: RawFinding[]; palette: ColorPalette; textDigest: number; textLength: number }> {
  // Pass as a string to guarantee tsx/esbuild does not inject `__name` helpers into the browser context.
  const script = `(() => {
    function parse(str) {
      if (!str) return null;
      var s = str.trim().toLowerCase();
      if (s.startsWith('#')) {
        var hex = s.slice(1);
        if (hex.length === 3) {
          return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 1 };
        }
        if (hex.length === 6) {
          return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
        }
        if (hex.length === 8) {
          return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: parseInt(hex.slice(6, 8), 16) / 255 };
        }
        return null;
      }
      var m = s.match(/^rgba?\\s*\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,\\s/]+([\\d.]+%?))?\\s*\\)$/);
      if (m) {
        var a = 1;
        if (m[4] !== undefined) {
          a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
          a = Math.min(1, Math.max(0, a));
        }
        return {
          r: Math.min(255, Math.max(0, Math.round(parseFloat(m[1])))),
          g: Math.min(255, Math.max(0, Math.round(parseFloat(m[2])))),
          b: Math.min(255, Math.max(0, Math.round(parseFloat(m[3])))),
          a: a,
        };
      }
      if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
      if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
      return null;
    }

    function blend(fg, bg) {
      var a = fg.a + bg.a * (1 - fg.a);
      if (a <= 0) return { r: 255, g: 255, b: 255, a: 0 };
      return {
        r: Math.round((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a),
        g: Math.round((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a),
        b: Math.round((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a),
        a: a,
      };
    }

    function lum(c) {
      function lin(v) {
        var s = v / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      }
      return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    }

    function contrast(c1, c2) {
      var l1 = lum(c1);
      var l2 = lum(c2);
      var higher = Math.max(l1, l2);
      var lower = Math.min(l1, l2);
      return Math.round(((higher + 0.05) / (lower + 0.05)) * 100) / 100;
    }

    function toHex(c) {
      function h(n) { return n.toString(16).padStart(2, '0'); }
      return '#' + h(c.r) + h(c.g) + h(c.b);
    }

    function getEffectiveBg(el) {
      var curr = el;
      var layers = [];

      while (curr && curr !== document.documentElement) {
        var style = window.getComputedStyle(curr);
        var parsed = parse(style.backgroundColor);
        if (parsed && parsed.a > 0) {
          layers.push(parsed);
          if (parsed.a >= 1) break;
        }
        curr = curr.parentElement;
      }
      if (!layers.length || layers[layers.length - 1].a < 1) {
        var rootStyle = window.getComputedStyle(document.documentElement);
        var rootParsed = parse(rootStyle.backgroundColor);
        if (rootParsed && rootParsed.a > 0) layers.push(rootParsed);
        layers.push({ r: 255, g: 255, b: 255, a: 1 });
      }

      var res = layers[layers.length - 1];
      for (var i = layers.length - 2; i >= 0; i--) {
        res = blend(layers[i], res);
      }
      return res;
    }

    var samples = [];
    var bgCounts = new Map();
    var textCounts = new Map();
    var accentCounts = new Map();

    var textEls = Array.from(
      document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, a, button, [role="button"], label, th, td, li, span, code, pre')
    );

    var seenText = new Set();

    // Page text index: this page's visible text in DOM order, whitespace-normalized, with
    // every text node's absolute offset in it. Quoted finding text is sliced out of THIS
    // string, so offsets and sample cannot disagree, and a re-crawl can check that the
    // same characters are still at the same offsets.
    var indexParts = [];
    var nodeStarts = new Map();
    var cursor = 0;
    var textWalker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    while (textWalker.nextNode()) {
      var textNode = textWalker.currentNode;
      var parentEl = textNode.parentElement;
      if (!parentEl) continue;
      var parentStyle = window.getComputedStyle(parentEl);
      if (parentStyle.visibility === 'hidden' || parentStyle.display === 'none' || parseFloat(parentStyle.opacity) < 0.1) continue;
      var nodeText = (textNode.nodeValue || '').replace(/\\s+/g, ' ').trim();
      if (!nodeText) continue;
      if (cursor > 0) cursor += 1;
      nodeStarts.set(textNode, cursor);
      indexParts.push(nodeText);
      cursor += nodeText.length;
    }
    var pageText = indexParts.join(' ');
    // FNV-1a: sync, dependency-free, and enough to tell "same page text" from "changed".
    var textDigest = 2166136261;
    for (var d = 0; d < pageText.length; d++) {
      textDigest ^= pageText.charCodeAt(d);
      textDigest = Math.imul(textDigest, 16777619) >>> 0;
    }

    function firstNodeOffset(el) {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        var node = walker.currentNode;
        if ((node.nodeValue || '').trim() && nodeStarts.has(node)) return nodeStarts.get(node);
      }
      return null;
    }

    for (var i = 0; i < textEls.length; i++) {
      var el = textEls[i];
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      var style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.1) continue;

      var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text || text.length < 2) continue;

      // Skip non-leaf container elements whose text is entirely inside styled child elements
      var hasDirectText = Array.from(el.childNodes).some(function(n) {
        return n.nodeType === 3 && n.textContent.trim().length > 0;
      });
      if (el.children.length > 0 && !hasDirectText) continue;

      var fgParsed = parse(style.color);
      if (!fgParsed) continue;
      var effectiveBg = getEffectiveBg(el);
      var effectiveFg = fgParsed.a < 1 ? blend(fgParsed, { r: effectiveBg.r, g: effectiveBg.g, b: effectiveBg.b, a: 1 }) : fgParsed;

      var fgHex = toHex(effectiveFg);
      var bgHex = toHex(effectiveBg);

      bgCounts.set(bgHex, (bgCounts.get(bgHex) || 0) + 1);
      textCounts.set(fgHex, (textCounts.get(fgHex) || 0) + 1);
      if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
        accentCounts.set(fgHex, (accentCounts.get(fgHex) || 0) + 1);
        if (effectiveBg.r !== 255 || effectiveBg.g !== 255 || effectiveBg.b !== 255) {
          accentCounts.set(bgHex, (accentCounts.get(bgHex) || 0) + 1);
        }
      }

      var ratio = contrast(effectiveFg, effectiveBg);
      var fontSizePx = parseFloat(style.fontSize) || 16;
      var fontWeightNum = parseInt(style.fontWeight, 10) || 400;
      var isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.5 && fontWeightNum >= 700);
      var requiredRatio = isLargeText ? 3.0 : 4.5;
      var passes = ratio >= requiredRatio;

      var sampleKey = el.tagName.toLowerCase() + '|' + fgHex + '|' + bgHex + '|' + passes;
      if (!passes && !seenText.has(sampleKey)) {
        seenText.add(sampleKey);
        var id = (typeof el.id === 'string' && el.id.trim()) ? '#' + el.id.trim() : '';
        var rawCls = (typeof el.className === 'string') ? el.className.trim() : '';
        var clsParts = rawCls ? rawCls.split(/\\s+/).filter(Boolean).slice(0, 2) : [];
        var cls = clsParts.length ? '.' + clsParts.join('.') : '';
        var sel = el.tagName.toLowerCase() + id + cls;
        // The quote is the element's own text, as before. Offsets are published ONLY when
        // the page text really does carry that exact quote at that offset — a locator that
        // cannot be checked is worse than none, so an unmatched quote reports no offsets.
        var textSample = text.slice(0, 60);
        var textStart = firstNodeOffset(el);
        var textEnd = null;
        if (textStart !== null) {
          var candidateEnd = textStart + textSample.length;
          if (pageText.slice(textStart, candidateEnd) === textSample) textEnd = candidateEnd;
          else textStart = null;
        }
        samples.push({
          selector: sel,
          textSample: textSample,
          textStart: textStart,
          textEnd: textEnd,
          fg: fgHex,
          bg: bgHex,
          ratio: ratio,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          isLargeText: isLargeText,
          requiredRatio: requiredRatio,
          passes: passes,
        });
      }
    }

    function topN(map, n) {
      return Array.from(map.entries())
        .sort(function(a, b) { return b[1] - a[1]; })
        .slice(0, n)
        .map(function(pair) { return pair[0]; });
    }

    return {
      samples: samples,
      palette: {
        backgrounds: topN(bgCounts, 5),
        text: topN(textCounts, 5),
        accents: topN(accentCounts, 5),
      },
      textDigest: textDigest,
      textLength: pageText.length,
    };
  })()`;

  const evalResult = await page.evaluate(script) as {
    samples: ContrastSample[];
    palette: ColorPalette;
    textDigest: number;
    textLength: number;
  };

  const rawFindings: RawFinding[] = [];
  for (const s of evalResult.samples) {
    if (!s.passes) {
      rawFindings.push({
        route,
        kind: 'low-contrast',
        evidence: {
          selector: s.selector,
          contrast: {
            ratio: s.ratio,
            fg: s.fg,
            bg: s.bg,
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
            textSample: s.textSample,
            ...(s.textStart === null ? {} : { textStart: s.textStart, textEnd: s.textEnd ?? undefined }),
          },
          remediation: `Current contrast is ${s.ratio}:1 (expected >= ${s.requiredRatio}:1). Adjust foreground from ${s.fg} to meet contrast against background ${s.bg}.`,
        },
      });
    }
  }

  return {
    rawFindings,
    palette: evalResult.palette,
    textDigest: evalResult.textDigest,
    textLength: evalResult.textLength,
  };
}
