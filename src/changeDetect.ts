import type { Signals, ChangeVerdict } from './types.js';

/**
 * A click must move at least this many real DOM nodes / semantic attrs to count as "acted".
 * Set to 1: childList changes and semantic-attribute toggles are already noise-filtered at
 * the observer (class/style flips ignored), so a single real mutation is a genuine action.
 * The bias is deliberate — a missed late signal degrades to a TASTE question, never a false defect.
 */
export const MUTATION_FLOOR = 1;

/**
 * Pure classifier — the crux. Given everything observed after a click, decide whether
 * the control DID anything.
 *
 * Bias by design: `ACTED` requires a positive signal. A `clickThrew` is INCONCLUSIVE
 * (obstructed — not the control's fault). Absence of all signals is `NOOP` — which the
 * triage layer turns into a DEFECT only when the control had a real destination, and
 * otherwise into a TASTE question. Silence is never, on its own, a bug.
 */
export function classifyChange(s: Signals): ChangeVerdict {
  if (s.clickThrew) return 'INCONCLUSIVE';
  if (s.navigated || s.urlChanged) return 'ACTED';
  if (s.dialogOpened || s.popupOpened) return 'ACTED';
  if (s.networkRequests > 0) return 'ACTED';
  if (s.domMutated) return 'ACTED';
  if (s.domMutationCount >= MUTATION_FLOOR) return 'ACTED';
  return 'NOOP';
}
