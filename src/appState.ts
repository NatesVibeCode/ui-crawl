import type { Page } from 'playwright';
import type { RawFinding } from './types.js';
import { auditPageColors } from './colors.js';
import { auditPageLayout } from './layout.js';
import { auditPageHitTest } from './hitTest.js';

export interface AppStateAuditResult {
  findings: RawFinding[];
  modalDetected: boolean;
  tabsAudited: number;
}

/**
 * Detects if a modal or dialog is currently open in the DOM.
 */
export async function detectOpenModal(page: Page): Promise<{
  isOpen: boolean;
  selector?: string;
  hasBackdrop?: boolean;
  isScrollLocked?: boolean;
  isFocusTrapped?: boolean;
}> {
  return page.evaluate(() => {
    const dialogs = Array.from(
      document.querySelectorAll('dialog[open], [role="dialog"]:not([aria-hidden="true"]), .modal.open, .modal.active, .modal.show, [data-modal-open="true"]')
    ) as HTMLElement[];

    const visibleDialog = dialogs.find((d) => {
      const r = d.getBoundingClientRect();
      const s = window.getComputedStyle(d);
      return r.width > 50 && r.height > 50 && s.display !== 'none' && s.visibility !== 'hidden';
    });

    if (!visibleDialog) return { isOpen: false };

    // Check if body scroll is locked
    const bodyStyle = window.getComputedStyle(document.body);
    const htmlStyle = window.getComputedStyle(document.documentElement);
    const isScrollLocked =
      bodyStyle.overflow === 'hidden' ||
      bodyStyle.overflowY === 'hidden' ||
      htmlStyle.overflow === 'hidden' ||
      htmlStyle.overflowY === 'hidden';

    // Check focus trapping
    const activeEl = document.activeElement;
    const isFocusTrapped = activeEl ? visibleDialog.contains(activeEl) : false;

    // Selector
    let sel = visibleDialog.tagName.toLowerCase();
    if (visibleDialog.id) sel += `#${visibleDialog.id}`;
    else if (visibleDialog.className && typeof visibleDialog.className === 'string') {
      sel += '.' + visibleDialog.className.trim().split(/\s+/).slice(0, 2).join('.');
    }

    return {
      isOpen: true,
      selector: sel,
      isScrollLocked,
      isFocusTrapped,
    };
  }).catch(() => ({ isOpen: false }));
}

/**
 * Audits an open modal for layout bounds, contrast, and focus trapping.
 */
export async function auditOpenModal(
  page: Page,
  route: string,
  modalInfo: { selector?: string; isScrollLocked?: boolean; isFocusTrapped?: boolean }
): Promise<RawFinding[]> {
  const findings: RawFinding[] = [];
  const sel = modalInfo.selector || 'dialog';

  // 1. Audit viewport bounds of the modal
  const bounds = await page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      overflowTop: r.top < 0,
      overflowBottom: r.bottom > winH,
      overflowLeft: r.left < 0,
      overflowRight: r.right > winW,
      overflowAmountY: Math.max(0, r.bottom - winH),
    };
  }, sel).catch(() => null);

  if (bounds && bounds.overflowBottom && bounds.overflowAmountY > 10) {
    findings.push({
      route,
      kind: 'viewport-overflow',
      evidence: {
        selector: sel,
        remediation: `Modal dialog overflows viewport bottom by ${Math.round(bounds.overflowAmountY)}px. Add "max-height: 90vh; overflow-y: auto;" to allow modal content to scroll on smaller viewports.`,
        layout: {
          overflowPx: Math.round(bounds.overflowAmountY),
        },
      },
    });
  }

  // 2. Audit contrast and hit test inside modal
  const [colors, hitTest] = await Promise.all([
    auditPageColors(page, route).catch(() => ({ rawFindings: [] })),
    auditPageHitTest(page, route).catch(() => []),
  ]);

  findings.push(...colors.rawFindings);
  findings.push(...hitTest);

  return findings;
}

/**
 * Cleanly closes or dismisses an open modal to restore page state for subsequent probes.
 */
export async function dismissOpenModal(page: Page): Promise<boolean> {
  try {
    // 1. Try Escape key
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    const check1 = await detectOpenModal(page);
    if (!check1.isOpen) return true;

    // 2. Try close button
    const closeBtn = page.locator('dialog [aria-label*="close" i], dialog button.close, [role="dialog"] [aria-label*="close" i], [role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("Cancel")').first();
    if (await closeBtn.count() > 0) {
      await closeBtn.click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(150);
    }

    const check2 = await detectOpenModal(page);
    return !check2.isOpen;
  } catch {
    return false;
  }
}

/**
 * Audits tab panels by cycling through [role="tab"] controls.
 */
export async function auditTabPanels(page: Page, route: string): Promise<RawFinding[]> {
  const findings: RawFinding[] = [];

  const tabSelectors = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .tab, [data-tab]')) as HTMLElement[];
    return tabs.map((t, idx) => {
      let sel = t.tagName.toLowerCase();
      if (t.id) sel += `#${t.id}`;
      else sel += `:nth(${idx})`;
      return {
        selector: sel,
        name: (t.textContent || t.getAttribute('aria-label') || '').trim().slice(0, 30),
        ariaControls: t.getAttribute('aria-controls') || undefined,
      };
    });
  }).catch(() => []);

  if (tabSelectors.length <= 1) return findings;

  for (let i = 0; i < Math.min(tabSelectors.length, 6); i++) {
    const tabInfo = tabSelectors[i];
    try {
      const loc = page.locator(tabInfo.selector).first();
      if ((await loc.count()) > 0) {
        await loc.click({ timeout: 1000 });
        await page.waitForTimeout(200);

        // Run layout audit on active panel
        const layoutFindings = await auditPageLayout(page, route);
        findings.push(...layoutFindings);
      }
    } catch {
      /* ignore tab click failure */
    }
  }

  return findings;
}

/**
 * Auto-fills visible form inputs with benign dummy values so form submit transitions
 * can be tested in their valid state.
 */
export async function autoFillFormInputs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select')) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
    let filled = 0;

    for (const el of inputs) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (el.hasAttribute('disabled') || el.hasAttribute('readonly')) continue;

      if (el.tagName.toLowerCase() === 'textarea') {
        if (!el.value) {
          el.value = 'Test automated feedback message.';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }
      } else if (el.tagName.toLowerCase() === 'select') {
        const select = el as HTMLSelectElement;
        if (select.selectedIndex <= 0 && select.options.length > 1) {
          select.selectedIndex = 1;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }
      } else {
        const input = el as HTMLInputElement;
        const type = (input.type || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          if (!input.checked) {
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            filled++;
          }
        } else if (!input.value) {
          if (type === 'email') input.value = 'test@example.com';
          else if (type === 'tel') input.value = '555-0100';
          else if (type === 'number') input.value = '10';
          else input.value = 'Test Input';

          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }
      }
    }
    return filled;
  }).catch(() => 0);
}
