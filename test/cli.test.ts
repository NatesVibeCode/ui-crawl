import { describe, it, expect } from 'vitest';
import { parseFlags } from '../src/cli.js';
import { describeAction, SessionRegistry } from '../src/session.js';
import type { SessionAction } from '../src/session.js';

describe('parseFlags', () => {
  it('reads --key value and bare --key', () => {
    const { opts } = parseFlags(['--base-url', 'http://x', '--crops', '--dir', './dist']);
    expect(opts['base-url']).toBe('http://x');
    expect(opts.crops).toBe(true);
    expect(opts.dir).toBe('./dist');
  });

  it('reads --key=value', () => {
    const { opts } = parseFlags(['--routes=/,/about', '--db=a.sqlite']);
    expect(opts.routes).toBe('/,/about');
    expect(opts.db).toBe('a.sqlite');
  });

  it('reads short flags, including a value', () => {
    expect(parseFlags(['-c', '8']).opts.c).toBe('8');
    expect(parseFlags(['-c8']).opts).toEqual({});
  });

  it('collects positionals and leaves an http URL one', () => {
    expect(parseFlags(['http://localhost:3000', '--crops']).positional).toEqual([
      'http://localhost:3000',
    ]);
  });

  it('does not swallow a following flag as a value', () => {
    const { opts } = parseFlags(['--crops', '--quick']);
    expect(opts.crops).toBe(true);
    expect(opts.quick).toBe(true);
  });

  it('preserves an equals sign inside a value', () => {
    expect(parseFlags(['--diff=--base-url=x']).opts.diff).toBe('--base-url=x');
  });
});

describe('describeAction', () => {
  const cases: Array<[SessionAction, string]> = [
    [{ type: 'click', index: 3 }, 'click [3]'],
    [{ type: 'fill', index: 7, value: 'x' }, 'fill [7]'],
    [{ type: 'select', index: 1, value: 'a' }, 'select [1]'],
    [{ type: 'press', key: 'Enter' }, 'press Enter'],
    [{ type: 'scroll', dy: 400 }, 'scroll dy=400'],
    [{ type: 'resize', width: 390, height: 844 }, 'resize 390x844'],
    [{ type: 'theme', scheme: 'dark' }, 'theme dark'],
    [{ type: 'wait', ms: 250 }, 'wait 250ms'],
    [{ type: 'wait' }, 'wait 500ms'],
    [{ type: 'reload' }, 'reload'],
    [{ type: 'back' }, 'back'],
    [{ type: 'forward' }, 'forward'],
  ];
  for (const [action, expected] of cases) {
    it(`${expected}`, () => {
      expect(describeAction(action)).toBe(expected);
    });
  }
});

describe('SessionRegistry', () => {
  it('refuses to open past its cap instead of evicting a live session', async () => {
    const registry = new SessionRegistry(1);
    const fake = { id: 's1', close: async () => {} } as never;
    registry.add(fake);
    expect(() => registry.add({ id: 's2', close: async () => {} } as never)).toThrow(
      /already open/,
    );
  });

  it('names the missing session on a bad id', () => {
    const registry = new SessionRegistry(2);
    expect(() => registry.get('nope')).toThrow(/no open session with id "nope"/);
  });

  it('reports open ids and forgets a closed one', async () => {
    const registry = new SessionRegistry(2);
    let closed = false;
    registry.add({ id: 's1', close: async () => { closed = true; } } as never);
    expect(registry.ids()).toEqual(['s1']);
    await registry.close('s1');
    expect(closed).toBe(true);
    expect(registry.ids()).toEqual([]);
    expect(registry.has('s1')).toBe(false);
  });
});

describe('describeAction: screenshot', () => {
  it('distinguishes a viewport shot from a full-page shot', () => {
    expect(describeAction({ type: 'screenshot' })).toBe('screenshot');
    expect(describeAction({ type: 'screenshot', fullPage: true })).toBe('screenshot fullPage');
  });
});
