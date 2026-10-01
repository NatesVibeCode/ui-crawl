import type { Page } from 'playwright';
import type { RawFinding, Box } from './types.js';
import { primeSelectors } from './locate.js';
import { contrastRatio, parseColor } from './colors.js';

/**
 * SVG-internals audit — the failure class string assertions cannot see.
 *
 * HTML-level detectors treat an inline `<svg>` as one opaque box, so a diagram
 * can be visibly destroyed (transposed viewBox, clipped geometry, colliding
 * labels, 95px glyphs from viewBox-only sizing, collapsed data marks) while
 * every other detector reports clean. This audit opens each inline SVG and
 * checks its internals against its own viewport:
 *  - geometry rendered outside the SVG viewport (clipped content)
 *  - viewBox orientation disagreeing with content orientation (transposed box)
 *  - labels sharing pixels with other labels
 *  - text rendered at an absurd effective size after SVG transforms
 *  - filled shapes rendering zero area (collapsed data marks)
 *  - SVG text contrast against its local backdrop (the HTML color audit
 *    only covers HTML text, so heatmap-on-cell text is otherwise unchecked)
 *
 * Decorative SVGs without text are skipped for inferred orientation and
 * overflow checks: a full-bleed background wave may intentionally bleed.
 * Silence is taste; every finding here carries positive evidence.
 */

export interface SvgShapeSnapshot {
  selector: string;
  tag: string;
  box: { x: number; y: number; w: number; h: number };
  text?: string;
  rotated?: boolean;
  specifiedFontPx?: number;
  effectiveFontPx?: number;
  fill?: string;
  fillNone?: boolean;
  fillOpacity?: number;
  paintOpacity?: number;
  visiblePaint?: boolean;
  behindFill?: string;
}

export interface SvgSnapshot {
  selector: string;
  viewport: { x: number; y: number; w: number; h: number };
  viewBox: { x: number; y: number; w: number; h: number } | null;
  scale: number;
  clipsOverflow?: boolean;
  shapes: SvgShapeSnapshot[];
}

export type SvgIssueKind =
  | 'svg-geometry-outside-viewbox'
  | 'svg-viewbox-aspect-mismatch'
  | 'svg-text-overlap'
  | 'svg-text-scaled'
  | 'svg-degenerate-geometry'
  | 'low-contrast';

export interface SvgIssue {
  kind: SvgIssueKind;
  selector: string;
  svgSelector: string;
  otherSelector?: string;
  overlapFrac?: number;
  box?: Box;
  otherBox?: Box;
  overflowPx?: number;
  viewBox?: { x: number; y: number; w: number; h: number };
  contentAspect?: number;
  viewBoxAspect?: number;
  effectiveFontPx?: number;
  specifiedFontPx?: number;
  textSample?: string;
  contrast?: { ratio: number; fg: string; bg: string; fontSize: string; textSample: string };
  remediation: string;
}

const OUTSIDE_TOLERANCE_PX = 4;
const TEXT_OVERLAP_FRAC = 0.2;
const SCALE_BLOWUP = 2.5;
const EFFECTIVE_FONT_PX = 40;
const MAX_TEXT_PAIR_FINDINGS = 5;
const MAX_DEGENERATE_FINDINGS = 5;
const MAX_CONTRAST_FINDINGS = 10;

function frac(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bt <= y) return 0;
  const area = (r - x) * (bt - y);
  const minArea = Math.min(Math.max(1, a.w * a.h), Math.max(1, b.w * b.h));
  return area / minArea;
}

function outsidePx(inner: { x: number; y: number; w: number; h: number }, outer: { x: number; y: number; w: number; h: number }): number {
  return Math.max(0, outer.x - inner.x, outer.y - inner.y, inner.x + inner.w - (outer.x + outer.w), inner.y + inner.h - (outer.y + outer.h));
}

function toBox(selector: string, b: { x: number; y: number; w: number; h: number }): Box {
  return { selector, x: b.x, y: b.y, w: b.w, h: b.h };
}

/**
 * Pure classifier over one harvested SVG snapshot. Deterministic and
 * DOM-free, so the mdview regression shapes live here as unit fixtures.
 */
