import { createServer, type IncomingMessage, type Server } from 'node:http';
import { MAX_OUTPUT, REPORT_SCHEMA } from '../src/analysis-core.ts';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeError, createClaude } from '../src/analysis-claude.ts';

// createClaude against a local stub of the Messages API: the SDK reads its base URL from ANTHROPIC_BASE_URL, and the stub's URL is set before any client is
// built, with a dummy key, so no test can reach api.anthropic.com (and none could be billed even if one did: the key is not real).
type Seen = { url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> };
let server: Server;
let seen: Seen[];
let reply: { status: number; body: unknown; headers?: Record<string, string> };
let hits: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      hits++;
      seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
      // x-should-retry: false keeps the SDK from retrying a 5xx, so a test does not wait out its backoff
      res.writeHead(reply.status, { 'content-type': 'application/json', 'x-should-retry': 'false', ...reply.headers });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)); // a string is sent as it is
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  seen = [];
  hits = 0;
  reply = { status: 200, body: {} };
});

const KEY = 'sk-ant-dummy-not-a-real-key';
const message = (extra: object = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }],
  usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 }, ...extra,
});
const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ClaudeError);
  return e as ClaudeError;
};

describe('createClaude', () => {
  it('count() asks the token counter and returns input_tokens', async () => {
    reply = { status: 200, body: { input_tokens: 1234 } };
    expect(await createClaude(KEY).count('claude-opus-5-5', 'sys', 'hello')).toBe(1234);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/v1/messages/count_tokens');
    expect(seen[0]!.body).toMatchObject({ model: 'claude-opus-5-5', system: 'sys', messages: [{ role: 'user', content: 'hello' }], output_config: { format: { type: 'json_schema', schema: REPORT_SCHEMA } } });
    expect(seen[0]!.headers['x-api-key']).toBe(KEY);
  });

  it('run() joins the text blocks (not the thinking) and maps model, stop and usage', async () => {
    reply = { status: 200, body: message() };
    expect(await createClaude(KEY).run('claude-sonnet-5-5', 'sys', 'hello')).toEqual({
      text: '{"a":1}', model: 'claude-opus-5-5', stop: 'end_turn', usage: { input: 11, output: 22, cache_read: 33, cache_creation: 44 },
    });
    expect(seen[0]!.url).toBe('/v1/messages?beta=true');
    expect(seen[0]!.body).toMatchObject({
      model: 'claude-sonnet-5-5', max_tokens: MAX_OUTPUT, system: 'sys', messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'adaptive' }, output_config: { format: { type: 'json_schema', schema: REPORT_SCHEMA } },
    });
  });

  it('run() counts missing cache fields as 0', async () => {
    reply = { status: 200, body: message({ usage: { input_tokens: 5, output_tokens: 6 } }) };
    expect((await createClaude(KEY).run('claude-opus-5-5', 's', 'u')).usage).toEqual({ input: 5, output: 6, cache_read: 0, cache_creation: 0 });
  });

  it.each(['claude-opus-5-5', 'claude-sonnet-5-5'])('%s asks for the server-side fallback', async (model) => {
    reply = { status: 200, body: message({ model: 'claude-haiku-5-5' }) }; // the stub answers with another model, so the request's model is what is asserted
    await createClaude(KEY).run(model, 's', 'u');
    expect(seen[0]!.body.model).toBe(model);
    expect(seen[0]!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(seen[0]!.body.fallbacks).toBe('default');
  });

  it('claude-haiku-5-5 has no fallback: no beta header, no fallbacks', async () => {
    reply = { status: 200, body: message({ model: 'claude-opus-5-5' }) };
    await createClaude(KEY).run('claude-haiku-5-5', 's', 'u');
    expect(seen[0]!.body.model).toBe('claude-haiku-5-5');
    expect(String(seen[0]!.headers['anthropic-beta'] ?? '')).not.toContain('server-side-fallback');
    expect(seen[0]!.body).not.toHaveProperty('fallbacks');
  });

  it('names the workspace on every request when one is given, and on none otherwise', async () => {
    reply = { status: 200, body: { input_tokens: 1 } };
    await createClaude(KEY, 'wrkspc_01').count('claude-opus-5-5', 's', 'u');
    await createClaude(KEY).count('claude-opus-5-5', 's', 'u');
    expect(seen[0]!.headers['anthropic-workspace-id']).toBe('wrkspc_01');
    expect(seen[1]!.headers).not.toHaveProperty('anthropic-workspace-id');
  });

  it('a 4xx becomes ClaudeError(status, the API\'s own message), from count() and from run()', async () => {
    reply = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
    const claude = createClaude(KEY);
    for (const call of [() => claude.count('claude-opus-5-5', 's', 'u'), () => claude.run('claude-opus-5-5', 's', 'u')]) {
      const e = await refusal(call()); // built here, so a rejection is awaited as soon as it exists
      expect([e.status, e.message]).toEqual([401, 'invalid x-api-key']);
    }
  });

  it('a 4xx without the API\'s error body keeps the status and the SDK\'s message', async () => {
    reply = { status: 400, body: { oops: true } };
    const e = await refusal(createClaude(KEY).count('claude-opus-5-5', 's', 'u'));
    expect(e.status).toBe(400);
    expect(e.message).toContain('400');
  });

  it('a 5xx is a ClaudeError with its status and the API\'s message', async () => {
    reply = { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'Internal server error' } } };
    const e = await refusal(createClaude(KEY).run('claude-opus-5-5', 's', 'u'));
    expect([e.status, e.message]).toEqual([500, 'Internal server error']);
    expect(hits).toBe(1); // the stub says x-should-retry: false; in production the SDK retries a 5xx twice before this error is thrown
  });

  it('an error that is not the API\'s passes through as it is: a 200 whose body is not JSON', async () => {
    reply = { status: 200, body: '{not json' };
    const e = await createClaude(KEY).count('claude-opus-5-5', 's', 'u').then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ClaudeError);
  });

  it('a connection that is cut is a ClaudeError with status 0 and the SDK\'s message', async () => {
    const dead = createServer(); // a port that is really taken: every connection is cut at once, so there is no listener to rebind and no reply
    dead.on('connection', (socket) => socket.destroy());
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const port = (dead.address() as AddressInfo).port;
    const was = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      const claude = createClaude(KEY); // reads the base URL here, so the stub's URL is back before the next test
      process.env.ANTHROPIC_BASE_URL = was;
      const e = await refusal(claude.count('claude-opus-5-5', 's', 'u'));
      expect([e.status, e.message]).toEqual([0, 'Connection error.']);
    } finally {
      process.env.ANTHROPIC_BASE_URL = was;
      await new Promise((resolve) => dead.close(resolve));
    }
  }, 15_000);
});
