import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** The harness must import only relative modules, node builtins, and playwright. */
function isAllowed(spec: string): boolean {
  if (spec.startsWith('.')) return true;
  if (spec.startsWith('node:')) return true;
  if (spec === 'playwright') return true;
  return false;
}

describe('import independence (standalone)', () => {
  it('src/** imports nothing application-specific', async () => {
    const files = (await readdir(SRC)).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      const rawText = await readFile(path.join(SRC, file), 'utf8');
      // Strip comments so prose like "follow links from '/'" isn't mistaken for an import.
      const text = rawText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const re = /\bfrom\s+['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!isAllowed(m[1])) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
