import { describe, it, expect } from 'vitest';
import { isChallengePage, challengeSeverity } from '../src/challenge.js';

describe('isChallengePage', () => {
  it('detects Cloudflare "Just a moment" by title/body alone (even 200)', () => {
    expect(
      isChallengePage({
        status: 200,
        title: 'Just a moment…',
        bodyTextSample: 'Checking your browser before accessing example.com.',
      }),
    ).toBe(true);
  });

  it('detects 403 + cloudflare server header', () => {
    expect(
      isChallengePage({
        status: 403,
        title: '',
        bodyTextSample: 'Access denied',
        headers: { server: 'cloudflare' },
      }),
    ).toBe(true);
  });

  it('detects cf-mitigated: challenge header', () => {
    expect(
      isChallengePage({
        status: 503,
        headers: { 'cf-mitigated': 'challenge' },
      }),
    ).toBe(true);
  });

  it('does not flag a normal app page', () => {
    expect(
      isChallengePage({
        status: 200,
        title: 'Campaign dashboard',
        bodyTextSample: 'Welcome back. You have 3 campaigns and 12 guests waiting for review.',
      }),
    ).toBe(false);
  });

  it('does not flag a plain 404 without challenge markers', () => {
    expect(
      isChallengePage({
        status: 404,
        title: 'Not found',
        bodyTextSample: 'nope',
      }),
    ).toBe(false);
  });
});

describe('challengeSeverity', () => {
  it('403/503 are high; others medium', () => {
    expect(challengeSeverity(403)).toBe('high');
    expect(challengeSeverity(503)).toBe('high');
    expect(challengeSeverity(429)).toBe('medium');
    expect(challengeSeverity(null)).toBe('medium');
  });
});
