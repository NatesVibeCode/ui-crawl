import type { Page } from 'playwright';
import type { RawFinding, ColorPalette } from './types.js';
import { primeSelectors } from './locate.js';

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

export interface ColorSuggestion {
  /** Replacement foreground that meets `requiredRatio` against the same background. */
  hex: string;
  /** Contrast ratio the suggestion actually achieves, as measured — not as predicted. */
  ratio: number;
  /** Whether the fix darkens or lightens the original foreground. */
  direction: 'darken' | 'lighten';
}

function toHex(c: { r: number; g: number; b: number }): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * The smallest hue-preserving change to `fgHex` that reaches `requiredRatio` against
 * `bgHex`. Returns the suggestion, or null when no single-channel-preserving move works
 * (in which case the remediation must ask for a different background, not a different ink).
 *
 * Scaling channels multiplicatively toward black, or toward white via `c + (255-c)*t`,
 * keeps hue and relative saturation instead of washing the color out the way a straight
 * RGB mix toward a grey pole would. Both directions are searched and the smaller move
 * wins, because guessing the pole from background luminance alone picks wrong for
 * mid-tone backgrounds: at `#808080`, lightening can only reach 3.9:1 while darkening
 * reaches 5.3:1, so a "light background" heuristic would give up on a solvable problem.
 */
export function suggestAccessibleColor(
  fgHex: string,
  bgHex: string,
  requiredRatio: number,
): ColorSuggestion | null {
  const fg = parseColor(fgHex);
  const bg = parseColor(bgHex);
  if (!fg || !bg) return null;

  const bgOpaque = { r: bg.r, g: bg.g, b: bg.b };
  if (contrastRatio(fg, bgOpaque) >= requiredRatio) return null;

  const STEPS = 200;
  let best: { c: { r: number; g: number; b: number }; t: number; direction: 'darken' | 'lighten' } | undefined;

  for (const direction of ['darken', 'lighten'] as const) {
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const c =
        direction === 'darken'
          ? { r: fg.r * (1 - t), g: fg.g * (1 - t), b: fg.b * (1 - t) }
          : { r: fg.r + (255 - fg.r) * t, g: fg.g + (255 - fg.g) * t, b: fg.b + (255 - fg.b) * t };
      if (contrastRatio(c, bgOpaque) >= requiredRatio) {
        if (!best || t < best.t) best = { c, t, direction };
        break;
      }
    }
  }

  if (!best) return null;
  const rounded = {
    r: Math.round(best.c.r),
    g: Math.round(best.c.g),
    b: Math.round(best.c.b),
  };
  // Re-measure the rounded value: the suggestion is what the agent will paste in, so the
  // ratio we report must be the ratio that exact hex produces.
  const ratio = contrastRatio(rounded, bgOpaque);
  if (ratio < requiredRatio) return null;

  return { hex: toHex(rounded), ratio, direction: best.direction };
}

export interface ContrastVerification {
  selector: string;
  /** The suggested color, applied and re-measured in the live DOM, clears the bar. */
  verified: boolean;
  /** Ratio measured with the fix applied, or null when the element could not be read. */
  ratio: number | null;
  /** Computed foreground with the fix applied — differs when the cascade overrides it. */
  computedFg: string | null;
  /** Why verification failed, when it did. */
  note?: string;
}

/**
 * Audit the remediation, not just the defect: apply each suggested color in the live DOM,
 * re-measure, and restore.
 *
 * The Node-side suggestion is already re-measured mathematically, but math assumes the
 * suggested hex is what paints. The cascade decides that, in two stages: a plain inline
 * declaration first (which is also what the suggestion's ratio predicts), then inline
 * `!important` when something heavier owns the text. Whatever still wins after that is
 * paint-level — `-webkit-text-fill-color`, which ignores `color` entirely — or forced.
 * Backgrounds are re-walked with the fix in place, since `currentColor` backgrounds move
 * with the foreground. Every inline style is then put back.
 */
