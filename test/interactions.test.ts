import { describe, it, expect } from 'vitest';
import { rawFromVerdict } from '../src/interactions.js';
import type { Control, Signals } from '../src/types.js';

function control(partial: Partial<Control>): Control {
  return {
    index: 0,
    tag: 'button',
    accessibleName: 'Control',
    disabled: false,
    visible: true,
    destructive: false,
    ...partial,
  };
}

function signals(partial: Partial<Signals>): Signals {
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
    ...partial,
  };
}

describe('rawFromVerdict', () => {
  it('classifies a no-op anchor with a real href as broken-link', () => {
    const finding = rawFromVerdict(
      '/x',
      control({ tag: 'a', accessibleName: 'Account', navTarget: 'http://x/account' }),
      signals({}),
    );
    expect(finding?.kind).toBe('broken-link');
  });

  it('keeps bare no-op buttons as maybe-contextual-button', () => {
    const finding = rawFromVerdict('/x', control({ accessibleName: 'Save' }), signals({}));
    expect(finding?.kind).toBe('maybe-contextual-button');
  });
});
