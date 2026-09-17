import { describe, it, expect } from 'vitest';
import { findRedundant } from '../src/redundancy.js';
import type { Control } from '../src/types.js';

function ctrl(p: Partial<Control>): Control {
  return {
    index: 0,
    tag: 'a',
    accessibleName: 'link',
    disabled: false,
    visible: true,
    destructive: false,
    ...p,
  };
}

describe('findRedundant', () => {
  it('groups two controls with the same destination', () => {
    const groups = findRedundant([
      ctrl({ index: 0, accessibleName: 'Account', navTarget: 'http://x/account' }),
      ctrl({ index: 1, accessibleName: 'My Account', navTarget: 'http://x/account' }),
      ctrl({ index: 2, accessibleName: 'Home', navTarget: 'http://x/' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].controls).toHaveLength(2);
  });

  it('normalizes trailing slashes and hashes', () => {
    const groups = findRedundant([
      ctrl({ index: 0, navTarget: 'http://x/account/' }),
      ctrl({ index: 1, navTarget: 'http://x/account#top' }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('normalizes equivalent query params even when order differs', () => {
    const groups = findRedundant([
      ctrl({ index: 0, navTarget: 'http://x/account?tab=profile&mode=full' }),
      ctrl({ index: 1, navTarget: 'http://x/account?mode=full&tab=profile' }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('ignores disabled controls and #/javascript targets', () => {
    expect(
      findRedundant([
        ctrl({ index: 0, navTarget: 'http://x/a', disabled: true }),
        ctrl({ index: 1, navTarget: 'http://x/a', disabled: true }),
      ]),
    ).toHaveLength(0);
    expect(
      findRedundant([
        ctrl({ index: 0, navTarget: '#' }),
        ctrl({ index: 1, navTarget: 'javascript:void(0)' }),
      ]),
    ).toHaveLength(0);
  });

  it('a single control is not redundant', () => {
    expect(findRedundant([ctrl({ navTarget: 'http://x/a' })])).toHaveLength(0);
  });
});
