import { chromium, type Page } from 'playwright';
import { SELECTOR, SNAPSHOT_SELECTOR } from './selectors.js';
import { serveStatic, type StaticServer } from './serve.js';

/**
 * Compact interactive-element record for model prompts and re-location.
 * `index` is the position in the page's SNAPSHOT_SELECTOR match list (stable within
 * one snapshot; gaps allowed after prioritization).
 */
export interface SnapshotEntry {
  index: number;
  tag: string;
  role?: string;
  name: string;
  disabled: boolean;
  visible: boolean;
  href?: string;
  /** Unique-enough CSS to re-find this element later. */
  css: string;
  /** True when the standard probe SELECTOR already matches this element. */
  inSelector: boolean;
}

/** Soft cap on entries transferred to Node / shown to a model. */
export const SNAPSHOT_CAP = 80;

/**
 * Pure: render one entry exactly as it appears in the numbered list, so full snapshots
 * and change deltas spell controls the same way and an index always means one thing.
 */
export function formatSnapshotEntry(e: SnapshotEntry): string {
  const parts = [`[${e.index}]`, e.tag];
  if (e.role) parts.push(`role=${e.role}`);
  if (e.name) parts.push(JSON.stringify(e.name));
  if (e.disabled) parts.push('disabled');
  if (!e.visible) parts.push('hidden');
  if (e.href) parts.push(`-> ${e.href}`);
  if (e.inSelector) parts.push('(covered)');
  return parts.join(' ');
}

/**
 * Pure: render entries as a token-cheap numbered list.
 * Prefer out-of-selector visible controls; keep a little covered context.
 */
export function formatSnapshot(entries: SnapshotEntry[], cap = SNAPSHOT_CAP): string {
  if (!entries.length) return '(no interactive elements)';
  const shown = entries.slice(0, cap);
  const lines = shown.map((e) => formatSnapshotEntry(e));
  if (entries.length > cap) lines.push(`… ${entries.length - cap} more not shown`);
  return lines.join('\n');
}

export interface MarkResult {
  /** How many badges were placed. */
  count: number;
  /** Remove every badge. Always call this — a marked page is a means, never a state. */
  cleanup: () => Promise<void>;
}

/**
 * Set-of-marks overlay: number every visible interactive control directly on the render,
 * so a vision model can ground the `[n]` indices in the snapshot text to pixels.
 *
 * The badge number IS the element's position in the SNAPSHOT_SELECTOR match list — the
 * same key `buildSnapshot` assigns — so text and image agree by construction as long as
 * the DOM did not change between them. Badges are `position: fixed` with
 * `pointer-events: none`: they never reflow the page and never intercept input. Only
 * on-viewport controls are badged; below-fold entries stay text-only.
 *
 * The overlay exists only for the screenshot taken inside `take`: inject, shoot, remove.
 * Callers must not leave a marked page behind — crops, audits, and verdicts all run on
 * the clean DOM.
 */
export async function markControls(page: Page, cap = SNAPSHOT_CAP): Promise<MarkResult> {
  // `locator.evaluateAll`, not `querySelectorAll`: the native call cannot see inside a
  // shadow root, so a component's controls would be left unbadged — and an unbadged
  // control is exactly the one an agent cannot ground to pixels. The element order and the
  // index numbering match `buildSnapshot` because both use this same engine.
  const count = (await page
    .locator(SNAPSHOT_SELECTOR)
    .evaluateAll(
      (els, max: number) => {
        const old = document.querySelector('[data-uicrawl-marks]');
        if (old) old.remove();
        const host = document.createElement('div');
        host.setAttribute('data-uicrawl-marks', 'true');
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;';
        const vpW = window.innerWidth;
        const vpH = window.innerHeight;
        let placed = 0;
        for (let i = 0; i < els.length && placed < max; i++) {
          const el = els[i];
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          if (r.bottom < 0 || r.right < 0 || r.top > vpH || r.left > vpW) continue;
          const badge = document.createElement('div');
          badge.textContent = String(i);
          const x = Math.max(10, Math.min(r.left, vpW - 10));
          const y = Math.max(10, Math.min(r.top, vpH - 10));
          badge.style.cssText =
            'position:absolute;' +
            `left:${x}px;top:${y}px;` +
            'transform:translate(-30%,-50%);' +
            'min-width:18px;height:18px;padding:0 4px;' +
            'display:flex;align-items:center;justify-content:center;' +
            'background:#7c3aed;color:#fff;' +
            'font:600 11px/1 ui-monospace,monospace;' +
            'border-radius:9px;box-shadow:0 0 0 1px #fff,0 1px 4px rgba(0,0,0,.4);';
          host.appendChild(badge);
          placed++;
        }
        document.documentElement.appendChild(host);
        return placed;
      },
      cap,
    )
    .catch(() => 0)) as number;

  return {
    count,
    cleanup: () =>
      page
        .evaluate(() => {
          document.querySelector('[data-uicrawl-marks]')?.remove();
        })
        .catch(() => {}),
  };
}

