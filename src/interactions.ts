import type { Page, Route, Locator } from 'playwright';
import type { Control, Signals, RawFinding } from './types.js';
import type { ResolvedConfig } from './config.js';
import { classifyChange, MUTATION_FLOOR } from './changeDetect.js';
import { findRedundant } from './redundancy.js';
import { relocateControl } from './snapshot.js';
import { SELECTOR } from './selectors.js';

export { SELECTOR };

const DESTRUCTIVE_RE = /\b(delete|remove|destroy|sign\s?out|log\s?out|pay|charge|purchase|deactivate|cancel account)\b/i;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Pure: does this accessible name look destructive? Shared with observe merge. */
export function isDestructiveLabel(name: string): boolean {
  return DESTRUCTIVE_RE.test(name);
}

/**
 * Resolve a control to a Playwright locator. Observed controls use `locator.css`;
 * selector-sourced controls keep the classic `SELECTOR.nth(index)` key.
 * Returns null when an explicit css locator no longer matches (stale — caller may relocate).
 */
export async function resolveControl(page: Page, c: Control): Promise<Locator | null> {
  if (c.locator?.css) {
    try {
      const loc = page.locator(c.locator.css);
      if ((await loc.count()) > 0) return loc.first();
    } catch {
      return null;
    }
    return null;
  }
  if (c.index >= 0) return page.locator(SELECTOR).nth(c.index);
  return null;
}

/** Enumerate controls in DOM order. `navTarget` is set only for REAL navigations. */
export async function enumerateControls(page: Page): Promise<Control[]> {
  // NOTE: keep this callback free of NAMED inner functions. tsx/esbuild rewrites named
  // functions to reference a `__name` helper that does not exist in Playwright's isolated
  // world, which makes the whole $$eval throw. Inline everything with anonymous arrows.
  const raw = await page.$$eval(SELECTOR, (els) => {
    const here = new URL(document.baseURI);
    return els.map((el, index) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || undefined;
      const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';

      const aria = el.getAttribute('aria-label');
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const title = el.getAttribute('title') || '';
      const accessibleName = (aria && aria.trim() ? aria.trim() : text || title).slice(0, 80);

      let navTarget: string | undefined;
      if (tag === 'a') {
        const href = el.getAttribute('href') || '';
        if (href && !href.toLowerCase().startsWith('javascript:')) {
          try {
            const u = new URL(href, document.baseURI);
            // "real" = leaves this exact page (different origin/path, or carries a query).
            if (u.origin !== here.origin || u.pathname !== here.pathname || !!u.search) navTarget = u.href;
          } catch {
            /* ignore unparseable href */
          }
        }
      }

      let formAction: string | undefined;
      if (tag === 'input' || tag === 'button') {
        const form = el.closest('form');
        if (form) {
          try {
            formAction = new URL(form.getAttribute('action') || '', document.baseURI).href;
          } catch {
            /* ignore */
          }
        }
      }

      return { index, tag, role, accessibleName, disabled, visible, navTarget, formAction, destructive: false };
    });
  });
  for (const c of raw) c.destructive = isDestructiveLabel(c.accessibleName);
  return raw as Control[];
}

/** How long the page must stay silent before a click counts as having done nothing. */
const QUIET_MS = 250;
/** Minimum observation before a silent click may be called a no-op. */
const OBSERVE_FLOOR_MS = 300;
/** Poll interval of the settle loop. */
const POLL_MS = 40;

/**
 * Wait only as long as this click's verdict needs.
 *
 * `classifyChange` makes ACTED a positive signal, so the first navigation, dialog,
 * popup, network request or real DOM mutation ends the window — no later event can
 * overturn it. A click that produces nothing still gets a genuine observation window,
 * but that window closes `QUIET_MS` after the page falls silent instead of always
 * burning the full `interactionTimeoutMs`. That setting is now the cap, not the floor:
 * the sweep used to sleep 1500ms per control whether or not anything had happened,
 * which was ~87% of a full crawl's wall clock.
 *
 * The residual risk is a delayed signal landing after the window; the classifier's
 * stated bias covers it — that degrades to a taste question, never a false defect.
 */
