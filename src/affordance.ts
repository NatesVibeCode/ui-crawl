import type { Page } from 'playwright';
import type { Control, RawFinding } from './types.js';
import { SELECTOR } from './interactions.js';

export interface AffordanceCheck {
  hadPointer: boolean;
  hadHoverChange: boolean;
  hadFocusChange: boolean;
  hadActiveChange?: boolean;
  hoverChanges?: string[];
  activeChanges?: string[];
  focusChanges?: string[];
  checkedStyles: string[];
}

const CSS_PROPS = [
  'cursor',
  'background-color',
  'color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'outline-style',
  'outline-width',
  'transform',
  'box-shadow',
  'opacity',
  'text-decoration-line',
] as const;

/** Probe visual affordances (cursor, :hover styles, :active styles, :focus styles) of interactive controls. */
export async function auditPageAffordance(
  page: Page,
  route: string,
  controls: Control[],
): Promise<RawFinding[]> {
  const findings: RawFinding[] = [];
  const activeControls = controls.filter((c) => !c.disabled && c.visible);
  if (!activeControls.length) return findings;

  // Try high-fidelity CDP pseudo-state audit first (Chromium Blink engine)
  let cdpResults: Map<number, AffordanceCheck> | null = null;
  try {
    cdpResults = await auditViaCDP(page, activeControls);
  } catch {
    cdpResults = null;
  }

  // Fallback to in-page stylesheet & event analysis if CDP is unavailable
  const results = cdpResults ?? (await auditViaInPage(page, activeControls));

  for (const c of activeControls) {
    const check = results.get(c.index);
    if (!check) continue;

    // Flag button controls lacking all visual feedback (no pointer cursor, no hover, no active, no focus)
    if (
      !check.hadPointer &&
      !check.hadHoverChange &&
      !check.hadFocusChange &&
      !check.hadActiveChange &&
      c.tag === 'button'
    ) {
      findings.push({
        route,
        kind: 'missing-affordance',
        control: {
          accessibleName: c.accessibleName,
          tag: c.tag,
          navTarget: c.navTarget,
          formAction: c.formAction,
        },
        evidence: {
          selector: `${c.tag}:nth(${c.index})${c.accessibleName ? ` "${c.accessibleName}"` : ''}`,
          accessibleName: c.accessibleName,
          affordance: check,
        },
      });
    }
  }

  return findings;
}

async function auditViaCDP(page: Page, controls: Control[]): Promise<Map<number, AffordanceCheck>> {
  const cdp = await page.context().newCDPSession(page);
  const out = new Map<number, AffordanceCheck>();

  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const doc = await cdp.send('DOM.getDocument');
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: SELECTOR });

    const getStyles = async (nodeId: number): Promise<Record<string, string>> => {
      const res = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
      const map: Record<string, string> = {};
      for (const item of res.computedStyle) {
        if ((CSS_PROPS as readonly string[]).includes(item.name)) {
          map[item.name] = item.value;
        }
      }
      return map;
    };

    // Audit up to first 40 active controls for ultra-fast response
    const toProbe = controls.slice(0, 40);
    for (const c of toProbe) {
      const nodeId = nodeIds[c.index];
      if (!nodeId) continue;

      const base = await getStyles(nodeId);
      const hadPointer = base.cursor === 'pointer';

      // Hover
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      const hover = await getStyles(nodeId);

      // Active
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
      const active = await getStyles(nodeId);

      // Focus
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
      const focus = await getStyles(nodeId);

      // Clear
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });

      const hoverDiff = Object.keys(hover)
        .filter((k) => k !== 'cursor' && hover[k] !== base[k])
        .map((k) => `${k}: ${base[k]} -> ${hover[k]}`);
      const activeDiff = Object.keys(active)
        .filter((k) => k !== 'cursor' && active[k] !== base[k])
        .map((k) => `${k}: ${base[k]} -> ${active[k]}`);
      const focusDiff = Object.keys(focus)
        .filter((k) => k !== 'cursor' && focus[k] !== base[k])
        .map((k) => `${k}: ${base[k]} -> ${focus[k]}`);

      out.set(c.index, {
        hadPointer,
        hadHoverChange: hoverDiff.length > 0,
        hadActiveChange: activeDiff.length > 0,
        hadFocusChange: focusDiff.length > 0,
        hoverChanges: hoverDiff,
        activeChanges: activeDiff,
        focusChanges: focusDiff,
        checkedStyles: [...CSS_PROPS],
      });
    }
  } finally {
    await cdp.detach().catch(() => {});
  }

  return out;
}

async function auditViaInPage(page: Page, controls: Control[]): Promise<Map<number, AffordanceCheck>> {
  const indices = controls.map((c) => c.index);
  const evalResult = await page
    .evaluate(
      ([selector, targetIndices]) => {
        const els = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
        const hoverSelectors: string[] = [];
        const activeSelectors: string[] = [];

        // Collect hover & active rules from all readable stylesheets
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules)) {
              if (rule instanceof CSSStyleRule && rule.selectorText) {
                if (rule.selectorText.includes(':hover')) {
                  hoverSelectors.push(rule.selectorText);
                }
                if (rule.selectorText.includes(':active')) {
                  activeSelectors.push(rule.selectorText);
                }
              }
            }
          } catch {
            /* cross-origin sheet SecurityError */
          }
        }

        const out: Array<{
          index: number;
          hadPointer: boolean;
          hadHoverChange: boolean;
          hadActiveChange: boolean;
          hadFocusChange: boolean;
        }> = [];

        for (const idx of targetIndices) {
          const el = els[idx];
          if (!el) continue;

          const base = window.getComputedStyle(el);
          const hadPointer = base.cursor === 'pointer';

          // Match hover rules
          let hadHover = false;
          for (const sel of hoverSelectors) {
            try {
              const stripped = sel.replace(/:hover/g, '');
              if (el.matches(stripped) || el.closest(stripped)) {
                hadHover = true;
                break;
              }
            } catch {
              /* ignore invalid selector */
            }
          }

          // Match active rules
          let hadActive = false;
          for (const sel of activeSelectors) {
            try {
              const stripped = sel.replace(/:active/g, '');
              if (el.matches(stripped) || el.closest(stripped)) {
                hadActive = true;
                break;
              }
            } catch {
              /* ignore */
            }
          }

          // Check focus
          const baseOutline = base.outline;
          const baseBoxShadow = base.boxShadow;
          el.focus();
          const focusStyle = window.getComputedStyle(el);
          const hadFocusChange =
            focusStyle.outline !== baseOutline ||
            focusStyle.boxShadow !== baseBoxShadow ||
            focusStyle.borderColor !== base.borderColor;
          el.blur();

          out.push({
            index: idx,
            hadPointer,
            hadHoverChange: hadHover,
            hadActiveChange: hadActive,
            hadFocusChange,
          });
        }

        return out;
      },
      [SELECTOR, indices] as const,
    )
    .catch(() => []);

  const map = new Map<number, AffordanceCheck>();
  for (const item of evalResult) {
    map.set(item.index, {
      hadPointer: item.hadPointer,
      hadHoverChange: item.hadHoverChange,
      hadActiveChange: item.hadActiveChange,
      hadFocusChange: item.hadFocusChange,
      checkedStyles: [...CSS_PROPS],
    });
  }
  return map;
}
