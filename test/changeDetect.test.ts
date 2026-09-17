import { describe, it, expect } from 'vitest';
import { classifyChange } from '../src/changeDetect.js';
import type { Signals } from '../src/types.js';

function sig(p: Partial<Signals>): Signals {
  return {
    navigated: false,
    urlChanged: false,
    domMutated: false,
    domMutationCount: 0,
    networkRequests: 0,
    newConsoleMessages: 0,
    consoleErrors: 0,
    dialogOpened: false,
    popupOpened: false,
    clickThrew: false,
    ...p,
  };
}

describe('classifyChange', () => {
  it('navigation is ACTED', () => expect(classifyChange(sig({ navigated: true }))).toBe('ACTED'));
  it('url change is ACTED', () => expect(classifyChange(sig({ urlChanged: true }))).toBe('ACTED'));
  it('a network request is ACTED', () => expect(classifyChange(sig({ networkRequests: 1 }))).toBe('ACTED'));
  it('a DOM mutation flag is ACTED even without a count', () => expect(classifyChange(sig({ domMutated: true }))).toBe('ACTED'));
  it('a single DOM mutation is ACTED', () => expect(classifyChange(sig({ domMutationCount: 1 }))).toBe('ACTED'));
  it('a dialog is ACTED', () => expect(classifyChange(sig({ dialogOpened: true }))).toBe('ACTED'));
  it('a popup is ACTED', () => expect(classifyChange(sig({ popupOpened: true }))).toBe('ACTED'));

  it('a thrown click is INCONCLUSIVE, not a verdict', () =>
    expect(classifyChange(sig({ clickThrew: true }))).toBe('INCONCLUSIVE'));

  it('silence is NOOP', () => expect(classifyChange(sig({}))).toBe('NOOP'));

  it('a console error alone does NOT make it acted (stays NOOP -> later button-threw)', () =>
    expect(classifyChange(sig({ consoleErrors: 1 }))).toBe('NOOP'));
});
