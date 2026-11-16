import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ForbiddenError } from '../src/lib/errors.js';
import { toToolErrorPayload } from '../src/mcp/errors.js';
import { installSdkRequestHandlers } from '../src/mcp/sdk-dispatch.js';

const fixture = async () => {
  const server = new McpServer({ name: 'dispatch-test', version: '1' });
  const tool = server.registerTool('echo', {
    inputSchema: {
      text: z.string().refine(async value => value !== 'rejected', 'Rejected text.'),
      count: z.number().default(2),
    },
  }, async args => ({ content: [], structuredContent: args }));
  server.registerTool('fail', {}, async () => { throw new ForbiddenError('Forbidden test.'); });
  const resource = server.registerResource('fixed', 'test://fixed', {}, async uri => ({
    contents: [{ uri: uri.toString(), text: 'fixed' }],
  }));
  server.registerResource('template', new ResourceTemplate('test://items/{id}', { list: undefined }), {},
    async (uri, variables) => ({ contents: [{ uri: uri.toString(), text: String(variables.id) }] }));
  installSdkRequestHandlers(server, error => ({
    isError: true, content: [], structuredContent: toToolErrorPayload(error),
  }));
  const client = new Client({ name: 'dispatch-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, tool, resource };
};

test('SDK dispatch preserves tool validation, errors, and live registration', async t => {
  const { server, client, tool } = await fixture();
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name: string, args: Record<string, unknown> = {}, task?: object) => client.request({
    method: 'tools/call', params: { name, arguments: args, ...(task ? { task } : {}) },
  }, CallToolResultSchema);
  const errorOf = async (name: string, args?: Record<string, unknown>, task?: object) => {
    const result = await call(name, args, task);
    assert.equal(result.isError, true);
    return (result.structuredContent as ReturnType<typeof toToolErrorPayload>).error;
  };

  assert.deepEqual((await call('echo', { text: 'hello' })).structuredContent, { text: 'hello', count: 2 });
  const invalid = await errorOf('echo', { text: 42 });
  assert.equal(invalid.code, 'validation_error');
  assert.equal(invalid.fieldErrors?.[0].field, 'text');
  assert.equal((await errorOf('echo', { text: 'rejected' })).code, 'validation_error');
  assert.equal((await errorOf('missing')).code, 'invalid_request');
  assert.equal((await errorOf('fail')).code, 'forbidden');
  await assert.rejects(
    () => call('echo', { text: 'hello' }, { ttl: 1000 }),
    /Server does not support task creation/
  );

  tool.disable();
  assert.match((await errorOf('echo', { text: 'hello' })).message, /disabled/);
  tool.enable();
  assert.equal((await call('echo', { text: 'again' })).isError, undefined);
  server.registerTool('late', {}, async () => ({ content: [{ type: 'text', text: 'late' }] }));
  assert.deepEqual((await call('late')).content, [{ type: 'text', text: 'late' }]);
});

test('SDK dispatch preserves resource matching, disabled resources, and guidance', async t => {
  const { server, client, resource } = await fixture();
  t.after(async () => { await client.close(); await server.close(); });
  assert.equal((await client.readResource({ uri: 'test://fixed' })).contents[0].text, 'fixed');
  assert.equal((await client.readResource({ uri: 'test://items/abc' })).contents[0].text, 'abc');
  resource.disable();
  await assert.rejects(() => client.readResource({ uri: 'test://fixed' }), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, ErrorCode.InvalidParams);
    assert.match(error.message, /disabled/);
    return true;
  });
  resource.enable();
  assert.equal((await client.readResource({ uri: 'test://fixed' })).contents[0].text, 'fixed');
  await assert.rejects(() => client.readResource({ uri: 'test://missing' }), error => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, ErrorCode.InvalidParams);
    assert.match(error.message, /Available resources: agpwiki:\/\/pages/);
    assert.match(error.message, /wiki_readPage, blog_readPost, citation_read/);
    return true;
  });
});
