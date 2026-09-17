import { describe, it, expect } from 'vitest';
import { triageRaw } from '../src/triage.js';
import { NoopVisionPort, NoopTextTriagePort } from '../src/ports.js';
import type { RawFinding, FindingType } from '../src/types.js';

const ctx = { vision: new NoopVisionPort(), text: new NoopTextTriagePort() };

function raw(kind: FindingType, extra: Partial<RawFinding> = {}): RawFinding {
  return { route: '/x', kind, evidence: {}, ...extra };
}

describe('triageRaw (Noop ports = deterministic v1)', () => {
  const expectations: [FindingType, 'defect' | 'taste'][] = [
    ['page-load-error', 'defect'],
    ['console-error', 'defect'],
    ['broken-asset', 'defect'],
    ['button-threw', 'defect'],
    ['dead-button', 'defect'],
    ['broken-link', 'defect'],
    ['zoom-clip', 'taste'],
    ['maybe-contextual-button', 'taste'],
    ['redundant-control', 'taste'],
    ['missing-affordance', 'taste'],
    ['tight-target', 'taste'],
    ['stale-selector', 'taste'],
  ];
  for (const [kind, bucket] of expectations) {
    it(`${kind} -> ${bucket}`, () => {
      expect(triageRaw(raw(kind), ctx).bucket).toBe(bucket);
    });
  }

  it('a zoom reflow finding is taste under Noop vision (judgement, not a verified defect)', () => {
    expect(triageRaw(raw('zoom-overlap', { ambiguous: false }), ctx).bucket).toBe('taste');
    expect(triageRaw(raw('zoom-clip'), ctx).bucket).toBe('taste');
  });

  it('a zoom finding with a screenshot stays taste but records a skipped vision note', () => {
    const f = triageRaw(raw('zoom-overlap', { evidence: { screenshot: 's.png', zoom: 2 } }), ctx);
    expect(f.bucket).toBe('taste');
    expect(f.triage?.mode).toBe('skipped');
  });

  it('a bare no-op button is a taste question with a skipped model note', () => {
    const f = triageRaw(raw('maybe-contextual-button', { control: { accessibleName: 'Save', tag: 'button' } }), ctx);
    expect(f.bucket).toBe('taste');
    expect(f.triage).toEqual({ by: 'text', verdict: 'no-model', mode: 'skipped' });
  });

  it('does not misread "not broken" as a broken zoom verdict', () => {
    const f = triageRaw(
      raw('zoom-overlap', { evidence: { screenshot: 's.png', zoom: 2 } }),
      {
        vision: { judge: () => 'not broken' },
        text: new NoopTextTriagePort(),
      },
    );
    expect(f.bucket).toBe('taste');
    expect(f.severity).toBe('low');
    expect(f.triage).toEqual({ by: 'vision', verdict: 'ok', mode: 'model' });
  });

  it('does not misread "not dead" as a dead button verdict', () => {
    const f = triageRaw(
      raw('maybe-contextual-button', { control: { accessibleName: 'Save', tag: 'button' } }),
      {
        vision: new NoopVisionPort(),
        text: { complete: () => 'not dead - needs input first' },
      },
    );
    expect(f.bucket).toBe('taste');
    expect(f.severity).toBe('low');
    expect(f.triage).toEqual({ by: 'text', verdict: 'likely-contextual', mode: 'model' });
  });

  it('triages low contrast according to WCAG severity threshold', () => {
    const moderate = triageRaw(
      raw('low-contrast', {
        evidence: {
          contrast: { ratio: 4.1, fg: '#777', bg: '#fff', fontSize: '16px', fontWeight: '400' },
        },
      }),
      ctx,
    );
    expect(moderate.bucket).toBe('taste');
    expect(moderate.severity).toBe('medium');

    const severe = triageRaw(
      raw('low-contrast', {
        evidence: {
          contrast: { ratio: 2.1, fg: '#aaa', bg: '#fff', fontSize: '16px', fontWeight: '400' },
        },
      }),
      ctx,
    );
    expect(severe.bucket).toBe('defect');
    expect(severe.severity).toBe('high');
  });

  it('the defect/taste boundary never depends on a model in v1', () => {
    // identical result whether or not we pass models (both Noop here) — the invariant.
    const a = triageRaw(raw('dead-button'), ctx).bucket;
    const b = triageRaw(raw('dead-button'), ctx).bucket;
    expect(a).toBe(b);
  });
});
