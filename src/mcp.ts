import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { crawl, type CrawlConfig } from './index.js';
import { buildAgentPayload, buildFindingsJson } from './report.js';
import { snapshotUrl, formatSnapshot } from './snapshot.js';
import { serveStatic, type StaticServer } from './serve.js';
import { openDatabase, getDiff, getRunHistory, getFindingById } from './db.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const MCP_TOOLS = [
  {
    name: 'ui_audit',
    description:
      'Deterministic visual, layout, and interaction audit of a web application. Discovers DOM collisions, text overlaps, clipping, low contrast, dead buttons, missing affordances, and reflow defects, returning prioritized agent remediation actions.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', description: 'Base URL of running app (e.g. http://localhost:3000)' },
        dir: { type: 'string', description: 'Static directory path to serve locally and audit' },
        file: { type: 'string', description: 'Static HTML file to serve locally and audit' },
        routes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific routes to audit (e.g. ["/"])',
        },
        maxPages: { type: 'number', description: 'Maximum pages to crawl (default 20)' },
        maxProbesPerPage: {
          type: 'number',
          description: 'Maximum button interaction probes per page (default 25)',
        },
        skipInteractions: { type: 'boolean', description: 'Skip clicking interactive buttons' },
        skipLayout: { type: 'boolean', description: 'Skip DOM layout collision detection' },
        skipContrast: { type: 'boolean', description: 'Skip color contrast audit' },
        skipAffordance: { type: 'boolean', description: 'Skip hover/focus affordance checks' },
        skipZoom: { type: 'boolean', description: 'Skip reflow zoom checks' },
        themeSweep: { type: 'boolean', description: 'Run dual-theme audit (light and dark mode)' },
        captureCrops: { type: 'boolean', description: 'Capture base64 visual micro-crops for defects' },
        dbPath: { type: 'string', description: 'SQLite database path (default: .ui-crawl.db)' },
        diff: { type: 'boolean', description: 'Compute differential against previous run' },
        full: {
          type: 'boolean',
          description: 'Return full raw crawl result instead of concise agent action plan',
        },
      },
    },
  },
  {
    name: 'ui_diff',
    description:
      'Compare two crawl runs from the SQLite database to identify fixed defects, persistent defects, and regressions.',
    inputSchema: {
      type: 'object',
      properties: {
        dbPath: { type: 'string', description: 'Path to SQLite database (default: .ui-crawl.db)' },
        runA: { type: 'string', description: 'Baseline run ID (defaults to previous run)' },
        runB: { type: 'string', description: 'Current run ID (defaults to latest run)' },
      },
    },
  },
  {
    name: 'ui_history',
    description: 'Query past crawl runs, defect counts, and verdicts from the SQLite database.',
    inputSchema: {
      type: 'object',
      properties: {
        dbPath: { type: 'string', description: 'Path to SQLite database (default: .ui-crawl.db)' },
        limit: { type: 'number', description: 'Max runs to return (default: 10)' },
      },
    },
  },
  {
    name: 'ui_snapshot',
    description:
      'Capture an LLM-tailored semantic snapshot of interactive elements on a page (indexed controls, CSS selectors, accessible names, visible/covered state).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the page to inspect' },
        dir: { type: 'string', description: 'Static directory path to serve locally and snapshot' },
        file: { type: 'string', description: 'Static HTML file to serve locally and snapshot' },
        cap: { type: 'number', description: 'Max controls to capture (default 80)' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: "Snapshot format: 'text' (compact numbered list) or 'json' (array of SnapshotEntry objects)",
        },
      },
    },
  },
];

