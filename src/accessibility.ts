import type { Page } from 'playwright';
import type { RawFinding } from './types.js';
import { SNAPSHOT_SELECTOR } from './selectors.js';

type AccessibilityOptions = {
  viewport?: { width: number; height: number; label?: string };
};

/**
 * Deterministic accessibility and keyboard checks for the controls already visible in
 * the page. It deliberately uses the browser's own focus behavior and label relationships
 * so the result is evidence about the rendered page, not a model opinion.
 */
export async function auditPageAccessibility(
  page: Page,
  route: string,
  options: AccessibilityOptions = {},
): Promise<RawFinding[]> {
  const result = await page
    .evaluate((selector) => {
      const elements = Array.from(document.querySelectorAll(selector));
      const visible = (el: Element): boolean => {
        const h = el as HTMLElement;
        const rect = h.getBoundingClientRect();
        const style = window.getComputedStyle(h);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const text = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const labelledBy = (el: Element): string => {
        const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        return ids.map((id) => document.getElementById(id)).filter(Boolean).map((node) => text(node as Element)).join(' ').trim();
      };
      const associatedLabel = (el: Element): string => {
        const html = el as HTMLInputElement;
        if (html.id) {
          const label = document.querySelector(`label[for="${CSS.escape(html.id)}"]`);
          if (label) return text(label);
        }
        const parent = el.closest('label');
        return parent ? text(parent).replace(text(el), '').trim() : '';
      };
      const accessibleName = (el: Element): string => {
        const aria = el.getAttribute('aria-label')?.trim();
        if (aria) return aria;
        const labelled = labelledBy(el);
        if (labelled) return labelled;
        const label = associatedLabel(el);
        if (label) return label;
        const title = el.getAttribute('title')?.trim();
        if (title) return title;
        return text(el);
      };
      const disabled = (el: Element): boolean =>
        el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
      const selectorFor = (el: Element, index: number): string => {
        const id = el.getAttribute('id');
        return id ? `${el.tagName.toLowerCase()}#${id}` : `${el.tagName.toLowerCase()}:nth(${index})`;
      };

      const findings: {
        kind: 'missing-accessible-name' | 'keyboard-inaccessible' | 'missing-image-alt';
        selector: string;
        accessibleName?: string;
        role?: string;
        tabIndex?: number;
        focusable?: boolean;
        alt?: string;
      }[] = [];
      const previous = document.activeElement as HTMLElement | null;

      elements.forEach((el, index) => {
        if (!visible(el) || disabled(el)) return;
        const name = accessibleName(el);
        const selectorText = selectorFor(el, index);
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const tabIndex = (el as HTMLElement).tabIndex;
        let focusable = false;
        try {
          (el as HTMLElement).focus({ preventScroll: true });
          focusable = document.activeElement === el;
        } catch {
          focusable = false;
        }
        if (!name) {
          findings.push({
            kind: 'missing-accessible-name',
            selector: selectorText,
            role,
            tabIndex,
            focusable,
            accessibleName: name,
          });
        }
        if (!focusable) {
          findings.push({ kind: 'keyboard-inaccessible', selector: selectorText, role, tabIndex, focusable, accessibleName: name });
        }
      });

      Array.from(document.images).forEach((image, index) => {
        if (!visible(image) || image.hasAttribute('aria-hidden')) return;
        if (!image.hasAttribute('alt')) {
          findings.push({
            kind: 'missing-image-alt',
            selector: selectorFor(image, index),
            alt: undefined,
          });
        }
      });

      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur();
      return findings;
    }, SNAPSHOT_SELECTOR)
    .catch(() => []);

  return result.map((item) => ({
    route,
    kind: item.kind,
    evidence: {
      selector: item.selector,
      accessibleName: item.accessibleName,
      viewport: options.viewport,
      accessibility: {
        role: item.role,
        accessibleName: item.accessibleName,
        tabIndex: item.tabIndex,
        focusable: item.focusable,
        alt: item.alt,
      },
    },
  }));
}