/**
 * Pure: what changed between two snapshots, for long navigation loops where re-sending
 * eighty unchanged lines per step is pure token burn.
 *
 * Indices are positional, so same-index comparison is meaningful while the DOM is
 * stable; when it mutates, indices shift and the delta degrades to "many changed" —
 * still correct, just verbose. Removed controls are reported with their last-known
 * index marked gone (they cannot be addressed), and the total is always stated so a
 * caller can tell "nothing changed" from "nothing listed".
 */
export function diffSnapshots(before: SnapshotEntry[], after: SnapshotEntry[]): string {
  const prev = new Map(before.map((e) => [e.index, e]));
  const lines: string[] = [];
  let changed = 0;
  for (const e of after) {
    const old = prev.get(e.index);
    if (!old) {
      lines.push(`+ ${formatSnapshotEntry(e)}`);
      changed++;
    } else if (
      old.tag !== e.tag ||
      old.role !== e.role ||
      old.name !== e.name ||
      old.disabled !== e.disabled ||
      old.visible !== e.visible ||
      old.href !== e.href ||
      old.inSelector !== e.inSelector
    ) {
      lines.push(`~ ${formatSnapshotEntry(e)}`);
      changed++;
    }
    prev.delete(e.index);
  }
  for (const gone of [...prev.values()].sort((a, b) => a.index - b.index)) {
    lines.push(`- [${gone.index}] ${gone.tag} ${JSON.stringify(gone.name)} (gone)`);
    changed++;
  }
  const header = `${after.length} controls, ${changed} changed since last snapshot`;
  return changed ? `${header}\n${lines.join('\n')}` : `${header} (no changes)`;
}

/**
 * Capture interactive elements. Prioritizes visible controls the probe SELECTOR
 * misses, then a bounded sample of covered controls for context. All evaluate
 * callbacks stay free of NAMED functions (tsx/esbuild `__name` injection).
 *
 * Read through `page.locator(...).evaluateAll(...)` rather than `$$eval` so Playwright's
 * own selector engine resolves the list. That engine pierces open shadow roots — the
 * controls inside a web component were previously invisible to every snapshot, badge, and
 * addressable index here — and, critically, it returns them in the same order `.nth()`
 * addresses them. Since a control's identity IS its position in this list, a hand-rolled
 * walker would risk handing the caller an index that clicks a different element; using
 * the same engine for both ends makes that impossible.
 */
