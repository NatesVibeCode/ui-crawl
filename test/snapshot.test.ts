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

describe('diffSnapshots', () => {
  const e = (over: Partial<import('../src/snapshot.js').SnapshotEntry> = {}): import('../src/snapshot.js').SnapshotEntry => ({
    index: 0, tag: 'button', name: 'Save', disabled: false, visible: true, css: 'button', inSelector: true,
    ...over,
  });

  it('reports no changes honestly instead of an empty list', async () => {
    const { diffSnapshots } = await import('../src/snapshot.js');
    const before = [e(), e({ index: 1, tag: 'a', name: 'Home' })];
    expect(diffSnapshots(before, [...before])).toContain('(no changes)');
  });

  it('marks added, changed, and gone controls without renumbering the survivors', async () => {
    const { diffSnapshots } = await import('../src/snapshot.js');
    const before = [e(), e({ index: 1, tag: 'a', name: 'Home' })];
    const after = [
      e({ name: 'Save now' }), // ~ changed
      e({ index: 2, tag: 'input', name: 'Search' }), // + added (index 1 gone)
    ];
    const out = diffSnapshots(before, after);
    expect(out).toContain('2 controls, 3 changed');
    expect(out).toMatch(/^~ \[0\] button "Save now"/m);
    expect(out).toMatch(/^\+ \[2\] input "Search"/m);
    expect(out).toContain('- [1] a "Home" (gone)');
  });
});
