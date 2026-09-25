import type { Page } from 'playwright';
import type { RawFinding } from './types.js';

type StateOptions = {
  viewport?: { width: number; height: number; label?: string };
};

/**
 * Check the static contracts that make menus, tabs, forms, and dialogs understandable
 * to browsers and assistive technology. This pass does not click anything, so it is
 * safe to run against production-like pages.
 */
export async function auditPageStates(page: Page, route: string, options: StateOptions = {}): Promise<RawFinding[]> {
  const result = await page
    .evaluate(() => {
      const visible = (el: Element): boolean => {
        const h = el as HTMLElement;
        const rect = h.getBoundingClientRect();
        const style = window.getComputedStyle(h);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const text = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const selectorFor = (el: Element, index: number): string => {
        const id = el.getAttribute('id');
        return id ? `${el.tagName.toLowerCase()}#${id}` : `${el.tagName.toLowerCase()}:nth(${index})`;
      };
      const name = (el: Element): string => {
        const aria = el.getAttribute('aria-label')?.trim();
        if (aria) return aria;
        const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        const labelled = ids.map((id) => document.getElementById(id)).filter(Boolean).map((node) => text(node as Element)).join(' ').trim();
        return labelled;
      };
      const findings: {
        kind: 'invalid-aria-reference' | 'invalid-aria-state' | 'dialog-missing-label';
        selector: string;
        attribute?: string;
        value?: string;
        target?: string;
        role?: string;
        accessibleName?: string;
      }[] = [];

      const all = Array.from(document.querySelectorAll('*'));
      all.forEach((el, index) => {
        if (!visible(el)) return;
        const selector = selectorFor(el, index);
        for (const attribute of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns']) {
          const refs = (el.getAttribute(attribute) || '').split(/\s+/).filter(Boolean);
          for (const target of refs) {
            if (!document.getElementById(target)) {
              findings.push({ kind: 'invalid-aria-reference', selector, attribute, target, role: el.getAttribute('role') || el.tagName.toLowerCase() });
            }
          }
        }

        for (const attribute of ['aria-expanded', 'aria-pressed', 'aria-selected', 'aria-checked']) {
          const value = el.getAttribute(attribute);
          if (value === null) continue;
          const allowed = attribute === 'aria-checked' ? ['true', 'false', 'mixed'] : ['true', 'false'];
          if (!allowed.includes(value.toLowerCase())) {
            findings.push({ kind: 'invalid-aria-state', selector, attribute, value, role: el.getAttribute('role') || el.tagName.toLowerCase() });
          }
        }

        const role = el.getAttribute('role');
        if ((role === 'dialog' || role === 'alertdialog') && !name(el)) {
          findings.push({ kind: 'dialog-missing-label', selector, role, accessibleName: '' });
        }
      });
      return findings;
    })
    .catch(() => []);

  return result.map((item) => ({
    route,
    kind: item.kind,
    evidence: {
      selector: item.selector,
      viewport: options.viewport,
      accessibleName: item.accessibleName,
      accessibility: {
        role: item.role,
        attribute: item.attribute,
        value: item.value,
        target: item.target,
        accessibleName: item.accessibleName,
      },
    },
  }));
}