export async function buildSnapshot(page: Page, cap = SNAPSHOT_CAP): Promise<SnapshotEntry[]> {
  const raw = await page.locator(SNAPSHOT_SELECTOR).evaluateAll(
    (els, selectSelector: string) => {
      const mapped = els.map((el, index) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || undefined;
        const disabled =
          el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
        const aria = el.getAttribute('aria-label');
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const title = el.getAttribute('title') || '';
        const name = ((aria && aria.trim()) ? aria.trim() : text || title).slice(0, 80);

        let href: string | undefined;
        if (tag === 'a') {
          try {
            href = new URL(el.getAttribute('href') || '', document.baseURI).href;
          } catch {
            href = undefined;
          }
        }

        let css = tag;
        if (el.id) {
          css = `#${el.id}`;
        } else {
          const tid = el.getAttribute('data-testid') || el.getAttribute('data-test');
          if (tid) css = `[data-testid="${tid.replace(/"/g, '\\"')}"]`;
          else {
            const parts: string[] = [];
            // A shadow root is a document boundary: `parentElement` is null above it, so
            // walking up alone would stop at the component and produce a selector that
            // matches every instance of that tag. Cross into the host instead, so the
            // selector is scoped to this component.
            const hostOf = (node: Element): Element | null =>
              node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
            let node: Element | null = el;
            for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth++) {
              const parent: Element | null = hostOf(node);
              if (!parent) break;
              const crossedShadow = node.parentElement === null;
              const tagL = node.tagName.toLowerCase();
              let nth = 1;
              let sib = node.previousElementSibling;
              while (sib) {
                if (sib.tagName === node.tagName) nth++;
                sib = sib.previousElementSibling;
              }
              let same = 0;
              let child = parent.firstElementChild;
              while (child) {
                if (child.tagName === node.tagName) same++;
                child = child.nextElementSibling;
              }
              if (same === 1) {
                parts.unshift(tagL);
                if (parent.id) {
                  parts.unshift(`#${parent.id}`);
                  break;
                }
                break;
              }
              parts.unshift(`${tagL}:nth-of-type(${nth})`);
              if (parent.id) {
                parts.unshift(`#${parent.id}`);
                break;
              }
              if (crossedShadow) {
                // The selector is only meaningful if it can get back through the root.
                parts.unshift('>>>');
              }
              node = parent;
            }
            css = parts.join(' > ') || tag;
          }
        }

        const inSelector = el.matches(selectSelector);
        return { index, tag, role, name, disabled, visible, href, css, inSelector };
      });

      const missed = mapped.filter((e) => e.visible && !e.inSelector);
      const covered = mapped.filter((e) => e.visible && e.inSelector);
      const hiddenMissed = mapped.filter((e) => !e.visible && !e.inSelector);
      const picked = [
        ...missed,
        ...covered.slice(0, 30),
        ...hiddenMissed.slice(0, 10),
      ];
      picked.sort((a, b) => a.index - b.index);
      return picked;
    },
    SELECTOR,
  );
  return raw.slice(0, cap) as SnapshotEntry[];
}

/**
 * Find a unique visible match for `tag` + `accessibleName` in the broader set and
 * return a CSS locator for it. Null when zero or ambiguous matches — never guesses.
 */
export async function relocateControl(
  page: Page,
  tag: string,
  accessibleName: string,
): Promise<{ css: string } | null> {
  if (!accessibleName) return null;
  const css = await page.evaluate(
    ({ selector, tag: wantTag, wantName }) => {
      const els = document.querySelectorAll(selector);
      const matches: Element[] = [];
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el.tagName.toLowerCase() !== wantTag) continue;
        const aria = el.getAttribute('aria-label');
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const title = el.getAttribute('title') || '';
        const name = ((aria && aria.trim()) ? aria.trim() : text || title).slice(0, 80);
        if (name !== wantName) continue;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (
          !(rect.width > 0 && rect.height > 0) ||
          style.visibility === 'hidden' ||
          style.display === 'none'
        ) {
          continue;
        }
        matches.push(el);
      }
      if (matches.length !== 1) return null;
      const el = matches[0];
      if (el.id) return `#${el.id}`;
      const tid = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (tid) return `[data-testid="${tid.replace(/"/g, '\\"')}"]`;
      const parts: string[] = [];
      let node: Element | null = el;
      for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
        const parent: Element | null = node.parentElement;
        if (!parent) break;
        const tagL = node.tagName.toLowerCase();
        let nth = 1;
        let sib = node.previousElementSibling;
        while (sib) {
          if (sib.tagName === node.tagName) nth++;
          sib = sib.previousElementSibling;
        }
        let same = 0;
        let child = parent.firstElementChild;
        while (child) {
          if (child.tagName === node.tagName) same++;
          child = child.nextElementSibling;
        }
        if (same === 1) {
          parts.unshift(tagL);
          break;
        }
        parts.unshift(`${tagL}:nth-of-type(${nth})`);
        if (parent.id) {
          parts.unshift(`#${parent.id}`);
          break;
        }
        node = parent;
      }
      return parts.join(' > ') || null;
    },
    { selector: SNAPSHOT_SELECTOR, tag, wantName: accessibleName },
  );
  return css ? { css } : null;
}

export interface SnapshotOptions {
  url?: string;
  dir?: string;
  file?: string;
  cap?: number;
}

export async function snapshotUrl(options: SnapshotOptions): Promise<SnapshotEntry[]> {
  let server: StaticServer | undefined;
  let targetUrl = options.url;
  if (!targetUrl && (options.dir || options.file)) {
    const target = options.dir || options.file!;
    server = await serveStatic(target);
    targetUrl = server.url;
  }
  if (!targetUrl) throw new Error('snapshotUrl requires url, dir, or file');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
    return await buildSnapshot(page, options.cap ?? SNAPSHOT_CAP);
  } finally {
    await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}