export function classifySvgSnapshot(svg: SvgSnapshot): SvgIssue[] {
  const issues: SvgIssue[] = [];
  const shapes = svg.shapes;
  const painted = shapes.filter((s) => s.visiblePaint !== false);
  const texts = painted.filter((s) => s.tag === 'text' && (s.text ?? '').length > 0 && s.box.w > 0 && s.box.h > 0);
  const drawn = painted.filter((s) => s.box.w > 0.5 || s.box.h > 0.5);

  // A filled primitive with a collapsed dimension is evidence of a lost chart mark.
  // Keep this check independent of text: charts often have no labels.
  let degenerateCount = 0;
  for (const s of painted) {
    if (degenerateCount >= MAX_DEGENERATE_FINDINGS) break;
    if (s.tag !== 'rect' && s.tag !== 'circle' && s.tag !== 'ellipse') continue;
    if (s.fillNone || (s.fillOpacity ?? 1) <= 0 || (s.paintOpacity ?? 1) < 0.99) continue;
    if (s.box.w > 0.01 && s.box.h > 0.01) continue;
    degenerateCount++;
    issues.push({
      kind: 'svg-degenerate-geometry',
      selector: s.selector,
      svgSelector: svg.selector,
      box: toBox(s.selector, s.box),
      remediation: 'A filled SVG <' + s.tag + '> has no visible area. Check the chart or diagram coordinates that produced this mark.',
    });
  }

  // Decorative SVGs without text are ambiguous; skip inferred orientation and overflow
  // judgments for them, while still catching a collapsed filled mark above.
  if (texts.length === 0) return issues;

  // Content bounds over drawn geometry.
  let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
  for (const s of drawn) {
    cx0 = Math.min(cx0, s.box.x); cy0 = Math.min(cy0, s.box.y);
    cx1 = Math.max(cx1, s.box.x + s.box.w); cy1 = Math.max(cy1, s.box.y + s.box.h);
  }
  const hasContent = cx1 > cx0 && cy1 > cy0;

  // 1. Geometry outside a viewport that actually clips overflow (negative coordinates,
  // transposed mapping). Horizontal and vertical lines count even with a zero-height box.
  if (svg.clipsOverflow !== false) {
    let worst: SvgShapeSnapshot | null = null;
    let worstPx = 0;
    for (const s of painted) {
      if (s.box.w <= 0 && s.box.h <= 0) continue;
      const px = outsidePx(s.box, svg.viewport);
      if (px > worstPx) { worstPx = px; worst = s; }
    }
    if (worst && worstPx > OUTSIDE_TOLERANCE_PX) {
      issues.push({
        kind: 'svg-geometry-outside-viewbox',
        selector: worst.selector,
        svgSelector: svg.selector,
        box: toBox(worst.selector, worst.box),
        otherBox: toBox(svg.selector, svg.viewport),
        overflowPx: worstPx,
        remediation: 'SVG content renders ' + Math.round(worstPx) + 'px outside its clipped viewport. Fix the geometry or widen the viewBox to contain it.',
      });
    }
  }

  // 2. Transposed viewBox: content strongly directional one way, box the other.
  if (hasContent && svg.viewBox && svg.viewBox.w > 0 && svg.viewBox.h > 0) {
    const contentAspect = (cx1 - cx0) / (cy1 - cy0);
    const viewBoxAspect = svg.viewBox.w / svg.viewBox.h;
    const disagrees = (contentAspect >= 2 && viewBoxAspect <= 0.5) || (contentAspect <= 0.5 && viewBoxAspect >= 2);
    if (disagrees) {
      issues.push({
        kind: 'svg-viewbox-aspect-mismatch',
        selector: svg.selector,
        svgSelector: svg.selector,
        viewBox: svg.viewBox,
        contentAspect,
        viewBoxAspect,
        remediation: 'Content orientation conflicts with the viewBox orientation (' + contentAspect.toFixed(2) + ' vs ' + viewBoxAspect.toFixed(2) + '). Check whether the viewBox width and height were swapped.',
      });
    }
  }

  // 3a. Text-text collisions (independent labels sharing pixels is never deliberate).
  let pairCount = 0;
  for (let i = 0; i < texts.length && pairCount < MAX_TEXT_PAIR_FINDINGS; i++) {
    for (let j = i + 1; j < texts.length && pairCount < MAX_TEXT_PAIR_FINDINGS; j++) {
      const a = texts[i], b = texts[j];
      if (a.rotated || b.rotated) continue;
      const f = frac(a.box, b.box);
      if (f > TEXT_OVERLAP_FRAC) {
        pairCount++;
        issues.push({
          kind: 'svg-text-overlap',
          selector: a.selector,
          svgSelector: svg.selector,
          otherSelector: b.selector,
          overlapFrac: f,
          box: toBox(a.selector, a.box),
          otherBox: toBox(b.selector, b.box),
          textSample: a.text,
          remediation: `SVG labels "${(a.text ?? '').slice(0, 40)}" and "${(b.text ?? '').slice(0, 40)}" overlap (${Math.round(f * 100)}% of the smaller). Fix label placement with a perpendicular offset so edge labels clear each other.`,
        });
      }
    }
  }

  // 4. Text made far larger by its actual SVG transform, including viewBox mapping.
  let worstT: SvgShapeSnapshot | null = null;
  let worstEff = 0;
  for (const t of texts) {
    const base = t.specifiedFontPx ?? 12;
    if (base <= 0) continue;
    const eff = t.effectiveFontPx ?? base * svg.scale;
    if (eff / base >= SCALE_BLOWUP && eff >= EFFECTIVE_FONT_PX && eff > worstEff) {
      worstEff = eff;
      worstT = t;
    }
  }
  if (worstT) {
    const base = worstT.specifiedFontPx ?? 12;
    issues.push({
      kind: 'svg-text-scaled',
      selector: worstT.selector,
      svgSelector: svg.selector,
      box: toBox(worstT.selector, worstT.box),
      effectiveFontPx: worstEff,
      specifiedFontPx: base,
      textSample: worstT.text,
      remediation: 'SVG text grows from about ' + base + 'px to ' + Math.round(worstEff) + 'px after SVG scaling. Check the viewBox and text or ancestor transforms.',
    });
  }

  // 6. SVG text contrast against its local backdrop (HTML audit does not cover SVG text).
  let contrastCount = 0;
  for (const t of texts) {
    if (contrastCount >= MAX_CONTRAST_FINDINGS) break;
    if (!t.fill || !t.behindFill || t.fillNone || (t.fillOpacity ?? 1) < 0.99 || (t.paintOpacity ?? 1) < 0.99) continue;
    const fg = parseColor(t.fill);
    const bg = parseColor(t.behindFill);
    if (!fg || !bg || (fg.a ?? 1) < 1 || (bg.a ?? 1) < 1) continue;
    const ratio = contrastRatio(fg, bg);
    const effective = t.effectiveFontPx ?? (t.specifiedFontPx ?? 12) * svg.scale;
    const large = effective >= 24;
    const required = large ? 3 : 4.5;
    if (ratio >= required) continue;
    contrastCount++;
    const sample = (t.text ?? '').slice(0, 60);
    issues.push({
      kind: 'low-contrast',
      selector: t.selector,
      svgSelector: svg.selector,
      textSample: sample,
      contrast: { ratio, fg: t.fill, bg: t.behindFill, fontSize: `~${Math.round(effective)}px effective`, textSample: sample },
      remediation: `SVG text contrast is ${ratio}:1 (needs >= ${required}:1). Adjust the label color or the cell fill it sits on.`,
    });
  }

  return issues;
}

