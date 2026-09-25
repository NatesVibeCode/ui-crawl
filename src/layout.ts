import type { Page } from 'playwright';
import type { RawFinding, Box } from './types.js';

export interface LayoutAuditOptions {
  viewport?: { width: number; height: number; label?: string };
}

export interface LayoutIssue {
  kind:
    | 'layout-overlap'
    | 'text-overlap'
    | 'text-line-collision'
    | 'clipped-text'
    | 'viewport-overflow'
    | 'container-overflow'
    | 'sibling-overlap';
  selector: string;
  otherSelector?: string;
  remediation?: string;
  overlapFrac?: number;
  box?: Box;
  otherBox?: Box;
  ratio?: number;
  fontSize?: string;
  lineHeight?: string;
  directOverlap?: boolean;
  scrollWidth?: number;
  clientWidth?: number;
  textSample?: string;
  overflowPx?: number;
}

/**
 * Pure helper to compute intersection area and ratio between two 2D boxes.
 */
export function boxIntersection(a: Box, b: Box): { area: number; frac: number } {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || btm <= y) return { area: 0, frac: 0 };
  const area = (r - x) * (btm - y);
  const minArea = Math.min(Math.max(1, a.w * a.h), Math.max(1, b.w * b.h));
  return { area, frac: area / minArea };
}

/**
 * Deterministic DOM audit for layout collisions, multiline typography descender clashes,
 * silent text clipping, and viewport overflow.
 */