export async function verifyContrastFixes(
  page: Page,
  items: Array<{ selector: string; suggestedFg: string; requiredRatio: number }>,
): Promise<ContrastVerification[]> {
  if (!items.length) return [];
  return (await page
    .evaluate((list: Array<{ selector: string; suggestedFg: string; requiredRatio: number }>) => {
      const parse = (str: string): { r: number; g: number; b: number; a: number } | null => {
        if (!str) return null;
        const s = str.trim().toLowerCase();
        if (s.startsWith('#')) {
          const hex = s.slice(1);
          if (hex.length === 3 || hex.length === 6) {
            const full = hex.length === 3 ? hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] : hex;
            return {
              r: parseInt(full.slice(0, 2), 16),
              g: parseInt(full.slice(2, 4), 16),
              b: parseInt(full.slice(4, 6), 16),
              a: 1,
            };
          }
          return null;
        }
        const m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
        if (m) {
          let a = 1;
          if (m[4] !== undefined) {
            a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
            a = Math.min(1, Math.max(0, a));
          }
          return {
            r: Math.min(255, Math.max(0, Math.round(parseFloat(m[1])))),
            g: Math.min(255, Math.max(0, Math.round(parseFloat(m[2])))),
            b: Math.min(255, Math.max(0, Math.round(parseFloat(m[3])))),
            a,
          };
        }
        if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
        if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
        if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
        return null;
      };

      const blend = (
        fg: { r: number; g: number; b: number; a: number },
        bg: { r: number; g: number; b: number; a: number },
      ): { r: number; g: number; b: number; a: number } => {
        const a = fg.a + bg.a * (1 - fg.a);
        if (a <= 0) return { r: 255, g: 255, b: 255, a: 0 };
        return {
          r: Math.round((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a),
          g: Math.round((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a),
          b: Math.round((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a),
          a,
        };
      };

      const lum = (c: { r: number; g: number; b: number }): number => {
        const lin = (v: number): number => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      };

      const contrast = (
        c1: { r: number; g: number; b: number },
        c2: { r: number; g: number; b: number },
      ): number => {
        const higher = Math.max(lum(c1), lum(c2));
        const lower = Math.min(lum(c1), lum(c2));
        return Math.round(((higher + 0.05) / (lower + 0.05)) * 100) / 100;
      };

      const toHex = (c: { r: number; g: number; b: number }): string => {
        const h = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
        return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
      };

      const effectiveBg = (el: Element): { r: number; g: number; b: number; a: number } => {
        let curr: Element | null = el;
        const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
        while (curr && curr !== document.documentElement) {
          const parsed = parse(window.getComputedStyle(curr).backgroundColor);
          if (parsed && parsed.a > 0) {
            layers.push(parsed);
            if (parsed.a >= 1) break;
          }
          curr = curr.parentElement;
        }
        if (!layers.length || layers[layers.length - 1].a < 1) {
          const rootParsed = parse(window.getComputedStyle(document.documentElement).backgroundColor);
          if (rootParsed && rootParsed.a > 0) layers.push(rootParsed);
          layers.push({ r: 255, g: 255, b: 255, a: 1 });
        }
        let res = layers[layers.length - 1];
        for (let i = layers.length - 2; i >= 0; i--) res = blend(layers[i], res);
        return res;
      };

      return list.map((item) => {
        const el = document.querySelector(item.selector) as HTMLElement | null;
        if (!el) {
          return {
            selector: item.selector,
            verified: false,
            ratio: null,
            computedFg: null,
            note: 'element not found for verification',
          };
        }
        const style = (target: HTMLElement): CSSStyleDeclaration => window.getComputedStyle(target);
        const hadInline = el.style.getPropertyValue('color');
        const hadPriority = el.style.getPropertyPriority('color');
        try {
          // Stage 1: a plain declaration. If the computed color does not move, something
          // with more cascade weight owns this text — find out what before forcing it.
          el.style.setProperty('color', item.suggestedFg);
          let painted = parse(style(el).color);
          let neededImportant = false;
          if (!painted || toHex(painted) !== item.suggestedFg.toLowerCase()) {
            // Stage 2: inline !important beats every author rule, so whatever still wins
            // is not a normal declaration — it is paint-level (text-fill) or forced.
            el.style.setProperty('color', item.suggestedFg, 'important');
            painted = parse(style(el).color);
            neededImportant = true;
          }
          if (!painted) {
            return {
              selector: item.selector,
              verified: false,
              ratio: null,
              computedFg: null,
              note: 'computed color unreadable with the fix applied',
            };
          }
          // -webkit-text-fill-color paints over `color` and ignores it entirely: the
          // computed color can match the suggestion while the pixels never change.
          const fillRaw = style(el).getPropertyValue('-webkit-text-fill-color');
          const fill = fillRaw ? parse(fillRaw) : null;
          const fillWins = !!fill && toHex(fill) !== toHex(painted);
          const fg = fillWins ? fill! : painted;
          if (toHex(fg) !== item.suggestedFg.toLowerCase()) {
            return {
              selector: item.selector,
              verified: false,
              ratio: contrast(fg, effectiveBg(el)),
              computedFg: toHex(fg),
              note: fillWins
                ? 'text paints via -webkit-text-fill-color — set that property, not color'
                : 'stylesheet still overrides the fix — edit the stylesheet rule instead of the inline color',
            };
          }
          const ratio = contrast(fg, effectiveBg(el));
          if (ratio < item.requiredRatio) {
            return {
              selector: item.selector,
              verified: false,
              ratio,
              computedFg: toHex(fg),
              note: 'applied fix still below the required ratio',
            };
          }
          return {
            selector: item.selector,
            verified: true,
            ratio,
            computedFg: toHex(fg),
            ...(neededImportant
              ? { note: 'needs !important to beat the existing rule — a plain declaration will not move it' }
              : {}),
          };
        } finally {
          if (hadInline) el.style.setProperty('color', hadInline, hadPriority);
          else el.style.removeProperty('color');
        }
      });
    }, items)
    .catch(() => [])) as ContrastVerification[];
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
  await primeSelectors(page, ['h1, h2, h3, h4, h5, h6, p, a, button, [role="button"], label, th, td, li, span, code, pre']);
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

    var deepAll = (window.__uicrawlQ || function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); });
    var textEls = Array.from(
      deepAll('h1, h2, h3, h4, h5, h6, p, a, button, [role="button"], label, th, td, li, span, code, pre')
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
  const pendingVerification: Array<{ finding: RawFinding; requiredRatio: number }> = [];
  for (const s of evalResult.samples) {
    if (!s.passes) {
      const suggestion = suggestAccessibleColor(s.fg, s.bg, s.requiredRatio);
      // Naming the replacement hex is the whole point: "adjust the foreground" hands the
      // agent the arithmetic this tool exists to do. When no hue-preserving move clears
      // the bar, say so plainly instead of implying any fg tweak will work.
      const remediation = suggestion
        ? `Contrast is ${s.ratio}:1 (needs >= ${s.requiredRatio}:1). Set color to ${suggestion.hex} — same hue, ${suggestion.direction}ed, ${suggestion.ratio}:1 against ${s.bg}.`
        : `Contrast is ${s.ratio}:1 (needs >= ${s.requiredRatio}:1). No ${s.fg} shade clears the bar against ${s.bg}; darken or lighten the background instead.`;

      const finding: RawFinding = {
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
            ...(suggestion ? { suggestedFg: suggestion.hex, suggestedRatio: suggestion.ratio } : {}),
          },
          remediation,
        },
      };
      rawFindings.push(finding);
      if (suggestion && s.selector) {
        pendingVerification.push({ finding, requiredRatio: s.requiredRatio });
      }
    }
  }

  // Audit the remediation, not just the defect: apply each suggestion in the live DOM and
  // confirm the ratio really clears. A stylesheet `!important` is the classic way a
  // correct suggestion does nothing — the finding then says which edit will work instead.
  if (pendingVerification.length) {
    const results = await verifyContrastFixes(
      page,
      pendingVerification.map(({ finding, requiredRatio }) => ({
        selector: finding.evidence.selector!,
        suggestedFg: finding.evidence.contrast!.suggestedFg!,
        requiredRatio,
      })),
    ).catch(() => []);
    const bySelector = new Map(results.map((r) => [r.selector, r]));
    for (const { finding } of pendingVerification) {
      const v = bySelector.get(finding.evidence.selector!);
      if (!v) continue;
      const c = finding.evidence.contrast!;
      c.verified = v.verified;
      if (v.ratio !== null) c.verifiedRatio = v.ratio;
      if (v.verified) {
        finding.evidence.remediation += ` Verified in-page (${v.ratio}:1 measured with the fix applied)`;
        // A warning, not a failure: the value works, but only with cascade weight the
        // agent must reproduce in its own edit.
        if (v.note) finding.evidence.remediation += ` — ${v.note}.`;
        else finding.evidence.remediation += '.';
      } else if (v.note) {
        finding.evidence.remediation += ` In-page check: ${v.note}.`;
      }
    }
  }

  return {
    rawFindings,
    palette: evalResult.palette,
    textDigest: evalResult.textDigest,
    textLength: evalResult.textLength,
  };
}
