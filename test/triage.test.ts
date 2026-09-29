import { describe, it, expect } from 'vitest';
import { triageRaw } from '../src/triage.js';
import type { RawFinding, FindingType } from '../src/types.js';

function raw(kind: FindingType, extra: Partial<RawFinding> = {}): RawFinding {
  return { route: '/x', kind, evidence: {}, ...extra };
}

describe('triageRaw — deterministic defect/taste boundary', () => {
  const expectations: [FindingType, 'defect' | 'taste'][] = [
    ['page-load-error', 'defect'],
    ['console-error', 'defect'],
    ['broken-asset', 'defect'],
    ['button-threw', 'defect'],
    ['dead-button', 'defect'],
    ['broken-link', 'defect'],
    ['zoom-clip', 'taste'],
    ['zoom-overlap', 'taste'],
    ['maybe-contextual-button', 'taste'],
    ['redundant-control', 'taste'],
    ['missing-affordance', 'taste'],
    ['tight-target', 'taste'],
    ['stale-selector', 'taste'],
    ['robots-blocked', 'taste'],
    ['bot-challenge', 'taste'],
    ['missing-accessible-name', 'defect'],
    ['keyboard-inaccessible', 'defect'],
    ['missing-image-alt', 'defect'],
    ['invalid-aria-reference', 'defect'],
    ['invalid-aria-state', 'defect'],
    ['dialog-missing-label', 'defect'],
    ['layout-overlap', 'defect'],
    ['text-overlap', 'defect'],
    ['text-line-collision', 'defect'],
    ['clipped-text', 'taste'],
    ['viewport-overflow', 'defect'],
    ['small-touch-target', 'taste'],
    ['container-overflow', 'defect'],
    ['sibling-overlap', 'defect'],
    ['pointer-intercepted', 'defect'],
    ['dark-mode-contrast', 'defect'],
    ['text-border-collision', 'defect'],
    ['vertical-rhythm-drift', 'taste'],
    ['viewport-scale-imbalance', 'taste'],
    ['unanchored-divider-bleed', 'taste'],
    ['adjacent-wordmark-echo', 'taste'],
    ['above-the-fold-vacancy', 'taste'],
  ];

  for (const [kind, bucket] of expectations) {
    it(`${kind} -> ${bucket}`, () => {
      expect(triageRaw(raw(kind)).bucket).toBe(bucket);
    });
  }

  it('every finding type is covered by the table above', () => {
    // A new detector that forgets a triage rule throws at runtime, not silently.
    const covered = new Set(expectations.map(([k]) => k));
    const all: FindingType[] = [
      'page-load-error', 'console-error', 'broken-asset', 'dead-button', 'button-threw',
      'broken-link', 'maybe-contextual-button', 'redundant-control', 'low-contrast',
      'missing-affordance', 'tight-target', 'robots-blocked', 'bot-challenge', 'zoom-clip',
      'zoom-overlap', 'stale-selector', 'missing-accessible-name', 'keyboard-inaccessible',
      'missing-image-alt', 'invalid-aria-reference', 'invalid-aria-state',
      'dialog-missing-label', 'layout-overlap', 'text-overlap', 'text-line-collision',
      'clipped-text', 'viewport-overflow', 'pointer-intercepted', 'small-touch-target',
      'dark-mode-contrast', 'container-overflow', 'sibling-overlap', 'text-border-collision',
      'vertical-rhythm-drift', 'viewport-scale-imbalance', 'unanchored-divider-bleed',
      'adjacent-wordmark-echo', 'above-the-fold-vacancy',
    ];
    // low-contrast is bucketed from its measured ratio, not a static rule.
    const expectedMissing = all.filter((t) => !covered.has(t) && t !== 'low-contrast');
    expect(expectedMissing).toEqual([]);
  });

  it('a zoom reflow finding is a judgement, never a verified defect', () => {
    expect(triageRaw(raw('zoom-overlap', { ambiguous: false })).bucket).toBe('taste');
    expect(triageRaw(raw('zoom-clip')).bucket).toBe('taste');
  });

  it('a bare no-op button stays a taste question, not a defect', () => {
    const f = triageRaw(raw('maybe-contextual-button', { control: { accessibleName: 'Save', tag: 'button' } }));
    expect(f.bucket).toBe('taste');
  });

  it('triages low contrast by the WCAG severity threshold', () => {
    const moderate = triageRaw(
      raw('low-contrast', {
        evidence: { contrast: { ratio: 4.1, fg: '#777777', bg: '#ffffff', fontSize: '16px', fontWeight: '400' } },
      }),
    );
    expect(moderate.bucket).toBe('taste');
    expect(moderate.severity).toBe('medium');

    const severe = triageRaw(
      raw('low-contrast', {
        evidence: { contrast: { ratio: 2.1, fg: '#aaaaaa', bg: '#ffffff', fontSize: '16px', fontWeight: '400' } },
      }),
    );
    expect(severe.bucket).toBe('defect');
    expect(severe.severity).toBe('high');
  });

  it('is pure: the same finding always buckets the same way', () => {
    const finding = raw('dead-button');
    expect(triageRaw(finding).bucket).toBe(triageRaw(finding).bucket);
  });

  it('preserves remediation guidance and evidence on the finding', () => {
    const f = triageRaw(
      raw('layout-overlap', { evidence: { selector: '.a', remediation: 'Add flex-wrap: wrap;' } }),
    );
    expect(f.remediation).toBe('Add flex-wrap: wrap;');
    expect(f.evidence.selector).toBe('.a');
  });
});
