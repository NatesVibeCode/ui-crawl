import { describe, it, expect } from 'vitest';
import { toRouteTemplate } from '../src/routeTemplate.js';

describe('toRouteTemplate', () => {
  const cases: [string, string][] = [
    ['/', '/'],
    ['/campaigns', '/campaigns'],
    ['/settings/account', '/settings/account'],
    ['/guests/42', '/guests/[id]'],
    ['/guests/cmip3k9z0000s01l7abcd1234', '/guests/[id]'],
    ['/p/9f8e7d6c-1234-4abc-9def-0123456789ab', '/p/[id]'],
    ['/orders/2024/55', '/orders/[id]/[id]'],
    ['/campaigns/77?tab=moments', '/campaigns/[id]'],
    ['/experiences/sunset-sail', '/experiences/sunset-sail'],
    ['/campaigns/summer-sale-2024', '/campaigns/summer-sale-2024'],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(toRouteTemplate(input)).toBe(expected);
    });
  }

  it('collapses sibling dynamic routes to one template', () => {
    expect(toRouteTemplate('/guests/aaa111bbb222')).toBe(toRouteTemplate('/guests/ccc333ddd444'));
  });
});
