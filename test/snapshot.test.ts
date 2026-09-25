import { describe, it, expect } from 'vitest';
import { formatSnapshot, type SnapshotEntry } from '../src/snapshot.js';

function entry(partial: Partial<SnapshotEntry> & { index: number }): SnapshotEntry {
  return {
    tag: 'button',
    name: 'Go',
    disabled: false,
    visible: true,
    css: 'button',
    inSelector: false,
    ...partial,
  };
}

describe('formatSnapshot', () => {
  it('renders numbered lines with name, role, href, and coverage marks', () => {
    const text = formatSnapshot([
      entry({ index: 0, name: 'Save', inSelector: true, css: '#save' }),
      entry({ index: 2, name: 'Docs', tag: 'a', href: 'https://x/docs', role: 'link' }),
      entry({ index: 3, name: 'Off', disabled: true }),
      entry({ index: 4, name: 'Gone', visible: false }),
    ]);
    expect(text).toContain('[0] button "Save" (covered)');
    expect(text).toContain('[2] a role=link "Docs" -> https://x/docs');
    expect(text).toContain('[3] button "Off" disabled');
    expect(text).toContain('[4] button "Gone" hidden');
  });

  it('caps output and notes the remainder', () => {
    const many = Array.from({ length: 5 }, (_, i) => entry({ index: i, name: `B${i}` }));
    const text = formatSnapshot(many, 2);
    expect(text).toContain('… 3 more not shown');
    expect(text.split('\n')).toHaveLength(3);
  });

  it('handles empty input', () => {
    expect(formatSnapshot([])).toBe('(no interactive elements)');
  });
});
