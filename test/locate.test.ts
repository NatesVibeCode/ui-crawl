import { describe, it, expect } from 'vitest';
import { selectorCandidates } from '../src/locate.js';

describe('selectorCandidates — the tool\'s own selector grammar', () => {
  it('passes plain CSS through untouched', () => {
    expect(selectorCandidates('button#save')).toEqual([{ selector: 'button#save', label: null }]);
  });

  it('splits the accessible-name label off an interaction selector', () => {
    // This is what `interactions.describe()` emits. It is not valid CSS, which is why
    // `document.querySelector` used to throw and source grounding silently returned nothing.
    expect(selectorCandidates('button:nth(3) "Throws on click"')).toEqual([
      { selector: 'button:nth(3)', label: 'Throws on click' },
    ]);
  });

  it('splits a redundant-control pair and keeps both, in order', () => {
    expect(selectorCandidates('a:nth(7) "Account" , a:nth(8) "My Account"')).toEqual([
      { selector: 'a:nth(7)', label: 'Account' },
      { selector: 'a:nth(8)', label: 'My Account' },
    ]);
  });

  it('drops zoom intersection selectors, which name no single element', () => {
    expect(selectorCandidates('header ∩ nav')).toEqual([]);
  });

  it('keeps the addressable half of a mixed selector list', () => {
    expect(selectorCandidates('a:nth(1) "x" , header ∩ nav')).toEqual([
      { selector: 'a:nth(1)', label: 'x' },
    ]);
  });

  it('handles an empty selector without throwing', () => {
    expect(selectorCandidates('')).toEqual([]);
    expect(selectorCandidates('   ')).toEqual([]);
  });

  it('keeps a label containing spaces intact', () => {
    expect(selectorCandidates('button:nth(0) "My Account Settings"')).toEqual([
      { selector: 'button:nth(0)', label: 'My Account Settings' },
    ]);
  });
});