export async function auditPageLayout(
  page: Page,
  route: string,
  options: LayoutAuditOptions = {},
): Promise<RawFinding[]> {
  const issues = await page
    .evaluate(() => {
      const findings: {
        kind:
          | 'layout-overlap'
          | 'text-overlap'
          | 'text-line-collision'
          | 'clipped-text'
          | 'viewport-overflow'
          | 'container-overflow'
          | 'sibling-overlap';
        selector: string;
        otherSelector?: string;
        remediation?: string;
        overlapFrac?: number;
        box?: { selector: string; x: number; y: number; w: number; h: number };
        otherBox?: { selector: string; x: number; y: number; w: number; h: number };
        ratio?: number;
        fontSize?: string;
        lineHeight?: string;
        directOverlap?: boolean;
        scrollWidth?: number;
        clientWidth?: number;
        textSample?: string;
        overflowPx?: number;
      }[] = [];

      function selectorFor(el: Element, idx?: number): string {
        if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
        const cls = typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
        const tag = el.tagName.toLowerCase();
        return idx !== undefined ? `${tag}${cls}:nth(${idx})` : `${tag}${cls}`;
      }

      function textOf(el: Element): string {
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
      }

      function isVisible(el: HTMLElement): boolean {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.05;
      }

      // 1. Horizontal Viewport Overflow Check
      const docW = document.documentElement.scrollWidth;
      const winW = window.innerWidth;
      if (docW > winW + 3) {
        const overflowAmount = docW - winW;
        // Locate elements exceeding viewport right edge
        const allVisible = Array.from(document.querySelectorAll('*')) as HTMLElement[];
        let worstEl: HTMLElement | null = null;
        let maxRight = winW;
        for (const el of allVisible) {
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.right > maxRight + 2) {
            maxRight = r.right;
            worstEl = el;
          }
        }
        const targetSel = worstEl ? selectorFor(worstEl) : 'html';
        findings.push({
          kind: 'viewport-overflow',
          selector: targetSel,
          overflowPx: Math.round(overflowAmount),
          remediation: `Page horizontally overflows by ${Math.round(overflowAmount)}px. Set "max-width: 100%; box-sizing: border-box;" on wide containers or adjust grid/flex min-width.`,
        });
      }

      // 2. Multiline Typography & Descender Clash Audit
      const DESCENDERS = /[gjpqyQ]/;
      const ASCENDERS = /[bdfhkl1-9A-Z]/;
      const typographyCandidates = Array.from(
        document.querySelectorAll('h1, h2, h3, h4, h5, h6, .lede, blockquote, .hero-title, [data-hero-title]'),
      ) as HTMLElement[];

      for (let i = 0; i < typographyCandidates.length; i++) {
        const el = typographyCandidates[i];
        if (!isVisible(el)) continue;
        const text = textOf(el);
        if (text.length < 5) continue;

        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects());

        // Group rects into lines by their vertical position to avoid false overlaps between
        // horizontally adjacent inline spans (e.g. <h1>Title <span class="accent">Subtitle</span></h1>)
        const lines: { top: number; bottom: number }[] = [];
        for (const r of rects) {
          if (r.width <= 0 || r.height <= 0) continue;
          const existing = lines.find((l) => Math.abs(l.top - r.top) < 6);
          if (existing) {
            existing.top = Math.min(existing.top, r.top);
            existing.bottom = Math.max(existing.bottom, r.bottom);
          } else {
            lines.push({ top: r.top, bottom: r.bottom });
          }
        }
        lines.sort((a, b) => a.top - b.top);
        if (lines.length <= 1) continue; // Single line does not wrap; no vertical line collision possible

        const style = window.getComputedStyle(el);
        const fontSize = parseFloat(style.fontSize);
        let lineHeight = parseFloat(style.lineHeight);
        if (isNaN(lineHeight)) {
          lineHeight = fontSize * 1.2;
        }
        const ratio = lineHeight / fontSize;

        // Check A: Direct line-box collision (negative leading where line N bottom overlaps line N+1 top)
        let directOverlap = false;
        for (let l = 0; l < lines.length - 1; l++) {
          if (lines[l].bottom > lines[l + 1].top + 2) {
            directOverlap = true;
            break;
          }
        }

        // Check B: Font descender ink collision:
        // In standard typography, ascender+descender span ~1.20-1.35em. A line-height < 1.15
        // causes glyph collisions whenever line N contains descenders and line N+1 contains ascenders/capitals.
        const hasDescenderRisk = ratio < 1.15 && DESCENDERS.test(text) && ASCENDERS.test(text);

        if (directOverlap || hasDescenderRisk) {
          const sel = selectorFor(el, i);
          findings.push({
            kind: 'text-line-collision',
            selector: sel,
            ratio: Math.round(ratio * 100) / 100,
            fontSize: `${fontSize}px`,
            lineHeight: `${lineHeight}px`,
            directOverlap,
            textSample: text.slice(0, 40),
            remediation: `Computed line-height is ${ratio.toFixed(2)} (${lineHeight.toFixed(0)}px / ${fontSize.toFixed(0)}px) on multiline text. Increase line-height to >= 1.20 to prevent descenders and ascenders from colliding.`,
          });
        }
      }

      // 3. In-Flow Sibling Collisions Audit
      // Query interactive, card, or content elements
      const candidateElements = Array.from(
        document.querySelectorAll(
          'article, section, header, nav, footer, .card, [class*="card"], [class*="badge"], [class*="item"], button, a[href], [role="button"], span, p, h1, h2, h3, h4, h5, h6',
        ),
      ) as HTMLElement[];

      // Filter and capture in-flow geometry
      interface Measured {
        el: HTMLElement;
        selector: string;
        x: number;
        y: number;
        w: number;
        h: number;
        parent: HTMLElement | null;
        isInFlow: boolean;
        hasText: boolean;
      }

      const measured: Measured[] = [];
      for (let i = 0; i < candidateElements.length && measured.length < 250; i++) {
        const el = candidateElements[i];
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const pos = style.position;
        // Strict in-flow: static or relative without manual negative offsets
        const isFlow = (pos === 'static' || pos === 'relative') &&
          parseFloat(style.marginLeft || '0') >= -4 &&
          parseFloat(style.marginTop || '0') >= -4;
        const hasText = textOf(el).length > 0;

        measured.push({
          el,
          selector: selectorFor(el, i),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          parent: el.parentElement,
          isInFlow: isFlow,
          hasText,
        });
      }

      // Sort by Y for sweep-line comparison
      measured.sort((a, b) => a.y - b.y);

      for (let i = 0; i < measured.length; i++) {
        const a = measured[i];
        for (let j = i + 1; j < measured.length; j++) {
          const b = measured[j];
          if (b.y >= a.y + a.h) break; // Past vertical bounding span

          // Check if parent contains child or vice-versa
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;

          // In-flow siblings under the same parent (flex/grid wrap breakdown)
          // Exclude intentionally stacked layers (position: absolute/fixed or different containers)
          if (!a.parent || a.parent !== b.parent || !a.isInFlow || !b.isInFlow) continue;

          // Check for 2D intersection
          const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
          const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

          // Require >= 6px overlap in both dimensions to exclude borders / subpixel rounding
          if (xOverlap > 6 && yOverlap > 6) {
            const interArea = xOverlap * yOverlap;
            const minArea = Math.min(a.w * a.h, b.w * b.h);
            const frac = interArea / minArea;

            if (frac >= 0.1) {
              const parentTag = a.parent.tagName.toLowerCase();
              const parentCls = a.parent.className && typeof a.parent.className === 'string'
                ? '.' + a.parent.className.trim().split(/\s+/)[0]
                : '';
              findings.push({
                kind: 'layout-overlap',
                selector: a.selector,
                otherSelector: b.selector,
                overlapFrac: Math.round(frac * 100) / 100,
                box: { selector: a.selector, x: a.x, y: a.y, w: a.w, h: a.h },
                otherBox: { selector: b.selector, x: b.x, y: b.y, w: b.w, h: b.h },
                remediation: `Add "flex-wrap: wrap;" or gap/min-width constraints to parent <${parentTag}${parentCls}> to allow items to wrap cleanly.`,
              });
            }
          }
        }
      }

      // 3b. Vertical Sibling Overlap Audit (Major layout blocks colliding)
      const majorBlocks = Array.from(
        document.querySelectorAll('main > *, section > *, article > *, body > *, [class*="section"], [class*="intro"], [class*="hero"], [class*="steps"], [class*="grid"]'),
      ) as HTMLElement[];

      for (let i = 0; i < majorBlocks.length; i++) {
        const a = majorBlocks[i];
        if (!isVisible(a)) continue;
        const next = a.nextElementSibling as HTMLElement | null;
        if (!next || !isVisible(next)) continue;

        const aStyle = window.getComputedStyle(a);
        const nextStyle = window.getComputedStyle(next);
        if (aStyle.position === 'absolute' || aStyle.position === 'fixed') continue;
        if (nextStyle.position === 'absolute' || nextStyle.position === 'fixed') continue;

        const ra = a.getBoundingClientRect();
        const rNext = next.getBoundingClientRect();

        const xSpan = Math.min(ra.right, rNext.right) - Math.max(ra.left, rNext.left);
        if (xSpan > 50 && rNext.top < ra.bottom - 4 && rNext.height > 10 && ra.height > 10) {
          const overlapPx = Math.round(ra.bottom - rNext.top);
          findings.push({
            kind: 'sibling-overlap',
            selector: selectorFor(a),
            otherSelector: selectorFor(next),
            overflowPx: overlapPx,
            box: { selector: selectorFor(a), x: ra.x, y: ra.y, w: ra.width, h: ra.height },
            otherBox: { selector: selectorFor(next), x: rNext.x, y: rNext.y, w: rNext.width, h: rNext.height },
            remediation: `Vertical sibling blocks overlap by ${overlapPx}px. Increase margin/gap or remove negative offsets between <${a.tagName.toLowerCase()}> and <${next.tagName.toLowerCase()}>.`,
          });
        }
      }

      // 3c. Container Escape / Child Overflow Audit
      const containers = Array.from(
        document.querySelectorAll('section, article, header, footer, .section, [class*="intro"], [class*="card"], [class*="hero"], [class*="steps"], [class*="split"]'),
      ) as HTMLElement[];

      for (let i = 0; i < containers.length; i++) {
        const c = containers[i];
        if (!isVisible(c)) continue;
        const rc = c.getBoundingClientRect();
        if (rc.height <= 0 || rc.width <= 0) continue;
        const cStyle = window.getComputedStyle(c);
        if (cStyle.overflowY === 'hidden' || cStyle.overflowY === 'clip' || cStyle.overflowY === 'scroll' || cStyle.overflowY === 'auto') continue;

        for (const ch of Array.from(c.children) as HTMLElement[]) {
          if (!isVisible(ch)) continue;
          const chStyle = window.getComputedStyle(ch);
          if (chStyle.position === 'absolute' || chStyle.position === 'fixed') continue;
          const rch = ch.getBoundingClientRect();
          if (rch.bottom > rc.bottom + 4 && rch.height > 12) {
            const bleedPx = Math.round(rch.bottom - rc.bottom);
            findings.push({
              kind: 'container-overflow',
              selector: selectorFor(ch),
              otherSelector: selectorFor(c),
              overflowPx: bleedPx,
              textSample: textOf(ch).slice(0, 40),
              remediation: `Child element <${ch.tagName.toLowerCase()}> extends ${bleedPx}px past the bottom of its parent <${c.tagName.toLowerCase()}>. Increase parent padding/min-height or adjust flex alignment to prevent container bleeding.`,
            });
          }
        }
      }

      // 4. Silent Text Clipping Audit
      const clippedCandidates = Array.from(
        document.querySelectorAll('p, span, h1, h2, h3, h4, h5, h6, button, a[href], [class*="label"], [class*="badge"]'),
      ) as HTMLElement[];

      for (let i = 0; i < clippedCandidates.length && i < 150; i++) {
        const el = clippedCandidates[i];
        if (!isVisible(el)) continue;
        const style = window.getComputedStyle(el);
        const ox = style.overflowX;
        const oy = style.overflowY;
        const isHidden = ox === 'hidden' || ox === 'clip' || oy === 'hidden' || oy === 'clip';
        if (!isHidden) continue;

        const hasEllipsis = style.textOverflow === 'ellipsis';
        const hasLineClamp = (style as unknown as { webkitLineClamp?: string }).webkitLineClamp && (style as unknown as { webkitLineClamp?: string }).webkitLineClamp !== 'none';
        if (hasEllipsis || hasLineClamp) continue; // Deliberate and accessible truncation

        // Exempt screen-reader only elements (e.g. .sr-only, .visually-hidden, or 1px clipped off-screen)
        if (el.classList.contains('sr-only') || el.classList.contains('visually-hidden') || el.clientWidth <= 2 || el.clientHeight <= 2) continue;

        const diffW = el.scrollWidth - el.clientWidth;
        const diffH = el.scrollHeight - el.clientHeight;
        if (diffW > 4 || diffH > 4) {
          const text = textOf(el);
          if (text.length > 0) {
            findings.push({
              kind: 'clipped-text',
              selector: selectorFor(el, i),
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
              textSample: text.slice(0, 30),
              remediation: `Text overflows container without an ellipsis. Add "text-overflow: ellipsis; white-space: nowrap;" or "overflow-wrap: anywhere;".`,
            });
          }
        }
      }

      return findings;
    })
    .catch(() => []);

  return issues.map((iss) => ({
    route,
    kind: iss.kind,
    evidence: {
      selector: iss.selector,
      viewport: options.viewport,
      remediation: iss.remediation,
      layout: {
        otherSelector: iss.otherSelector,
        overlapFrac: iss.overlapFrac,
        box: iss.box,
        otherBox: iss.otherBox,
        overflowPx: iss.overflowPx,
      },
      typography: {
        ratio: iss.ratio,
        fontSize: iss.fontSize,
        lineHeight: iss.lineHeight,
        directOverlap: iss.directOverlap,
      },
      clipping: iss.scrollWidth && iss.clientWidth ? {
        scrollWidth: iss.scrollWidth,
        clientWidth: iss.clientWidth,
        textSample: iss.textSample,
      } : undefined,
    },
  }));
}
