import { describe, it, expect } from 'vitest';
import { isTouchTargetSmall, isHitOccluded } from '../src/hitTest.js';

describe('hit-testing: pure physics & sizing helpers', () => {
  it('correctly flags touch targets below WCAG 24px threshold', () => {
    expect(isTouchTargetSmall(24, 24)).toBe(false);
    expect(isTouchTargetSmall(48, 48)).toBe(false);
    expect(isTouchTargetSmall(16, 24)).toBe(true);
    expect(isTouchTargetSmall(24, 18)).toBe(true);
    expect(isTouchTargetSmall(12, 12)).toBe(true);
  });

  it('correctly determines whether hit target is occluded', () => {
    const parent = {
      contains(other: unknown) {
        return other === child;
      },
    } as unknown as Element;

    const child = {
      contains() {
        return false;
      },
    } as unknown as Element;

    const overlay = {
      contains() {
        return false;
      },
    } as unknown as Element;

    // Direct hit
    expect(isHitOccluded(parent, parent)).toBe(false);

    // Hit on descendant child
    expect(isHitOccluded(parent, child)).toBe(false);

    // Occluded by un-related overlay
    expect(isHitOccluded(parent, overlay)).toBe(true);

    // Null hit (out of bounds or invisible)
    expect(isHitOccluded(parent, null)).toBe(true);
  });
});
