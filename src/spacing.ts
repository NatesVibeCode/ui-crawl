import type { Page } from 'playwright';
import type { Box, RawFinding } from './types.js';

export interface SpacingIssue {
  kind: 'tight-target';
  selector: string;
  otherSelector?: string;
  distancePx: number;
  box: Box;
  otherBox?: Box;
}

/** Check edge-to-edge distance between two non-overlapping bounding boxes. */
export function edgeDistance(a: Box, b: Box): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  // If both overlap, distance is 0 (collision/containment)
  if (xOverlap > 0 && yOverlap > 0) return 0;

  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));

  if (yOverlap > 0) return dx; // Side-by-side
  if (xOverlap > 0) return dy; // Vertically stacked
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

/** In-browser audit for touch targets and crowded interactive controls. */
export async function auditPageSpacing(page: Page, route: string): Promise<RawFinding[]> {
  const issues = await page.evaluate(() => {
    const SELECTOR = 'button, a[href], [role="button"], input[type="submit"], input[type="button"]';
    const els = Array.from(document.querySelectorAll(SELECTOR)) as HTMLElement[];
    const boxes: { elIndex: number; tag: string; selector: string; isInlineLink: boolean; x: number; y: number; w: number; h: number }[] = [];

    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      const sel = `${el.tagName.toLowerCase()}:nth(${i})${text ? ` "${text}"` : ''}`;
      const isInlineLink = el.tagName.toLowerCase() === 'a' && (style.display === 'inline' || style.display === 'inline-block');
      boxes.push({
        elIndex: i,
        tag: el.tagName.toLowerCase(),
        selector: sel,
        isInlineLink,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    }

    const found: {
      selector: string;
      otherSelector?: string;
      distancePx: number;
      box: { selector: string; x: number; y: number; w: number; h: number };
      otherBox?: { selector: string; x: number; y: number; w: number; h: number };
    }[] = [];

    // 1. Check for undersized touch targets (< 20px)
    // Inline text links in running sentences/paragraphs are explicitly exempt per WCAG 2.5.8.
    for (const b of boxes) {
      if (b.isInlineLink) continue;
      if ((b.w < 20 || b.h < 20) && (b.w > 0 && b.h > 0)) {
        found.push({
          selector: b.selector,
          distancePx: Math.min(b.w, b.h),
          box: b,
        });
      }
    }

    // 2. Check for tight sibling/adjacent controls (< 4px edge gap)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];

        // Skip if both controls are full-sized (e.g. width and height >= 32px)
        // WCAG 2.5.8 spacing requirements apply to undersized/compact controls where tap collisions occur.
        // Full-sized stacked navigation buttons (e.g. 236x36px) or menu items with 1-3px gaps are standard UI.
        const aCompact = a.w < 32 || a.h < 32;
        const bCompact = b.w < 32 || b.h < 32;
        if (!aCompact && !bCompact) continue;

        // Skip if one element contains the other (DOM ancestor/descendant relationship)
        if (els[a.elIndex].contains(els[b.elIndex]) || els[b.elIndex].contains(els[a.elIndex])) continue;

        // Skip inline text links in the same paragraph/parent block
        if (a.tag === 'a' && b.tag === 'a') {
          const aEl = els[a.elIndex];
          const bEl = els[b.elIndex];
          if (
            aEl.parentElement === bEl.parentElement ||
            aEl.closest('p, article, section, blockquote, li') === bEl.closest('p, article, section, blockquote, li')
          ) {
            if (a.isInlineLink || b.isInlineLink) continue;
          }
        }

        const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        if (xOverlap > 0 && yOverlap > 0) continue; // collision/overlap handled by reflow

        const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
        const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
        const dist = yOverlap > 0 ? dx : xOverlap > 0 ? dy : Math.sqrt(dx * dx + dy * dy);

        // Flag touch targets that almost touch (< 4px)
        if (dist > 0 && dist < 4) {
          found.push({
            selector: a.selector,
            otherSelector: b.selector,
            distancePx: Math.round(dist),
            box: a,
            otherBox: b,
          });
        }
      }
    }

    return found;
  });

  return issues.map((iss) => ({
    route,
    kind: 'tight-target' as const,
    evidence: {
      selector: iss.selector,
      spacing: {
        distancePx: iss.distancePx,
        otherSelector: iss.otherSelector,
        box: iss.box,
        otherBox: iss.otherBox,
      },
    },
  }));
}