async function observeClick(
  page: Page,
  cfg: ResolvedConfig,
  urlBefore: string,
  readCounters: () => { networkRequests: number; dialogOpened: boolean; popupOpened: boolean },
): Promise<void> {
  const cap = cfg.interactionTimeoutMs;
  const floor = Math.min(OBSERVE_FLOOR_MS, cap);
  const started = Date.now();
  let lastSignalAt = started;
  let lastNetwork = 0;
  let lastMutations = 0;

  for (;;) {
    const silentFor = Date.now() - lastSignalAt;
    const elapsed = Date.now() - started;
    const counters = readCounters();

    let mutations = 0;
    try {
      mutations = await page.evaluate(() => {
        const w = window as unknown as { __uicrawl?: { mutations: number } };
        return w.__uicrawl?.mutations ?? 0;
      });
    } catch {
      return; // page went away; the caller's URL check classifies it
    }

    let urlChanged = false;
    try {
      urlChanged = page.url() !== urlBefore;
    } catch {
      /* keep */
    }

    if (
      urlChanged ||
      counters.dialogOpened ||
      counters.popupOpened ||
      counters.networkRequests > 0 ||
      mutations >= MUTATION_FLOOR
    ) {
      return;
    }

    if (counters.networkRequests !== lastNetwork || mutations !== lastMutations) {
      lastNetwork = counters.networkRequests;
      lastMutations = mutations;
      lastSignalAt = Date.now();
      continue;
    }

    if (elapsed >= cap) return;
    if (elapsed >= floor && silentFor >= QUIET_MS) return;
    await page.waitForTimeout(POLL_MS);
  }
}

/**
 * Probe one control. `reload` re-navigates first to guarantee clean state.
 *
 * Re-navigation is the most expensive part of a probe on a DB-backed target, and it is
 * only needed when the previous click could have left state behind. The caller passes
 * `reload: false` after a provably silent click, which left the document as it found it.
 */
async function probeControl(
  page: Page,
  url: string,
  c: Control,
  cfg: ResolvedConfig,
  reload = true,
  beforeNav?: () => Promise<void> | void,
): Promise<Signals> {
  if (reload) {
    if (beforeNav) await beforeNav();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs }).catch(() => {});
    await page.waitForTimeout(150);
  }
  const urlBefore = page.url();

  let networkRequests = 0;
  let newConsoleMessages = 0;
  let consoleErrors = 0;
  let dialogOpened = false;
  let popupOpened = false;

  const onRequest = () => {
    networkRequests++;
  };
  const onConsole = (msg: { type(): string }) => {
    newConsoleMessages++;
    if (msg.type() === 'error') consoleErrors++;
  };
  const onPageError = () => {
    // An uncaught exception thrown by a click handler surfaces here, not on 'console'.
    newConsoleMessages++;
    consoleErrors++;
  };
  const onDialog = (d: { dismiss(): Promise<void> }) => {
    dialogOpened = true;
    void d.dismiss().catch(() => {});
  };
  const onPopup = (p: { close(): Promise<void> }) => {
    popupOpened = true;
    void p.close().catch(() => {});
  };

  page.on('request', onRequest);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('dialog', onDialog);
  page.context().on('page', onPopup);

  // Destructive controls: abort mutating requests so the click can't change the dev DB.
  // The request event still fires first, so intent is still counted as ACTED.
  const destructiveHandler = (route: Route) => {
    if (MUTATING_METHODS.has(route.request().method().toUpperCase())) {
      void route.abort('blockedbyclient');
      return;
    }
    void route.continue();
  };

  let navigated = false;
  let urlChanged = false;
  let domMutationCount = 0;
  let clickThrew = false;

  try {
    if (c.destructive) await page.route('**/*', destructiveHandler).catch(() => {});

    // Count real DOM change: childList always, but only SEMANTIC attribute toggles
    // (filters focus-ring / hover class flips that aren't a user-visible action).
    await page
      .evaluate(() => {
        const w = window as unknown as { __uicrawl?: { mutations: number; obs?: MutationObserver } };
        w.__uicrawl = { mutations: 0 };
        const SEMANTIC = new Set([
          'aria-expanded',
          'aria-pressed',
          'aria-selected',
          'aria-checked',
          'aria-hidden',
          'hidden',
          'open',
          'disabled',
          'aria-disabled',
          'data-state',
          'data-active',
          'data-selected',
          'data-theme',
        ]);
        const obs = new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.type === 'childList') w.__uicrawl!.mutations += m.addedNodes.length + m.removedNodes.length;
            else if (m.type === 'attributes' && m.attributeName && SEMANTIC.has(m.attributeName)) w.__uicrawl!.mutations += 1;
          }
        });
        obs.observe(document.body, { subtree: true, childList: true, attributes: true });
        w.__uicrawl.obs = obs;
      })
      .catch(() => {});

    const clickTimeout = Math.min(2500, cfg.navTimeoutMs);
    let clicked = false;
    try {
      const loc = await resolveControl(page, c);
      if (loc) {
        await loc.click({ timeout: clickTimeout });
        clicked = true;
      }
    } catch {
      clicked = false;
    }
    if (!clicked) {
      // Stale-selector self-heal: one unique re-locate by tag+name, then one retry.
      const healed = await relocateControl(page, c.tag, c.accessibleName).catch(() => null);
      if (healed && healed.css !== c.locator?.css) {
        c.locator = healed;
        try {
          const loc = await resolveControl(page, c);
          if (loc) {
            await loc.click({ timeout: clickTimeout });
            clicked = true;
          }
        } catch {
          clicked = false;
        }
      }
    }
    if (!clicked) clickThrew = true;

    await observeClick(page, cfg, urlBefore, () => ({ networkRequests, dialogOpened, popupOpened }));

    let urlAfter = urlBefore;
    try {
      urlAfter = page.url();
    } catch {
      /* keep */
    }
    urlChanged = urlAfter !== urlBefore;
    try {
      navigated = urlChanged && new URL(urlAfter).pathname !== new URL(urlBefore).pathname;
    } catch {
      navigated = urlChanged;
    }

    try {
      domMutationCount = await page.evaluate(() => {
        const w = window as unknown as { __uicrawl?: { mutations: number; obs?: MutationObserver } };
        if (w.__uicrawl?.obs) {
          w.__uicrawl.obs.disconnect();
        }
        return w.__uicrawl?.mutations ?? 0;
      });
    } catch {
      domMutationCount = 0; // navigated away — handled by navigated flag
    }
  } finally {
    page.off('request', onRequest);
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('dialog', onDialog);
    page.context().off('page', onPopup);
    if (c.destructive) await page.unroute('**/*', destructiveHandler).catch(() => {});
  }

  return {
    navigated,
    urlChanged,
    domMutated: domMutationCount > 0,
    domMutationCount,
    networkRequests,
    newConsoleMessages,
    consoleErrors,
    dialogOpened,
    popupOpened,
    clickThrew,
  };
}

