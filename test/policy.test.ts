import { describe, it, expect } from 'vitest';
import { parseRobots, isLoopbackHost } from '../src/policy.js';

describe('parseRobots', () => {
  it('collects Allow/Disallow for the wildcard group only', () => {
    const rules = parseRobots(`
      User-agent: Googlebot
      Disallow: /private/
      User-agent: *
      Disallow: /admin
      Allow: /admin/public
    `);
    expect(rules.disallow).toEqual(['/admin']);
    expect(rules.allow).toEqual(['/admin/public']);
  });

  it('ignores comments and blank lines, and tolerates a missing space', () => {
    const rules = parseRobots('# leading comment\nUser-agent:*\nDisallow:/x  # trailing\n\n');
    expect(rules.disallow).toEqual(['/x']);
  });

  it('is empty when no group applies', () => {
    const rules = parseRobots('User-agent: SomeBot\nDisallow: /everything\n');
    expect(rules).toEqual({ allow: [], disallow: [] });
  });

  it('is empty for an empty document', () => {
    expect(parseRobots('')).toEqual({ allow: [], disallow: [] });
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback spellings', () => {
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('does not exempt real hosts, including private ranges', () => {
    // Private LAN ranges are NOT loopback: pacing and robots still apply to them.
    for (const host of ['example.com', '10.0.0.5', '192.168.1.20', '172.16.4.4', 'notlocalhost.com', 'localhost.evil.com']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
