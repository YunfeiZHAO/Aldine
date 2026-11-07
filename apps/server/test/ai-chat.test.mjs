/**
 * Sidebar chat proxy: request validation, the private-address refusal on a
 * user-chosen URL, endpoint shapes per provider, and SSE decoding.
 */
import { check, eq, throws } from './assert.mjs';
import { parseChatRequest, checkedEndpoint, sseData, deltaOf, ChatInputError } from '../src/aichat.ts';

delete process.env.ALDINE_AI_ALLOW_PRIVATE;
delete process.env.ALDINE_TEST_ALLOW_LOOPBACK_CIMD;

const ok = { provider: 'anthropic', apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const r = parseChatRequest(ok);
eq(r.baseUrl, 'https://api.anthropic.com', 'anthropic default base');
eq(parseChatRequest({ ...ok, provider: 'openai' }).baseUrl, 'https://api.openai.com/v1', 'openai default base');
await throws(() => parseChatRequest({ ...ok, apiKey: ' ' }), 'API key', 'a key is required');
await throws(() => parseChatRequest({ ...ok, model: '' }), 'model', 'a model is required');
await throws(() => parseChatRequest({ ...ok, provider: 'x' }), 'provider', 'unknown provider');
await throws(() => parseChatRequest({ ...ok, messages: [{ role: 'system', content: 'x' }] }), 'role', 'roles are user/assistant only');
await throws(() => parseChatRequest({ ...ok, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }), 'last message', 'ends with the user');

eq((await checkedEndpoint({ provider: 'anthropic', baseUrl: 'https://1.1.1.1' })).toString(), 'https://1.1.1.1/v1/messages', 'anthropic adds /v1/messages');
eq((await checkedEndpoint({ provider: 'anthropic', baseUrl: 'https://1.1.1.1/v1/' })).toString(), 'https://1.1.1.1/v1/messages', 'anthropic keeps a given /v1');
eq((await checkedEndpoint({ provider: 'openai', baseUrl: 'https://1.1.1.1/api/v1' })).toString(), 'https://1.1.1.1/api/v1/chat/completions', 'openai appends chat/completions');

for (const u of ['http://127.0.0.1:11434/v1', 'http://localhost:8000', 'http://10.0.0.5/v1', 'http://169.254.169.254/latest', 'http://[::1]:8080']) {
  let err;
  try { await checkedEndpoint({ provider: 'openai', baseUrl: u }); } catch (e) { err = e; }
  check(err instanceof ChatInputError && /private or local/.test(err.message), `refuses ${u}`);
}
await throws(() => checkedEndpoint({ provider: 'openai', baseUrl: 'file:///etc/passwd' }), 'https://', 'non-http schemes');
await throws(() => checkedEndpoint({ provider: 'openai', baseUrl: 'https://u:p@1.1.1.1' }), 'API key field', 'credentials in the URL');

process.env.ALDINE_AI_ALLOW_PRIVATE = '1';
eq((await checkedEndpoint({ provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' })).toString(), 'http://127.0.0.1:11434/v1/chat/completions', 'the opt-in allows private addresses');
delete process.env.ALDINE_AI_ALLOW_PRIVATE;

function stream(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
}
const anthropicSse = [
  'event: message_start\ndata: {"type":"message_start"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n',
  '\nevent: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\r\n\r\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
let text = '';
for await (const ev of sseData(stream(anthropicSse))) { const d = deltaOf('anthropic', ev); if (typeof d === 'string') text += d; }
eq(text, 'Hello', 'anthropic deltas across chunk boundaries and CRLF');

text = '';
for await (const ev of sseData(stream(['data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DONE]\n\n']))) {
  const d = deltaOf('openai', ev); if (typeof d === 'string') text += d;
}
eq(text, 'Hi!', 'openai deltas and [DONE]');

const err = deltaOf('anthropic', { event: 'error', data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
check(err instanceof Error && err.message === 'Overloaded', 'a streamed error surfaces its message');

console.log('ai-chat: ok');
