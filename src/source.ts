import type { Page } from 'playwright';
import type { SourceLocation } from './types.js';

/**
 * In-browser extractor: inspects React Fiber internals, Vue vnodes, Svelte metadata,
 * and data-source attributes to locate the component and source file that produced this element.
 * NOTE: keep function anonymous or inline when passed to page.evaluate to prevent tsx __name injection.
 */
export function extractElementSource(el: Element): SourceLocation | undefined {
  if (!el || el.nodeType !== 1) return undefined;

  let file: string | undefined;
  let line: number | undefined;
  let column: number | undefined;
  let component: string | undefined;
  const hierarchy: string[] = [];

  // 1. Check direct data attributes first (Astro, Vite plugins, Storybook, etc.)
  const attrFile = el.getAttribute('data-source-file') || el.getAttribute('data-file') || undefined;
  const attrLine = el.getAttribute('data-source-line') || el.getAttribute('data-line') || undefined;
  const attrComp = el.getAttribute('data-component') || el.getAttribute('data-testid') || undefined;

  if (attrFile) {
    file = attrFile;
    line = attrLine ? parseInt(attrLine, 10) : undefined;
  }
  if (attrComp) {
    component = attrComp;
  }

  // 2. React Fiber extraction (__reactFiber$*, __reactInternalInstance$*)
  const anyEl = el as unknown as Record<string, unknown>;
  const fiberKey = Object.keys(anyEl).find(
    (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
  );

  if (fiberKey) {
    let curr: Record<string, unknown> | null = anyEl[fiberKey] as Record<string, unknown> | null;
    const HTML_TAGS = new Set([
      'div', 'span', 'p', 'button', 'a', 'section', 'main', 'header',
      'footer', 'ul', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav',
    ]);

    while (curr) {
      const type = (curr.type || curr.elementType) as Record<string, unknown> | string | undefined;
      let compName: string | undefined;

      if (typeof type === 'function' || (typeof type === 'object' && type !== null)) {
        compName = (type as { displayName?: string; name?: string }).displayName || (type as { name?: string }).name;
      }

      if (compName) {
        if (!component) component = compName;
        hierarchy.push(compName);
      }

      const debugSource = curr._debugSource as { fileName?: string; lineNumber?: number; columnNumber?: number } | undefined;
      if (debugSource && !file) {
        file = debugSource.fileName;
        line = debugSource.lineNumber;
        column = debugSource.columnNumber;
      }

      curr = curr.return as Record<string, unknown> | null;
    }
  }

  // 3. Vue (__vnode)
  const vnode = (anyEl.__vnode || anyEl._vnode) as Record<string, unknown> | undefined;
  if (vnode) {
    const vtype = vnode.type as Record<string, unknown> | undefined;
    if (vtype) {
      const vComp = (vtype.__name || vtype.name) as string | undefined;
      const vFile = vtype.__file as string | undefined;
      if (vComp && !component) component = vComp;
      if (vFile && !file) file = vFile;
    }
  }

  // 4. Svelte (__svelte_meta)
  const svelteMeta = anyEl.__svelte_meta as { loc?: { file?: string; line?: number } } | undefined;
  if (svelteMeta?.loc) {
    if (svelteMeta.loc.file && !file) file = svelteMeta.loc.file;
    if (svelteMeta.loc.line && !line) line = svelteMeta.loc.line;
  }

  if (!file && !component && !hierarchy.length) {
    return undefined;
  }

  return {
    file,
    line,
    column,
    component,
    hierarchy: hierarchy.length ? hierarchy : undefined,
  };
}

/**
 * Resolves component source information for a given CSS selector in a Playwright Page.
 */
export async function resolveSourceForSelector(
  page: Page,
  selector: string,
): Promise<SourceLocation | undefined> {
  try {
    return await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return undefined;

      const anyEl = el as unknown as Record<string, unknown>;
      let file: string | undefined;
      let line: number | undefined;
      let column: number | undefined;
      let component: string | undefined;
      const hierarchy: string[] = [];

      const attrFile = el.getAttribute('data-source-file') || el.getAttribute('data-file') || undefined;
      const attrLine = el.getAttribute('data-source-line') || el.getAttribute('data-line') || undefined;
      const attrComp = el.getAttribute('data-component') || el.getAttribute('data-testid') || undefined;

      if (attrFile) {
        file = attrFile;
        line = attrLine ? parseInt(attrLine, 10) : undefined;
      }
      if (attrComp) component = attrComp;

      const fiberKey = Object.keys(anyEl).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
      );
      if (fiberKey) {
        let curr: Record<string, unknown> | null = anyEl[fiberKey] as Record<string, unknown> | null;
        const HTML_TAGS = new Set([
          'div', 'span', 'p', 'button', 'a', 'section', 'main', 'header',
          'footer', 'ul', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav',
        ]);
        while (curr) {
          const type = (curr.type || curr.elementType) as Record<string, unknown> | string | undefined;
          let compName: string | undefined;
          if (typeof type === 'function' || (typeof type === 'object' && type !== null)) {
            compName = (type as { displayName?: string; name?: string }).displayName || (type as { name?: string }).name;
          }
          if (compName) {
            if (!component) component = compName;
            hierarchy.push(compName);
          }
          const debugSource = curr._debugSource as { fileName?: string; lineNumber?: number; columnNumber?: number } | undefined;
          if (debugSource && !file) {
            file = debugSource.fileName;
            line = debugSource.lineNumber;
            column = debugSource.columnNumber;
          }
          curr = curr.return as Record<string, unknown> | null;
        }
      }

      const vnode = (anyEl.__vnode || anyEl._vnode) as Record<string, unknown> | undefined;
      if (vnode?.type) {
        const vtype = vnode.type as Record<string, unknown>;
        const vComp = (vtype.__name || vtype.name) as string | undefined;
        const vFile = vtype.__file as string | undefined;
        if (vComp && !component) component = vComp;
        if (vFile && !file) file = vFile;
      }

      const svelteMeta = anyEl.__svelte_meta as { loc?: { file?: string; line?: number } } | undefined;
      if (svelteMeta?.loc) {
        if (svelteMeta.loc.file && !file) file = svelteMeta.loc.file;
        if (svelteMeta.loc.line && !line) line = svelteMeta.loc.line;
      }

      if (!file && !component && !hierarchy.length) return undefined;
      return { file, line, column, component, hierarchy: hierarchy.length ? hierarchy : undefined };
    }, selector);
  } catch {
    return undefined;
  }
}
