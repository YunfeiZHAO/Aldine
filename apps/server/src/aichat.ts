import dns from 'node:dns';
import net from 'node:net';
import { isBlockedAddress } from './oauth/cimd.js';

/**
 * Sidebar chat proxy. The browser supplies the endpoint, key and model on
 * every request; nothing here is stored or logged. The browser cannot call
 * most providers itself (gateways rarely answer CORS), so the server relays
 * the provider's stream as NDJSON deltas.
 *
 * The URL is user-chosen, so it is an SSRF surface: http(s) only, every
 * resolved address must be public unless ALDINE_AI_ALLOW_PRIVATE=1, and
 * redirects are refused rather than followed. A local model on the user's
 * own PC never goes through here; the browser calls it directly.
 */

export type ChatProvider = 'anthropic' | 'openai';
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatRequest {
  provider: ChatProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
}

export const CHAT_MAX_MESSAGES = 200;
export const CHAT_MAX_CHARS = 600_000;
/** One whole answer, connect to last byte. */
export const CHAT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TOKENS = 8192;

export class ChatInputError extends Error {}

export function allowPrivate(): boolean {
  return process.env.ALDINE_AI_ALLOW_PRIVATE === '1';
}

const DEFAULT_BASE: Record<ChatProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

/** Throws ChatInputError with a message fit for the person who typed it. */
export function parseChatRequest(body: any): ChatRequest {
  if (!body || typeof body !== 'object') throw new ChatInputError('Request body required');
  const provider: ChatProvider = body.provider;
  if (provider !== 'anthropic' && provider !== 'openai') throw new ChatInputError('provider must be "anthropic" or "openai"');
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) throw new ChatInputError('Choose a model in the chat settings');
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) throw new ChatInputError('Add an API key in the chat settings');
  const baseUrl = (typeof body.baseUrl === 'string' && body.baseUrl.trim()) || DEFAULT_BASE[provider];
  const system = typeof body.system === 'string' ? body.system : '';
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new ChatInputError('messages must be a non-empty list');
  if (body.messages.length > CHAT_MAX_MESSAGES) throw new ChatInputError(`At most ${CHAT_MAX_MESSAGES} messages per request; clear the chat to start over`);
  let chars = system.length;
  const messages: ChatMessage[] = body.messages.map((m: any) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw new ChatInputError('Each message needs a role (user or assistant) and text content');
    }
    chars += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (chars > CHAT_MAX_CHARS) throw new ChatInputError('The conversation is too long; clear the chat or select less text');
  if (messages[messages.length - 1].role !== 'user') throw new ChatInputError('The last message must be from the user');
  return { provider, baseUrl, apiKey, model, system, messages };
}

/** The provider endpoint the request goes to, after the address check. */
export async function checkedEndpoint(req: Pick<ChatRequest, 'provider' | 'baseUrl'>): Promise<URL> {
  let base: URL;
  try { base = new URL(req.baseUrl); } catch { throw new ChatInputError(`"${req.baseUrl}" is not a valid URL`); }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new ChatInputError('The base URL must start with https:// or http://');
  if (base.username || base.password) throw new ChatInputError('Put the key in the API key field, not in the URL');
  const path = base.pathname.replace(/\/+$/, '');
  const suffix = req.provider === 'anthropic'
    ? (/\/v1$/.test(path) ? '/messages' : '/v1/messages')
    : '/chat/completions';
  const url = new URL(base.toString());
  url.pathname = path + suffix;
  if (!allowPrivate()) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    if (net.isIP(host)) addresses = [host];
    else {
      try { addresses = (await dns.promises.lookup(host, { all: true })).map((a) => a.address); }
      catch { throw new ChatInputError(`Could not resolve ${host}`); }
    }
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      throw new ChatInputError(`${host} is a private or local address, which this server does not call. Use the Local provider for a model on your own computer, or ask the operator to set ALDINE_AI_ALLOW_PRIVATE=1.`);
    }
  }
  return url;
}

/** Splits a fetch body into server-sent-event `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = ''; data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
      if (done) break;
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}

/** The text deltas of one SSE payload, or an Error the provider reported. */
export function deltaOf(provider: ChatProvider, ev: { event: string; data: string }): string | Error | null {
  if (ev.data === '[DONE]') return null;
  let j: any;
  try { j = JSON.parse(ev.data); } catch { return null; }
  if (j?.type === 'error' || (j?.error && typeof j.error === 'object')) {
    return new Error(String(j.error?.message || j.error?.type || 'The provider reported an error'));
  }
  if (provider === 'anthropic') {
    return j?.type === 'content_block_delta' && j.delta?.type === 'text_delta' && typeof j.delta.text === 'string' ? j.delta.text : null;
  }
  const c = j?.choices?.[0]?.delta?.content;
  return typeof c === 'string' && c ? c : null;
}

async function providerError(res: Response): Promise<Error> {
  let detail = '';
  try {
    const text = await res.text();
    try { const j = JSON.parse(text); detail = j?.error?.message || j?.error || j?.message || text; } catch { detail = text; }
  } catch { /* keep empty */ }
  detail = String(detail).trim().slice(0, 300);
  const hint = res.status === 401 || res.status === 403 ? ' Check the API key.' : res.status === 404 ? ' Check the base URL and model.' : '';
  return new Error(`The provider answered HTTP ${res.status}${detail ? `: ${detail}` : ''}.${hint}`);
}

/** Streams the answer's text. `signal` aborts the upstream request. */
export async function* streamChat(req: ChatRequest, url: URL, signal: AbortSignal): AsyncGenerator<string> {
  const isAnthropic = req.provider === 'anthropic';
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
  let body: unknown;
  if (isAnthropic) {
    headers['x-api-key'] = req.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = { model: req.model, max_tokens: MAX_TOKENS, stream: true, ...(req.system ? { system: req.system } : {}), messages: req.messages };
  } else {
    headers.authorization = `Bearer ${req.apiKey}`;
    body = {
      model: req.model,
      stream: true,
      messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages],
    };
  }
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal });
  } catch (err: any) {
    if (signal.aborted) throw err;
    throw new Error(`Could not reach ${url.host}: ${err?.cause?.code || err?.message || 'network error'}`);
  }
  if (res.status >= 300 && res.status < 400) throw new Error(`The provider redirected to another address, which this server does not follow. Use the final URL as the base URL.`);
  if (!res.ok) throw await providerError(res);
  if (!res.body) throw new Error('The provider sent an empty answer');
  const type = res.headers.get('content-type') || '';
  if (!type.includes('event-stream')) {
    // Some gateways ignore stream:true and answer with one JSON body.
    const j: any = await res.json().catch(() => null);
    const text = isAnthropic
      ? (j?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
      : j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('The provider answered in a format this chat does not understand');
    if (text) yield text;
    return;
  }
  for await (const ev of sseData(res.body)) {
    const d = deltaOf(req.provider, ev);
    if (d instanceof Error) throw d;
    if (d) yield d;
  }
}
