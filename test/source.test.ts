import { describe, it, expect } from 'vitest';
import { extractElementSource } from '../src/source.js';

describe('Source-to-DOM grounding', () => {
  it('extracts source from data attributes', () => {
    const el = {
      nodeType: 1,
      getAttribute(name: string) {
        if (name === 'data-source-file') return 'src/components/Button.tsx';
        if (name === 'data-source-line') return '42';
        if (name === 'data-component') return 'CustomButton';
        return null;
      },
    } as unknown as Element;

    const source = extractElementSource(el);
    expect(source).toBeDefined();
    expect(source?.file).toBe('src/components/Button.tsx');
    expect(source?.line).toBe(42);
    expect(source?.component).toBe('CustomButton');
  });

  it('extracts source from React Fiber debugSource and hierarchy', () => {
    const fiberRoot = {
      type: { displayName: 'Button' },
      _debugSource: { fileName: 'src/ui/Button.tsx', lineNumber: 18, columnNumber: 5 },
      return: {
        type: { displayName: 'Card' },
        return: {
          type: { displayName: 'Dashboard' },
          return: null,
        },
      },
    };

    const el = {
      nodeType: 1,
      getAttribute: () => null,
      __reactFiber$12345: fiberRoot,
    } as unknown as Element;

    const source = extractElementSource(el);
    expect(source).toBeDefined();
    expect(source?.file).toBe('src/ui/Button.tsx');
    expect(source?.line).toBe(18);
    expect(source?.column).toBe(5);
    expect(source?.component).toBe('Button');
    expect(source?.hierarchy).toEqual(['Button', 'Card', 'Dashboard']);
  });

  it('extracts source from Vue vnode', () => {
    const el = {
      nodeType: 1,
      getAttribute: () => null,
      __vnode: {
        type: {
          __name: 'UserProfile',
          __file: 'src/views/UserProfile.vue',
        },
      },
    } as unknown as Element;

    const source = extractElementSource(el);
    expect(source).toBeDefined();
    expect(source?.file).toBe('src/views/UserProfile.vue');
    expect(source?.component).toBe('UserProfile');
  });

  it('returns undefined for plain DOM elements with no framework metadata', () => {
    const el = {
      nodeType: 1,
      getAttribute: () => null,
    } as unknown as Element;

    expect(extractElementSource(el)).toBeUndefined();
  });
});