/**
 * Deterministic DOM audit for SVG internals. Harvests serializable snapshots
 * in-page, then classifies out-of-page so the rules stay unit-testable.
 */
export async function auditPageSvg(page: Page, route: string, options: { skipContrast?: boolean } = {}): Promise<RawFinding[]> {
  await primeSelectors(page, ['svg', 'svg text', 'svg rect, svg circle, svg ellipse, svg path, svg line, svg polygon, svg polyline']);
  const snapshots = await page.evaluate(() => {
    const deepAll = ((w: any) => (w.__uicrawlQ || function (s: string) { return Array.from(document.querySelectorAll(s)); }))(window);
    const out: {
      selector: string;
      viewport: { x: number; y: number; w: number; h: number };
      viewBox: { x: number; y: number; w: number; h: number } | null;
      scale: number;
      clipsOverflow: boolean;
      shapes: {
        selector: string; tag: string;
        box: { x: number; y: number; w: number; h: number };
        text?: string; rotated?: boolean; specifiedFontPx?: number; effectiveFontPx?: number;
        fill?: string; fillNone?: boolean; fillOpacity?: number; paintOpacity?: number;
        visiblePaint?: boolean; behindFill?: string;
      }[];
    }[] = [];

    function selectorFor(el: Element, idx?: number): string {
      if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
      const rawClass = typeof el.className === 'string' ? el.className : '';
      const cls = rawClass.trim()
        ? '.' + rawClass.trim().split(' ').filter(Boolean).slice(0, 2).join('.')
        : '';
      const tag = el.tagName.toLowerCase();
      return idx !== undefined ? tag + cls + ':nth(' + idx + ')' : tag + cls;
    }

    function styleHidden(el: Element): boolean {
      let cur: Element | null = el;
      let depth = 0;
      while (cur && depth < 32) {
        const st = window.getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') <= 0.05) return true;
        cur = cur.parentElement;
        depth++;
      }
      return false;
    }

    function opacityThrough(el: Element, root: SVGSVGElement): number {
      let opacity = 1;
      let cur: Element | null = el;
      let depth = 0;
      while (cur && depth < 32) {
        const value = parseFloat(window.getComputedStyle(cur).opacity || '1');
        if (Number.isFinite(value)) opacity *= Math.min(1, Math.max(0, value));
        if (cur === root) break;
        cur = cur.parentElement;
        depth++;
      }
      return opacity;
    }

    function matrixScale(matrix: DOMMatrix | null): number | undefined {
      if (!matrix) return undefined;
      const aa = matrix.a * matrix.a + matrix.b * matrix.b;
      const cc = matrix.c * matrix.c + matrix.d * matrix.d;
      const ac = matrix.a * matrix.c + matrix.b * matrix.d;
      const largestEigenvalue = (aa + cc + Math.sqrt(Math.max(0, (aa - cc) * (aa - cc) + 4 * ac * ac))) / 2;
      const value = Math.sqrt(largestEigenvalue);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    }

    function visiblePaint(tag: string, fill: string, stroke: string, fillOpacity: number, strokeOpacity: number, strokeWidth: number, box: { w: number; h: number }): boolean {
      const fillCanPaint = tag !== 'line' && tag !== 'polyline' && tag !== 'image' && tag !== 'foreignobject' && tag !== 'use';
      const hasFill = fillCanPaint && fill !== 'none' && fillOpacity > 0;
      const hasStroke = stroke !== 'none' && strokeOpacity > 0 && strokeWidth > 0;
      const replaced = (tag === 'image' || tag === 'foreignobject' || tag === 'use') && box.w > 0 && box.h > 0;
      return hasFill || hasStroke || replaced;
    }

    const svgs = Array.from(deepAll('svg')) as SVGSVGElement[];
    svgs.forEach((svg, si) => {
      if (styleHidden(svg)) return;
      const vr = svg.getBoundingClientRect();
      if (vr.width <= 0 || vr.height <= 0) return;
      const vbAttr = svg.getAttribute('viewBox');
      let viewBox: { x: number; y: number; w: number; h: number } | null = null;
      if (vbAttr) {
        const parts = vbAttr.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
          viewBox = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
        }
      }
      const rootStyle = window.getComputedStyle(svg);
      const clipsOverflow = rootStyle.overflowX !== 'visible' || rootStyle.overflowY !== 'visible';
      const scale = matrixScale(svg.getScreenCTM()) ?? 1;
      const shapes: (typeof out)[number]['shapes'] = [];
      const selector = 'rect,circle,ellipse,line,path,polygon,polyline,text,use,image,foreignObject';
      const els = (Array.from(svg.querySelectorAll(selector)) as Element[])
        .filter((el) => (el as SVGElement).ownerSVGElement === svg);
      els.forEach((el, ei) => {
        if (styleHidden(el)) return;
        const r = el.getBoundingClientRect();
        const box = { x: r.x, y: r.y, w: r.width, h: r.height };
        const tag = el.tagName.toLowerCase();
        const sel = selectorFor(el, ei);
        const style = window.getComputedStyle(el);
        const fill = style.fill;
        const stroke = style.stroke;
        const fillOpacity = parseFloat(style.getPropertyValue('fill-opacity') || '1');
        const strokeOpacity = parseFloat(style.getPropertyValue('stroke-opacity') || '1');
        const strokeWidth = parseFloat(style.getPropertyValue('stroke-width') || '0');
        const paintOpacity = opacityThrough(el, svg) * (Number.isFinite(fillOpacity) ? fillOpacity : 1);
        const hasPaint = visiblePaint(
          tag, fill, stroke,
          Number.isFinite(fillOpacity) ? fillOpacity : 1,
          Number.isFinite(strokeOpacity) ? strokeOpacity : 1,
          Number.isFinite(strokeWidth) ? strokeWidth : 0,
          { w: r.width, h: r.height },
        );
        if (tag === 'text') {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text) return;
          const t = el.getAttribute('transform') || '';
          const computedFontPx = parseFloat(style.fontSize);
          const textScale = matrixScale((el as SVGGraphicsElement).getScreenCTM() ?? null);
          shapes.push({
            selector: sel, tag, box, text, rotated: /rotate\s*\(/.test(t),
            specifiedFontPx: Number.isFinite(computedFontPx) && computedFontPx > 0 ? computedFontPx : undefined,
            effectiveFontPx: Number.isFinite(computedFontPx) && computedFontPx > 0 && textScale
              ? computedFontPx * textScale
              : undefined,
            fill: fill || undefined,
            fillNone: fill === 'none',
            fillOpacity: Number.isFinite(fillOpacity) ? fillOpacity : 1,
            paintOpacity,
            visiblePaint: hasPaint,
          });
        } else {
          shapes.push({
            selector: sel, tag, box,
            fill: fill || undefined,
            fillNone: fill === 'none',
            fillOpacity: Number.isFinite(fillOpacity) ? fillOpacity : 1,
            paintOpacity,
            visiblePaint: hasPaint,
          });
        }
      });

      // Use earlier painted opaque primitive fills as local text backdrops. elementFromPoint
      // is viewport-limited, so it cannot read labels below the fold.
      for (let i = 0; i < shapes.length; i++) {
        const text = shapes[i];
        if (text.tag !== 'text' || text.fillNone || (text.fillOpacity ?? 1) < 0.99 || (text.paintOpacity ?? 1) < 0.99) continue;
        const cx = text.box.x + text.box.w / 2;
        const cy = text.box.y + text.box.h / 2;
        for (let j = i - 1; j >= 0; j--) {
          const shape = shapes[j];
          if (shape.tag !== 'rect' && shape.tag !== 'circle' && shape.tag !== 'ellipse') continue;
          if (!shape.fill || shape.fillNone || (shape.fillOpacity ?? 1) < 0.99 || (shape.paintOpacity ?? 1) < 0.99) continue;
          if (cx < shape.box.x || cx > shape.box.x + shape.box.w || cy < shape.box.y || cy > shape.box.y + shape.box.h) continue;
          text.behindFill = shape.fill;
          break;
        }
      }

      out.push({
        selector: selectorFor(svg, si),
        viewport: { x: vr.x, y: vr.y, w: vr.width, h: vr.height },
        viewBox, scale, clipsOverflow, shapes,
      });
    });
    return out;
  });

  const issues = (snapshots as SvgSnapshot[]).flatMap(classifySvgSnapshot)
    .filter((issue) => !options.skipContrast || issue.kind !== 'low-contrast');
  return issues.map((iss) => {
    if (iss.kind === 'low-contrast' && iss.contrast) {
      return {
        route,
        kind: iss.kind,
        evidence: {
          selector: iss.selector,
          contrast: iss.contrast,
          svg: {
            svgSelector: iss.svgSelector,
            box: iss.box,
            textSample: iss.textSample,
          },
          remediation: iss.remediation,
        },
      } as RawFinding;
    }
    return {
      route,
      kind: iss.kind,
      evidence: {
        selector: iss.selector,
        remediation: iss.remediation,
        svg: {
          svgSelector: iss.svgSelector,
          otherSelector: iss.otherSelector,
          overlapFrac: iss.overlapFrac,
          box: iss.box,
          otherBox: iss.otherBox,
          overflowPx: iss.overflowPx,
          viewBox: iss.viewBox,
          contentAspect: iss.contentAspect,
          viewBoxAspect: iss.viewBoxAspect,
          effectiveFontPx: iss.effectiveFontPx,
          specifiedFontPx: iss.specifiedFontPx,
          textSample: iss.textSample,
        },
      },
    } as RawFinding;
  });
}