function describe(c: Control): string {
  return `${c.tag}:nth(${c.index})${c.accessibleName ? ` "${c.accessibleName}"` : ''}`;
}

function pick(c: Control): RawFinding['control'] {
  return { accessibleName: c.accessibleName, tag: c.tag, navTarget: c.navTarget, formAction: c.formAction };
}

/** Map a single probe to a raw finding (or null when the control acted). */
export function rawFromVerdict(route: string, c: Control, signals: Signals): RawFinding | null {
  const verdict = classifyChange(signals);
  if (verdict === 'ACTED') return null;
  if (verdict === 'INCONCLUSIVE') {
    return { route, kind: 'stale-selector', control: pick(c), evidence: { accessibleName: c.accessibleName, selector: describe(c), signals } };
  }
  // NOOP — the discriminating cases:
  if (signals.consoleErrors > 0) {
    return { route, kind: 'button-threw', control: pick(c), evidence: { accessibleName: c.accessibleName, selector: describe(c), signals } };
  }
  // A real LINK that went nowhere is clearly broken -> defect.
  if (c.navTarget) {
    return {
      route,
      kind: 'broken-link',
      control: pick(c),
      evidence: { accessibleName: c.accessibleName, selector: describe(c), url: c.navTarget, signals },
    };
  }
  // A form SUBMIT that did nothing is most often waiting on input — native validation blocks
  // an empty submit silently (no nav/network/DOM). That's not positive evidence of brokenness,
  // so it's a taste question ("dead, or needs prior input?"), never a verified defect.
  return { route, kind: 'maybe-contextual-button', ambiguous: true, control: pick(c), evidence: { accessibleName: c.accessibleName, selector: describe(c), signals } };
}

export interface SweepResult {
  findings: RawFinding[];
  /** Controls actually click-probed. */
  probed: number;
  /** Eligible controls left unprobed because `maxProbesPerPage` was reached. */
  skipped: number;
}

/**
 * Full sweep for one page: probe visible/enabled controls up to `maxProbesPerPage`, plus
 * redundancy. `skipped` is returned rather than swallowed so the report can say what was
 * not tested — a silent cap reads as "everything passed".
 */
export async function sweepControls(
  page: Page,
  route: string,
  url: string,
  controls: Control[],
  cfg: ResolvedConfig,
  beforeNav?: () => Promise<void> | void,
): Promise<SweepResult> {
  const findings: RawFinding[] = [];
  const eligible = controls.filter((c) => !c.disabled && c.visible);
  const toProbe = eligible.slice(0, cfg.maxProbesPerPage);

  // The page is freshly loaded for this route, so the first probe needs no reload. After
  // that, reload only when the last click was not provably silent.
  let clean = true;
  for (const c of toProbe) {
    const signals = await probeControl(page, url, c, cfg, !clean, beforeNav);
    clean =
      signals.networkRequests === 0 &&
      signals.newConsoleMessages === 0 &&
      !signals.domMutated &&
      !signals.navigated &&
      !signals.urlChanged &&
      !signals.dialogOpened &&
      !signals.popupOpened &&
      !signals.clickThrew;
    const raw = rawFromVerdict(route, c, signals);
    if (raw) findings.push(raw);
  }
  for (const group of findRedundant(controls)) {
    const first = group.controls[0];
    findings.push({
      route,
      kind: 'redundant-control',
      control: pick(first),
      evidence: {
        accessibleName: first.accessibleName,
        url: group.destination,
        selector: group.controls.map(describe).join(' , '),
      },
    });
  }
  return { findings, probed: toProbe.length, skipped: eligible.length - toProbe.length };
}
