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
 * Pure: render entries as a token-cheap numbered list.
 * Prefer out-of-selector visible controls; keep a little covered context.
 */
export function formatSnapshot(entries: SnapshotEntry[], cap = SNAPSHOT_CAP): string {
  if (!entries.length) return '(no interactive elements)';
  const shown = entries.slice(0, cap);
  const lines = shown.map((e) => {
    const parts = [`[${e.index}]`, e.tag];
    if (e.role) parts.push(`role=${e.role}`);
    if (e.name) parts.push(JSON.stringify(e.name));
    if (e.disabled) parts.push('disabled');
    if (!e.visible) parts.push('hidden');
    if (e.href) parts.push(`-> ${e.href}`);
    if (e.inSelector) parts.push('(covered)');
    return parts.join(' ');
  });
  if (entries.length > cap) lines.push(`… ${entries.length - cap} more not shown`);
  return lines.join('\n');
}

/**
 * Capture interactive elements. Prioritizes visible controls the probe SELECTOR
 * misses, then a bounded sample of covered controls for context. All evaluate
 * callbacks stay free of NAMED functions (tsx/esbuild `__name` injection).
 */
export async function buildSnapshot(page: Page, cap = SNAPSHOT_CAP): Promise<SnapshotEntry[]> {
  const raw = await page.$$eval(
    SNAPSHOT_SELECTOR,
    (els, selectSelector: string) => {
      const here = new URL(document.baseURI);
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
