import type { Box } from './types.js';

/**
 * Pure zoom-reflow heuristic. Given structural element boxes measured at a zoom level,
 * flag horizontal overflow (CLIP) and sibling collisions (OVERLAP). Parent/child
 * containment is ignored — only peer elements colliding counts.
 */

export interface ReflowInput {
  viewport: { w: number; h: number };
  boxes: Box[];
  zoom: number;
}

export interface ReflowIssue {
  kind: 'zoom-clip' | 'zoom-overlap';
  selector: string;
  otherSelector?: string;
  overflowPx?: number;
  overlapFrac?: number;
  /** Near-threshold overlap — eligible for vision escalation; stays taste under Noop. */
  ambiguous: boolean;
}

const EPS = 2;
const OVERLAP_DEFECT = 0.25; // >= this fraction of the smaller box => clear collision
const OVERLAP_AMBIGUOUS = 0.08; // [ambiguous, defect) => escalate to vision

function area(b: Box): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  );
}

function intersectionArea(a: Box, b: Box): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || btm <= y) return 0;
  return (r - x) * (btm - y);
}

export function detectReflow(input: ReflowInput): ReflowIssue[] {
  const issues: ReflowIssue[] = [];
  const { boxes, viewport } = input;

  // CLIP: horizontal overflow past the viewport (vertical scroll is normal; horizontal is not).
  for (const b of boxes) {
    if (b.w <= 0 || b.h <= 0) continue;
    const rightOverflow = b.x + b.w - viewport.w;
    if (rightOverflow > EPS) {
      issues.push({ kind: 'zoom-clip', selector: b.selector, overflowPx: Math.round(rightOverflow), ambiguous: false });
    } else if (b.x < -EPS) {
      issues.push({ kind: 'zoom-clip', selector: b.selector, overflowPx: Math.round(-b.x), ambiguous: false });
    }
  }

  // OVERLAP: peer boxes intersecting beyond a fraction of the smaller one.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (area(a) <= 0 || area(b) <= 0) continue;
      if (contains(a, b) || contains(b, a)) continue; // nesting, not a collision
      const inter = intersectionArea(a, b);
      if (inter <= 0) continue;
      const frac = inter / Math.min(area(a), area(b));
      if (frac >= OVERLAP_AMBIGUOUS) {
        issues.push({
          kind: 'zoom-overlap',
          selector: a.selector,
          otherSelector: b.selector,
          overlapFrac: Math.round(frac * 100) / 100,
          ambiguous: frac < OVERLAP_DEFECT,
        });
      }
    }
  }

  return issues;
}
