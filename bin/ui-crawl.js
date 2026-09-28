#!/usr/bin/env node
/**
 * Thin shim. All CLI behaviour lives in `src/cli.ts` (compiled to `dist/cli.js`) so there
 * is exactly one implementation, it is typechecked, and it is covered by tests.
 *
 * This file previously held a second, hand-maintained copy of the whole CLI. Two copies of
 * 300 lines of flag dispatch, with nothing asserting they agreed, is a bug that had not
 * fired yet.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(__dirname, '../dist/cli.js');

if (!existsSync(distEntry)) {
  process.stderr.write(
    JSON.stringify({ error: 'ui-crawl: dist/ not built. Run "npm run build" first.' }) + '\n',
  );
  process.exit(1);
}

const { main } = await import(pathToFileURL(distEntry).href);
await main();
