import type { Page } from 'playwright';
import type { Control } from './types.js';
import type { TextTriagePort } from './ports.js';
import type { SnapshotEntry } from './snapshot.js';
import { buildSnapshot, formatSnapshot, SNAPSHOT_CAP } from './snapshot.js';
import { isDestructiveLabel } from './interactions.js';

/** Cap on model-suggested extras merged into one page's control list. */
export const OBSERVE_EXTRA_CAP = 20;

const OBSERVE_SYSTEM =
  'You assist a deterministic UI crawl. The CSS selector inventory already covers controls ' +
  'marked (covered). Reply ONLY with a JSON array of indices of VISIBLE controls NOT marked ' +
  '(covered) that a user would click, activate, or navigate with — menus, tabs, custom widgets. ' +
  'Omit covered entries, hidden entries, and anything inert. Use numbers, e.g. [3, 7] or ' +
  '[{"index": 3}]. An empty array [] means nothing to add.';

/** Pure: build the observe prompt from snapshot entries. */
export function buildObservePrompt(entries: SnapshotEntry[]): { system: string; prompt: string } {
  const missed = entries.filter((e) => !e.inSelector && e.visible);
  const body = missed.length
    ? formatSnapshot(
        [
          ...missed,
          ...entries.filter((e) => e.inSelector && e.visible).slice(0, 15),
        ].sort((a, b) => a.index - b.index),
        SNAPSHOT_CAP,
      )
    : '(none)';
  return {
    system: OBSERVE_SYSTEM,
    prompt: `URL path is given by the page under test. Interactive elements:\n${body}\n\nReturn JSON array of indices to add:`,
  };
}

/**
 * Pure: parse a model reply into valid snapshot indices.
 * Garbage, empty, fences, duplicates, and out-of-range indices all collapse safely.
 */
export function parseObserveReply(reply: string, validIndices: ReadonlySet<number>): number[] {
  const trimmed = (reply ?? '').trim();
  if (!trimmed) return [];
  let parsed: unknown;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    const m = unfenced.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: number[] = [];
  for (const item of parsed) {
    let idx: number | null = null;
    if (typeof item === 'number' && Number.isInteger(item)) idx = item;
    else if (item && typeof item === 'object' && typeof (item as { index?: unknown }).index === 'number') {
      const n = (item as { index: number }).index;
      if (Number.isInteger(n)) idx = n;
    }
    if (idx === null) continue;
    if (!validIndices.has(idx)) continue;
    if (!out.includes(idx)) out.push(idx);
  }
  return out;
}

function entryToControl(e: SnapshotEntry): Control {
  return {
    index: -1,
    tag: e.tag,
    role: e.role,
    accessibleName: e.name,
    disabled: e.disabled,
    visible: e.visible,
    navTarget: e.tag === 'a' && e.href ? e.href : undefined,
    destructive: isDestructiveLabel(e.name),
    source: 'observe',
    locator: { css: e.css },
  };
}

/** Pure: turn a model reply into extra controls the CSS inventory missed. */
export function observedControls(entries: SnapshotEntry[], reply: string): Control[] {
  const valid = new Set(entries.filter((e) => !e.inSelector && e.visible).map((e) => e.index));
  if (!valid.size) return [];
  const indices = parseObserveReply(reply, valid);
  const byIndex = new Map(entries.map((e) => [e.index, e]));
  const out: Control[] = [];
  for (const i of indices) {
    const e = byIndex.get(i);
    if (!e) continue;
    if (e.inSelector || !e.visible) continue;
    out.push(entryToControl(e));
    if (out.length >= OBSERVE_EXTRA_CAP) break;
  }
  return out;
}

/**
 * Snapshot the page, ask the text port which out-of-selector controls to probe,
 * and return extras to merge after `enumerateControls`. Never throws to the caller
 * for model failures — empty/garbage replies yield [].
 */
export async function observeExtraControls(
  page: Page,
  text: TextTriagePort,
  cap = OBSERVE_EXTRA_CAP,
): Promise<Control[]> {
  try {
    const entries = await buildSnapshot(page);
    const missed = entries.filter((e) => !e.inSelector && e.visible);
    if (!missed.length) return [];
    const { system, prompt } = buildObservePrompt(entries);
    const raw = await Promise.resolve(text.complete({ system, prompt }));
    const reply = typeof raw === 'string' ? raw : '';
    return observedControls(entries, reply).slice(0, cap);
  } catch {
    return [];
  }
}
