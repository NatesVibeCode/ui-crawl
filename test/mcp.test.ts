import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { handleMcpMessage, startMcpServer, MCP_TOOLS, MCP_VERSION } from '../src/mcp.js';

describe('MCP server handler', () => {
  it('handles initialize request', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });

    expect(res).not.toBeNull();
    expect(res?.id).toBe(1);
    expect(res?.result).toEqual({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ui-crawl', version: MCP_VERSION },
    });
  });

  it('ignores initialized notification', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res).toBeNull();
  });

  it('handles ping request', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    });
    expect(res?.id).toBe(2);
    expect(res?.result).toEqual({});
  });

  it('exposes the batch and the live-navigation tool set', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });
    const names = (res?.result as { tools: typeof MCP_TOOLS }).tools.map((t) => t.name);
    for (const expected of [
      'ui_audit', 'ui_open', 'ui_act', 'ui_close', 'ui_login',
      'ui_snapshot', 'ui_diff', 'ui_history', 'ui_selectors',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('every tool declares an object input schema', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('ui_audit exposes the same knobs the CLI does', () => {
    const audit = MCP_TOOLS.find((t) => t.name === 'ui_audit')!;
    const props = Object.keys(audit.inputSchema.properties);
    for (const knob of [
      'browser', 'quick', 'viewports', 'storageState', 'seedStorage', 'outDir',
      'headless', 'skipSpacing', 'skipHitTest', 'guidance', 'networkInventory',
      'rerunDefects', 'captureCrops', 'themeSweep', 'concurrency', 'maxFindingsPerPage',
    ]) {
      expect(props).toContain(knob);
    }
  });

  it('documents the real maxProbesPerPage default rather than a stale one', () => {
    const audit = MCP_TOOLS.find((t) => t.name === 'ui_audit')!;
    const props = audit.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.maxProbesPerPage.description).toContain('40');
  });

  it('ui_act rejects a click with no index instead of guessing', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'ui_act', arguments: { action: 'click' } },
    });
    const result = res?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sessionId');
  });

  it('ui_act names the missing session rather than failing obscurely', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'ui_act', arguments: { sessionId: 'nope', action: 'click', index: 0 } },
    });
    const result = res?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no open session');
  });

  it('ui_selectors explains the gap between what is listed and what is clicked', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'ui_selectors', arguments: {} },
    });
    const payload = JSON.parse(
      (res?.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(payload.probeSelector).toContain('button');
    expect(payload.snapshotSelector).toContain('role="menuitem"');
  });

  it('ui_diff explains itself when the database has too few runs', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'ui_diff', arguments: { dbPath: ':memory:' } },
    });
    const result = res?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ui_audit');
  });

  it('handles ui_history call with in-memory db', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'ui_history', arguments: { dbPath: ':memory:' } },
    });
    expect(res?.id).toBe(6);
    const result = res?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  it('returns error when tool is unknown', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'non_existent_tool' },
    });
    expect(res?.error?.code).toBe(-32601);
    expect(res?.error?.message).toContain('non_existent_tool');
  });

  it('returns isError when ui_audit lacks target url or dir', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'ui_audit', arguments: {} },
    });
    const result = res?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires baseUrl, dir, or file');
  });

  it('streams JSON-RPC requests over PassThrough streams in startMcpServer', async () => {
    const inStream = new PassThrough();
    const outStream = new PassThrough();

    const outputChunks: string[] = [];
    outStream.on('data', (chunk) => {
      outputChunks.push(chunk.toString());
    });

    const serverPromise = startMcpServer(inStream, outStream);

    inStream.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' }) + '\n');
    inStream.end();

    await serverPromise;

    const fullOutput = outputChunks.join('');
    const parsed = JSON.parse(fullOutput.trim());
    expect(parsed.id).toBe(42);
    expect(parsed.result).toEqual({});
  });
});
