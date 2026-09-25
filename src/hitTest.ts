import type { Page } from 'playwright';
import type { RawFinding, Box } from './types.js';
import { SELECTOR } from './selectors.js';

export interface HitTestOptions {
  viewport?: { width: number; height: number; label?: string };
  containerSelector?: string;
}

export function isTouchTargetSmall(w: number, h: number, min = 23.5): boolean {
  return w < min || h < min;
}

export function isHitOccluded(el: Element, hit: Element | null): boolean {
  if (!hit) return true;
  return hit !== el && !el.contains(hit) && !hit.contains(el);
}

interface RawHitTestResult {
  kind: 'pointer-intercepted' | 'small-touch-target';
  selector: string;
  interceptedBy?: string;
  bounds: Box;
  targetSize: { width: number; height: number };
  remediation: string;
}

/**
 * Deterministic pointer physics and hit-testing pass:
 * 1. Checks if document.elementFromPoint(center) reaches the control or is intercepted by an overlay.
 * 2. Checks if clickable elements satisfy WCAG 24x24px touch target minimums.
 */
export async function auditPageHitTest(
  page: Page,
  route: string,
  options: HitTestOptions = {},
): Promise<RawFinding[]> {
  const rawResults = await page
    .evaluate(
      ({ selector, containerSelector }) => {
        const results: RawHitTestResult[] = [];
        const root = containerSelector ? document.querySelector(containerSelector) : document;
        if (!root) return [];
        const elements = Array.from(root.querySelectorAll(selector));

        const openModal = !containerSelector
          ? document.querySelector('dialog[open], [role="dialog"]:not([aria-hidden="true"])')
          : null;

        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity || '1') > 0.05
          );
        };

        const getSelector = (el: Element): string => {
          if (el.id) return `#${el.id}`;
          const tid = el.getAttribute('data-testid');
          if (tid) return `[data-testid="${tid}"]`;
          const tag = el.tagName.toLowerCase();
          const parent = el.parentElement;
          if (!parent) return tag;
          let nth = 1;
          let sib = el.previousElementSibling;
          while (sib) {
            if (sib.tagName === el.tagName) nth++;
            sib = sib.previousElementSibling;
          }
          return `${tag}:nth-of-type(${nth})`;
        };

        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          if (openModal && !openModal.contains(el)) continue;
          if (!isVisible(el)) continue;

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        // Skip if control itself declares pointer-events: none (it intentionally passes through)
        if (style.pointerEvents === 'none') continue;

        const sel = getSelector(el);
        const box: Box = {
          selector: sel,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };

        // 1. Touch target size check (WCAG 2.5.8 minimum: 24x24px)
        // Only check buttons and links
        const tag = el.tagName.toLowerCase();
        const isButtonOrLink = tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button';
        if (isButtonOrLink && (rect.width < 23.5 || rect.height < 23.5)) {
          results.push({
            kind: 'small-touch-target',
            selector: sel,
            bounds: box,
            targetSize: { width: Math.round(rect.width), height: Math.round(rect.height) },
            remediation: `Increase padding or minimum dimensions of "${sel}" to at least 24x24px for WCAG 2.5.8 compliance.`,
          });
        }

        // 2. Hit-testing: test center point
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        // Skip if center point is outside viewport
        if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) {
          continue;
        }

        const hit = document.elementFromPoint(cx, cy);
        if (hit) {
          const isDirectHit = hit === el || el.contains(hit) || hit.contains(el);
          if (!isDirectHit) {
            const hitSel = getSelector(hit);
            results.push({
              kind: 'pointer-intercepted',
              selector: sel,
              interceptedBy: hitSel,
              bounds: box,
              targetSize: { width: Math.round(rect.width), height: Math.round(rect.height) },
              remediation: `Element "${sel}" is occluded by "${hitSel}". Add "pointer-events: none;" to the overlay or adjust z-index.`,
            });
          }
        }
      }

      return results;
    }, { selector: SELECTOR, containerSelector: options.containerSelector })
    .catch(() => []);

  return rawResults.map((r) => ({
    route,
    kind: r.kind,
    evidence: {
      selector: r.selector,
      viewport: options.viewport,
      hitTest: {
        interceptedBy: r.interceptedBy,
        bounds: r.bounds,
        targetSize: r.targetSize,
      },
      remediation: r.remediation,
    },
  }));
}
