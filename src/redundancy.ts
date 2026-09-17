import type { Control } from './types.js';

/** Pure: find controls on one page that lead to the same destination. Always a taste question. */

export interface RedundantGroup {
  destination: string;
  controls: Control[];
}

function normalizeDestination(dest: string): string {
  const trimmed = dest.split('#')[0].trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.searchParams.sort();
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return trimmed.replace(/\/+$/, '') || '/';
  }
}

function destinationOf(c: Control): string | null {
  const dest = c.navTarget ?? c.formAction;
  if (!dest) return null;
  const trimmed = dest.trim();
  if (!trimmed || trimmed === '#' || trimmed.toLowerCase().startsWith('javascript:')) return null;
  return normalizeDestination(trimmed);
}

export function findRedundant(controls: Control[]): RedundantGroup[] {
  const byDest = new Map<string, Control[]>();
  for (const c of controls) {
    if (c.disabled) continue;
    const dest = destinationOf(c);
    if (!dest) continue;
    const list = byDest.get(dest) ?? [];
    list.push(c);
    byDest.set(dest, list);
  }
  const groups: RedundantGroup[] = [];
  for (const [destination, list] of byDest) {
    if (list.length >= 2) groups.push({ destination, controls: list });
  }
  return groups;
}
