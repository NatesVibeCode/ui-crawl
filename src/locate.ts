import type { Page } from 'playwright';
import type { Box, SourceLocation } from './types.js';
import { SELECTOR, SNAPSHOT_SELECTOR } from './selectors.js';

/**
 * One resolver for the tool's own selector grammar.
 *
 * Detectors do not all emit plain CSS. `interactions.ts` writes `button:nth(3) "Save"`
 * (an index into the probe SELECTOR plus a disambiguating label), `redundancy.ts` joins
 * two of those with ` , `, and `zoom.ts` writes intersection selectors that name no single
 * element at all. Feeding those to `document.querySelector` throws, which is why source
 * grounding and evidence crops silently produced nothing for most finding types.
 *
 * `resolveEvidence` understands the grammar and returns, in ONE page round-trip, the
 * element's box (so a finding can carry a vision crop) and its framework source (so an
 * agent gets a `file:line` fix site). Anything unresolvable returns a partial result —
 * never a throw, never a guess.
 */

export interface SelectorCandidate {
  /** The addressable selector with any human label removed. */
  selector: string;
  /** The `"Save"` accessible-name label, when the detector supplied one. */
  label: string | null;
}

/** Split `"Save"` off the end of a detector selector. */
function splitLabel(selector: string): SelectorCandidate {
  const s = selector.trim();
  const quoted = /^(.*?)\s+"([^"]*)"$/.exec(s);
  return quoted
    ? { selector: quoted[1].trim(), label: quoted[2] }
    : { selector: s, label: null };
}

/**
 * Pure: split a possibly-composite selector into addressable candidates, in order.
 * `a:nth(7) "Account" , a:nth(8) "My Account"` yields both halves with labels separated,
 * and drops the `a ∩ b` intersection selectors that name no single element.
 */
export function selectorCandidates(selector: string): SelectorCandidate[] {
  return selector
    .split(' , ')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(splitLabel)
    .filter((c) => c.selector && !c.selector.includes(' ∩ '));
}

const POOL_KEY = '__uicrawlPools';

/**
 * Stage the element pools the resolver indexes, ONCE per document.
 *
 * The pools have to be pierced (Playwright's engine) to see inside shadow roots, but
 * pierced results cannot be handed to `page.evaluate` — element handles do not cross
 * that boundary. So they are parked on `window` here and read back in-page by
 * `resolveEvidence`. Guarded by a flag so a page pays for it once no matter how many
 * findings resolve against it, and idempotent so a re-prime after navigation is free.
 *
 * Safe to skip: the resolver falls back to native pools when the global is absent, so a
 * page that never sees a finding simply never primes.
 */
