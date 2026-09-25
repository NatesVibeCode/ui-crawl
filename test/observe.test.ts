import { describe, it, expect } from 'vitest';
import {
  parseObserveReply,
  observedControls,
  buildObservePrompt,
} from '../src/observe.js';
import type { SnapshotEntry } from '../src/snapshot.js';

function entry(partial: Partial<SnapshotEntry> & { index: number }): SnapshotEntry {
  return {
    tag: 'button',
    name: 'Control',
    disabled: false,
    visible: true,
    css: 'button',
    inSelector: false,
    ...partial,
  };
}

const entries: SnapshotEntry[] = [
  entry({ index: 0, name: 'Save', inSelector: true, css: '#save' }),
  entry({ index: 1, name: 'Settings', role: 'menuitem', css: '[role="menuitem"]' }),
  entry({ index: 2, name: 'Hidden thing', visible: false }),
  entry({ index: 5, name: 'Tab two', role: 'tab', tag: 'div', css: '#tab2' }),
];

const valid = new Set([1, 5]);

describe('parseObserveReply', () => {
  it('accepts a bare index array', () => {
    expect(parseObserveReply('[1, 5]', valid)).toEqual([1, 5]);
  });

  it('accepts object-form entries and markdown fences', () => {
    expect(parseObserveReply('```json\n[{"index": 1}]\n```', valid)).toEqual([1]);
  });

  it('drops out-of-range, duplicates, covered, and non-integers', () => {
    expect(parseObserveReply('[1, 1, 0, 2, 99, 1.5, "x"]', valid)).toEqual([1]);
  });

  it('returns [] for empty, garbage, and non-array JSON', () => {
    expect(parseObserveReply('', valid)).toEqual([]);
    expect(parseObserveReply('   ', valid)).toEqual([]);
    expect(parseObserveReply('not json at all', valid)).toEqual([]);
    expect(parseObserveReply('{"index":1}', valid)).toEqual([]);
    expect(parseObserveReply('null', valid)).toEqual([]);
  });
});

describe('observedControls', () => {
  it('maps only visible out-of-selector indices to controls with css locators', () => {
    const out = observedControls(entries, '[1, 0, 2]');
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('observe');
    expect(out[0].index).toBe(-1);
    expect(out[0].locator?.css).toBe('[role="menuitem"]');
    expect(out[0].accessibleName).toBe('Settings');
    expect(out[0].role).toBe('menuitem');
  });

  it('marks destructive labels from observe', () => {
    const out = observedControls(
      [entry({ index: 3, name: 'Delete account', css: '#del' })],
      '[3]',
    );
    expect(out[0].destructive).toBe(true);
  });

  it('returns [] when nothing is valid or reply is empty', () => {
    expect(observedControls(entries, '')).toEqual([]);
    expect(observedControls([entries[0]], '[0]')).toEqual([]);
  });
});

describe('buildObservePrompt', () => {
  it('includes missed indices and marks covered controls', () => {
    const { system, prompt } = buildObservePrompt(entries);
    expect(system).toMatch(/JSON array/);
    expect(prompt).toContain('[1]');
    expect(prompt).toContain('Settings');
    expect(prompt).toContain('(covered)');
    // hidden entries are not listed as candidates in the prompt body ordering
    expect(prompt).toContain('[0]'); // covered context
  });

  it('handles an empty page', () => {
    const { prompt } = buildObservePrompt([]);
    expect(prompt).toContain('(none)');
  });
});
