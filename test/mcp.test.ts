import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { handleMcpMessage, startMcpServer, MCP_TOOLS } from '../src/mcp.js';

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
      serverInfo: { name: 'ui-crawl', version: '0.1.0' },
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

  it('lists ui_audit and ui_snapshot tools', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });
    expect(res?.id).toBe(3);
    const tools = (res?.result as { tools: typeof MCP_TOOLS }).tools;
    expect(tools.map((t) => t.name)).toContain('ui_audit');
    expect(tools.map((t) => t.name)).toContain('ui_snapshot');
    expect(tools.map((t) => t.name)).toContain('ui_diff');
    expect(tools.map((t) => t.name)).toContain('ui_history');
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