export async function primeDeepPools(page: Page): Promise<void> {
  try {
    const present = await page.evaluate((k) => !!(window as unknown as Record<string, unknown>)[k], POOL_KEY);
    if (present) return;
    // Each pool has its own selector, so they are staged one call each. Element handles
    // cannot cross into `page.evaluate`, hence the window hand-off.
    await page.locator(SELECTOR).evaluateAll((els, k: string) => {
      const w = window as unknown as Record<string, Record<string, unknown>>;
      w[k] = { ...(w[k] ?? {}), probe: els };
    }, POOL_KEY);
    await page.locator(SNAPSHOT_SELECTOR).evaluateAll((els, k: string) => {
      const w = window as unknown as Record<string, Record<string, unknown>>;
      w[k] = { ...(w[k] ?? {}), snapshot: els };
    }, POOL_KEY);
    await page.locator('*').evaluateAll((els, k: string) => {
      const w = window as unknown as Record<string, Record<string, unknown>>;
      w[k] = { ...(w[k] ?? {}), all: els };
    }, POOL_KEY);
    await page.locator('img').evaluateAll((els, k: string) => {
      const w = window as unknown as Record<string, Record<string, unknown>>;
      w[k] = { ...(w[k] ?? {}), images: els };
    }, POOL_KEY);

    // Install the extraction routine once, so the plain-CSS branch (which reaches the
    // element through a locator handle) and the `:nth(n)` branch (which finds it
    // in-page) can share one implementation instead of two that can drift.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__uicrawlExtract = (el: Element, sel: string) => {
        const rect = el.getBoundingClientRect();
        const anyEl = el as unknown as Record<string, unknown>;
        const primedSnap = (
          window as unknown as Record<string, Record<string, Element[]>>
        ).__uicrawlPools?.snapshot;
        const snapIndex = (primedSnap ?? Array.from(document.querySelectorAll('*'))).indexOf(el);

        const out: Record<string, unknown> = {};
        const attrFile = el.getAttribute('data-source-file') || el.getAttribute('data-file');
        const attrLine = el.getAttribute('data-source-line') || el.getAttribute('data-line');
        const attrComp = el.getAttribute('data-component') || el.getAttribute('data-testid');
        if (attrFile) {
          out.file = attrFile;
          const parsedLine = parseInt(attrLine ?? '', 10);
          if (!Number.isNaN(parsedLine)) out.line = parsedLine;
        }
        if (attrComp) out.component = attrComp;

        const fiberKey = Object.keys(anyEl).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
        );
        if (fiberKey) {
          let curr = anyEl[fiberKey] as Record<string, unknown> | null;
          while (curr) {
            const type = curr.type || curr.elementType;
            if (typeof type === 'function' || (type && typeof type === 'object')) {
              const comp =
                (type as { displayName?: string; name?: string }).displayName ||
                (type as { name?: string }).name;
              if (comp && !out.component) out.component = comp;
            }
            const dbg = curr._debugSource as
              | { fileName?: string; lineNumber?: number; columnNumber?: number }
              | undefined;
            if (dbg && !out.file) {
              out.file = dbg.fileName;
              out.line = dbg.lineNumber;
              out.column = dbg.columnNumber;
            }
            curr = curr.return as Record<string, unknown> | null;
          }
        }

        const vnode = (anyEl.__vnode || anyEl._vnode) as { type?: Record<string, unknown> } | undefined;
        if (vnode?.type) {
          if (!out.component) out.component = vnode.type.__name ?? vnode.type.name;
          if (!out.file) out.file = vnode.type.__file;
        }

        const svelte = anyEl.__svelte_meta as { loc?: { file?: string; line?: number } } | undefined;
        if (svelte?.loc && !out.file) {
          out.file = svelte.loc.file;
          out.line = svelte.loc.line;
        }

        return {
          box: { selector: sel, x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          source: out.file || out.component ? out : null,
          snapshotIndex: snapIndex,
        };
      };
    });
  } catch {
    /* a page that cannot be primed simply falls back to native pools */
  }
}

export interface EvidenceTarget {
  /** Viewport-relative box of the first resolvable candidate, in CSS px. */
  box?: Box;
  /** Framework source location for that same element. */
  source?: SourceLocation;
  /**
   * Position in the SNAPSHOT_SELECTOR match list — the badge a marked screenshot shows.
   * Computed in the same round-trip, on the same DOM, so it cannot drift from the box.
   */
  snapshotIndex?: number;
}

/**
 * Scroll the element a finding names into the middle of the viewport and return its
 * FRESH box. The box `resolveEvidence` returns is viewport-relative at measure time;
 * `page.screenshot({ clip })` only accepts coordinates inside the CURRENT viewport image,
 * so a carried box is unusable whenever the page has scrolled since — which is the normal
 * case, because the interaction sweep navigates and the reload-for-crops resets scroll to
 * zero. Re-measuring after an explicit scroll is what makes below-fold crops possible at
 * all; without it every below-fold finding silently gets no image.
 *
 * Returns null when nothing resolves, so the caller can fall back to pure scroll math on
 * a carried box or honestly report no image.
 */