export async function handleMcpMessage(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;

  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'ui-crawl',
          version: '0.1.0',
        },
      },
    };
  }

  if (request.method === 'notifications/initialized') {
    return null;
  }

  if (request.method === 'ping') {
    return {
      jsonrpc: '2.0',
      id,
      result: {},
    };
  }

  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  if (request.method === 'tools/call') {
    const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (name === 'ui_audit') {
      let server: StaticServer | undefined;
      try {
        let baseUrl = typeof args.baseUrl === 'string' ? args.baseUrl : undefined;
        const target = typeof args.dir === 'string' ? args.dir : typeof args.file === 'string' ? args.file : undefined;
        if (!baseUrl && target) {
          server = await serveStatic(target);
          baseUrl = server.url;
        }

        if (!baseUrl) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: 'Error: ui_audit requires baseUrl, dir, or file' }],
              isError: true,
            },
          };
        }

        const crawlCfg: Partial<CrawlConfig> = {
          baseUrl,
          routes: Array.isArray(args.routes) ? (args.routes as string[]) : undefined,
          maxPages: typeof args.maxPages === 'number' ? args.maxPages : undefined,
          maxProbesPerPage: typeof args.maxProbesPerPage === 'number' ? args.maxProbesPerPage : undefined,
          skipInteractionSweep: args.skipInteractions === true,
          skipLayout: args.skipLayout === true,
          skipContrast: args.skipContrast === true,
          skipAffordance: args.skipAffordance === true,
          skipZoom: args.skipZoom === true,
          themeSweep: args.themeSweep === true,
          captureCrops: args.captureCrops === true,
          dbPath: typeof args.dbPath === 'string' ? args.dbPath : undefined,
          diff: typeof args.diff === 'boolean' || typeof args.diff === 'string' ? args.diff : undefined,
        };

        const result = await crawl(crawlCfg as CrawlConfig);
        const output = args.full ? buildFindingsJson(result) : JSON.stringify(buildAgentPayload(result), null, 2);

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: output }],
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Error executing ui_audit: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          },
        };
      } finally {
        if (server) await server.close().catch(() => {});
      }
    }

    if (name === 'ui_diff') {
      try {
        const dbPath = typeof args.dbPath === 'string' ? args.dbPath : '.ui-crawl.db';
        const db = openDatabase(dbPath);
        const runB = typeof args.runB === 'string' ? args.runB : undefined;
        const runA = typeof args.runA === 'string' ? args.runA : undefined;

        let currentId = runB;
        if (!currentId) {
          const latest = getRunHistory(db, 1)[0];
          if (!latest) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: 'No crawl runs found in database.' }],
                isError: true,
              },
            };
          }
          currentId = latest.id;
        }

        const diffResult = getDiff(db, currentId, runA);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(diffResult, null, 2) }],
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Error executing ui_diff: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          },
        };
      }
    }

    if (name === 'ui_history') {
      try {
        const dbPath = typeof args.dbPath === 'string' ? args.dbPath : '.ui-crawl.db';
        const db = openDatabase(dbPath);
        const limit = typeof args.limit === 'number' ? args.limit : 10;
        const history = getRunHistory(db, limit);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(history, null, 2) }],
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Error executing ui_history: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          },
        };
      }
    }

    if (name === 'ui_snapshot') {
      try {
        const entries = await snapshotUrl({
          url: typeof args.url === 'string' ? args.url : undefined,
          dir: typeof args.dir === 'string' ? args.dir : undefined,
          file: typeof args.file === 'string' ? args.file : undefined,
          cap: typeof args.cap === 'number' ? args.cap : undefined,
        });

        const isJson = args.format === 'json';
        const text = isJson ? JSON.stringify(entries, null, 2) : formatSnapshot(entries, typeof args.cap === 'number' ? args.cap : undefined);

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text }],
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Error executing ui_snapshot: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Unknown tool: ${name}`,
      },
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${request.method}`,
    },
  };
}

export async function startMcpServer(
  inStream: Readable = process.stdin,
  outStream: Writable = process.stdout,
): Promise<void> {
  const rl = readline.createInterface({
    input: inStream,
    terminal: false,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcRequest;
      const response = await handleMcpMessage(parsed);
      if (response !== null) {
        outStream.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      const errResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
      outStream.write(JSON.stringify(errResponse) + '\n');
    }
  }
}
