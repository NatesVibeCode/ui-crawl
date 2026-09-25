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

function landmarkKey(c: Control): string {
  if (!c.landmark) return 'default';
  if (c.landmark === 'header' || c.landmark === 'nav') return 'nav';
  return c.landmark;
}

export function findRedundant(controls: Control[]): RedundantGroup[] {
  const byKey = new Map<string, { destination: string; controls: Control[] }>();
  for (const c of controls) {
    if (c.disabled) continue;
    const dest = destinationOf(c);
    if (!dest) continue;
    const key = `${dest}::${landmarkKey(c)}`;
    const entry = byKey.get(key) ?? { destination: dest, controls: [] };
    entry.controls.push(c);
    byKey.set(key, entry);
  }
  const groups: RedundantGroup[] = [];
  for (const entry of byKey.values()) {
    if (entry.controls.length >= 2) groups.push(entry);
  }
  return groups;
}