export async function scrollTargetIntoView(page: Page, selector: string): Promise<Box | null> {
  for (const candidate of selectorCandidates(selector)) {
    const box = (await page
      .evaluate(
        (args: { sel: string; probe: string; snapshotProbe: string }) => {
          const nthForm = /^([a-zA-Z][\w-]*):nth\((\d+)\)$/.exec(args.sel);
          let el: Element | null = null;
          if (nthForm) {
            const wantTag = nthForm[1].toLowerCase();
            const n = parseInt(nthForm[2], 10);
            const pools = [
              Array.from(document.querySelectorAll(args.probe)),
              Array.from(document.querySelectorAll(args.snapshotProbe)),
              Array.from(document.querySelectorAll('*')),
              Array.from(document.images),
            ];
            for (const pool of pools) {
              const cand = pool[n];
              if (cand && cand.tagName.toLowerCase() === wantTag) {
                el = cand;
                break;
              }
            }
          } else {
            el = document.querySelector(args.sel);
          }
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          return { selector: args.sel, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        },
        { sel: candidate.selector, probe: SELECTOR, snapshotProbe: SNAPSHOT_SELECTOR },
      )
      .catch(() => null)) as Box | null;
    if (box) return box;
  }
  return null;
}
/**
 * Resolve the element a finding names, once, for both its crop and its source.
 * Returns whatever it can prove and nothing it cannot.
 */
export async function resolveEvidence(page: Page, selector: string): Promise<EvidenceTarget> {
  // The plain-CSS path goes through Playwright's selector engine so it can cross a shadow
  // boundary (`document.querySelector` cannot), and so its element ordering matches the
  // snapshot. The `:nth(n)` path below cannot use a locator directly, because the index
  // base depends on which detector emitted it, so it resolves in-page against the primed
  // pools. Both branches then extract through the same installed routine.
  await primeDeepPools(page);

  for (const candidate of selectorCandidates(selector)) {
    if (!/:nth\(\d+\)$/.test(candidate.selector)) {
      const resolved = (await page
        .locator(candidate.selector)
        .first()
        .evaluate(
          (el, args: { sel: string }) =>
            (
              window as unknown as {
                __uicrawlExtract: (e: Element, s: string) => unknown;
              }
            ).__uicrawlExtract(el, args.sel),
          { sel: candidate.selector },
        )
        .catch(() => null)) as { box: Box; source: SourceLocation | null; snapshotIndex: number } | null;
      if (!resolved) continue;
      return {
        box: resolved.box.w > 0 && resolved.box.h > 0 ? resolved.box : undefined,
        source: resolved.source ?? undefined,
        snapshotIndex: resolved.snapshotIndex >= 0 ? resolved.snapshotIndex : undefined,
      };
    }

    const resolved = (await page
      .evaluate(
        (args: { sel: string; name: string | null; probe: string; snapshotProbe: string }) => {
          const sel = args.sel;
          const name = args.name;
          const visible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = window.getComputedStyle(el);
            return style.visibility !== 'hidden' && style.display !== 'none';
          };
          const nameOf = (el: Element) => {
            const aria = (el.getAttribute('aria-label') || '').trim();
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            return (aria || text || el.getAttribute('title') || '').slice(0, 80);
          };

          const nthForm = /^([a-zA-Z][\w-]*):nth\((\d+)\)$/.exec(sel);
          let el: Element | null = null;

          if (nthForm) {
            const wantTag = nthForm[1].toLowerCase();
            const n = parseInt(nthForm[2], 10);

            // `tag:nth(n)` means "element n of some pool", NOT "the nth element with that
            // tag". Every producer agrees on that part; they disagree only on WHICH pool:
            // `interactions.ts` indexes the probe SELECTOR, `accessibility.ts` indexes
            // SNAPSHOT_SELECTOR (and document.images for alt checks), and `state.ts`
            // indexes `querySelectorAll('*')`. The tag is a readability hint, so index
            // first and verify the tag afterwards — filtering by tag before indexing
            // points at a different element than the detector meant.
            // Prefer the primed (pierced) pools; fall back to native ones when this page
            // was never primed, so behaviour is never worse than before shadow support.
            const primed = (window as unknown as Record<string, Record<string, Element[]>>)[
              '__uicrawlPools'
            ];
            const pools: Element[][] = [
              primed?.probe ?? Array.from(document.querySelectorAll(args.probe)),
              primed?.snapshot ?? Array.from(document.querySelectorAll(args.snapshotProbe)),
              primed?.all ?? Array.from(document.querySelectorAll('*')),
              primed?.images ?? Array.from(document.images),
            ];

            // A named control is the only disambiguator a caller gave us, so a pool entry
            // whose accessible name matches is the answer even at a different index.
            if (name) {
              el =
                pools
                  .flat()
                  .filter((c) => visible(c) && nameOf(c) === name)
                  .sort(
                    (a, b) =>
                      pools.findIndex((p) => p.includes(a)) - pools.findIndex((p) => p.includes(b)),
                  )[0] ?? null;
            }
            if (!el) {
              for (const pool of pools) {
                const cand = pool[n];
                if (cand && cand.tagName.toLowerCase() === wantTag && visible(cand)) {
                  el = cand;
                  break;
                }
              }
            }
          } else {
            el = document.querySelector(sel);
          }

          if (!el) return null;
          return (
            window as unknown as {
              __uicrawlExtract: (e: Element, s: string) => unknown;
            }
          ).__uicrawlExtract(el, sel);
        },
        {
          sel: candidate.selector,
          name: candidate.label,
          probe: SELECTOR,
          snapshotProbe: SNAPSHOT_SELECTOR,
        },
      )
      .catch(() => null)) as { box: Box; source: SourceLocation | null; snapshotIndex: number } | null;

    if (resolved) {
      return {
        box: resolved.box.w > 0 && resolved.box.h > 0 ? resolved.box : undefined,
        source: resolved.source ?? undefined,
        snapshotIndex: resolved.snapshotIndex >= 0 ? resolved.snapshotIndex : undefined,
      };
    }
    continue;
  }

  return {};
}
