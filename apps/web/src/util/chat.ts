/**
 * Sidebar chat: providers, the request each one takes, and the stream
 * parsers. Cloud providers go through the server (/ai/chat, NDJSON deltas);
 * the two local ones are called from the browser, since only the browser can
 * reach the user's own computer.
 */
import { withBase } from '../basePath';

export type ChatProviderId = 'anthropic' | 'openai' | 'local-openai' | 'local-bridge';

export interface ProviderSettings { baseUrl: string; apiKey: string; model: string }
export interface ChatSettings { provider: ChatProviderId; providers: Record<ChatProviderId, ProviderSettings> }

export interface ChatContext { file: string; from: number; to: number; fromLine: number; toLine: number; text: string }
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  context?: ChatContext;
  /** Assistant only: which provider and model answered. */
  via?: string;
  error?: string;
}

export const PROVIDERS: Record<ChatProviderId, { label: string; local: boolean; needsKey: boolean; urlPlaceholder: string; modelPlaceholder: string }> = {
  anthropic: { label: 'Claude', local: false, needsKey: true, urlPlaceholder: 'https://api.anthropic.com', modelPlaceholder: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI-compatible', local: false, needsKey: true, urlPlaceholder: 'https://api.openai.com/v1', modelPlaceholder: 'gpt-5.5' },
  'local-openai': { label: 'Local model', local: true, needsKey: false, urlPlaceholder: 'http://localhost:11434/v1', modelPlaceholder: 'llama3.2' },
  'local-bridge': { label: 'Local Claude Code', local: true, needsKey: false, urlPlaceholder: 'http://127.0.0.1:8765', modelPlaceholder: 'sonnet' },
};

export const PROVIDER_ORDER: ChatProviderId[] = ['anthropic', 'openai', 'local-openai', 'local-bridge'];

export function defaultSettings(): ChatSettings {
  return {
    provider: 'anthropic',
    providers: {
      anthropic: { baseUrl: '', apiKey: '', model: PROVIDERS.anthropic.modelPlaceholder },
      openai: { baseUrl: '', apiKey: '', model: PROVIDERS.openai.modelPlaceholder },
      'local-openai': { baseUrl: PROVIDERS['local-openai'].urlPlaceholder, apiKey: '', model: '' },
      'local-bridge': { baseUrl: PROVIDERS['local-bridge'].urlPlaceholder, apiKey: '', model: '' },
    },
  };
}

/** Stored settings merged over the defaults, so a provider added later still has fields. */
export function mergeSettings(raw: unknown): ChatSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<ChatSettings>;
  const provider = PROVIDER_ORDER.includes(r.provider as ChatProviderId) ? (r.provider as ChatProviderId) : d.provider;
  for (const id of PROVIDER_ORDER) {
    const p = (r.providers as any)?.[id];
    if (p && typeof p === 'object') {
      for (const k of ['baseUrl', 'apiKey', 'model'] as const) if (typeof p[k] === 'string') d.providers[id][k] = p[k];
    }
  }
  return { provider, providers: d.providers };
}

export const SYSTEM_PROMPT = `You are a writing and LaTeX assistant inside Aldine, a collaborative LaTeX editor.
The user may share text they selected in their document, quoted with its file name and line numbers.
When you propose a replacement for the selected text, put the complete replacement LaTeX in a single fenced code block so it can be applied as is, and keep any explanation short and outside the block.
Answer concisely.`;

/** What one user turn says to the model: the selection (if any), then the question. */
export function userTurnText(m: ChatMessage): string {
  if (!m.context) return m.content;
  const c = m.context;
  const lines = c.fromLine === c.toLine ? `line ${c.fromLine}` : `lines ${c.fromLine}–${c.toLine}`;
  return `Selected text from ${c.file} (${lines}):\n\`\`\`latex\n${c.text}\n\`\`\`\n\n${m.content}`;
}

/** The conversation as the providers take it: failed answers dropped,
 *  consecutive turns of one role merged so roles alternate. */
export function apiMessages(history: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of history) {
    if (m.role === 'assistant' && (m.error || !m.content.trim())) continue;
    const content = m.role === 'user' ? userTurnText(m) : m.content;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** The whole conversation as one prompt, for the Claude Code bridge (one-shot `claude -p`). */
export function transcriptPrompt(history: ChatMessage[]): string {
  const msgs = apiMessages(history);
  const last = msgs.pop();
  const earlier = msgs.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`).join('\n\n');
  return `${SYSTEM_PROMPT}\n\n${earlier ? `Conversation so far:\n\n${earlier}\n\n` : ''}Answer this message. Do not modify any files.\n\n${last?.content ?? ''}`;
}

/** The text an answer applies: its first fenced block when it has one, else all of it. */
export function applicableText(answer: string): string {
  const m = answer.match(/```[^\n]*\n([\s\S]*?)```/);
  return (m ? m[1] : answer).replace(/\n$/, '');
}

/** Fenced code split from prose, for rendering. */
export function splitFences(text: string): Array<{ code: boolean; lang?: string; text: string }> {
  const parts: Array<{ code: boolean; lang?: string; text: string }> = [];
  const re = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) parts.push({ code: false, text: text.slice(at, m.index) });
    parts.push({ code: true, lang: m[1].trim() || undefined, text: m[2].replace(/\n$/, '') });
    at = re.lastIndex;
    if (m[0].length === 0) break;
  }
  if (at < text.length) parts.push({ code: false, text: text.slice(at) });
  return parts;
}

/** Each complete line of a byte stream, the trailing partial one included at the end. */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
      }
      if (done) break;
    }
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}

/** Server-sent events' `data:` payloads (multi-line data joined). */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const line of lines(body)) {
    if (line === '') { if (data.length) yield data.join('\n'); data = []; }
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length) yield data.join('\n');
}

export interface StreamHandlers {
  onDelta(text: string): void;
  /** Progress that is not answer text (the bridge's tool calls). */
  onStatus?(status: string): void;
}

async function errorOf(res: Response, fallback: string): Promise<Error> {
  let msg = `${fallback} (HTTP ${res.status})`;
  try {
    const text = await res.text();
    try { const j = JSON.parse(text); msg = j?.error?.message || j?.error || j?.detail || msg; } catch { if (text.trim()) msg = `${fallback}: ${text.trim().slice(0, 300)}`; }
  } catch { /* keep */ }
  return new Error(String(msg));
}

/** Claude or OpenAI-compatible, through the server. */
async function streamViaServer(projectId: string, provider: 'anthropic' | 'openai', s: ProviderSettings, history: ChatMessage[], h: StreamHandlers, signal: AbortSignal) {
  const res = await fetch(withBase(`/api/projects/${encodeURIComponent(projectId)}/ai/chat`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, baseUrl: s.baseUrl.trim(), apiKey: s.apiKey.trim(), model: s.model.trim(), system: SYSTEM_PROMPT, messages: apiMessages(history) }),
    signal,
  });
  if (!res.ok || !res.body) throw await errorOf(res, 'The chat request failed');
  let finished = false;
  for await (const line of lines(res.body)) {
    if (!line.trim()) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (typeof j.delta === 'string') h.onDelta(j.delta);
    else if (j.error) throw new Error(String(j.error));
    else if (j.done) finished = true;
  }
  if (!finished && !signal.aborted) throw new Error('The answer stopped before it finished');
}

/** An OpenAI-compatible server on the user's computer (Ollama, LM Studio, llama.cpp, vLLM). */
async function streamLocalOpenAI(s: ProviderSettings, history: ChatMessage[], h: StreamHandlers, signal: AbortSignal) {
  const base = (s.baseUrl.trim() || PROVIDERS['local-openai'].urlPlaceholder).replace(/\/+$/, '');
  const model = s.model.trim();
  if (!model) throw new Error('Choose a model in the chat settings (for Ollama, a name from `ollama list`)');
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(s.apiKey.trim() ? { authorization: `Bearer ${s.apiKey.trim()}` } : {}) },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...apiMessages(history)] }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(`Could not reach ${base}. Check that the local server is running and allows requests from this page (for Ollama, start it with OLLAMA_ORIGINS=*).`);
  }
  if (!res.ok || !res.body) throw await errorOf(res, 'The local model refused the request');
  for await (const data of sseData(res.body)) {
    if (data === '[DONE]') break;
    let j: any;
    try { j = JSON.parse(data); } catch { continue; }
    if (j?.error) throw new Error(String(j.error.message || j.error));
    const c = j?.choices?.[0]?.delta?.content;
    if (typeof c === 'string' && c) h.onDelta(c);
  }
}

/** The read_paper bridge (bridge/server.py): runs the local `claude` CLI and streams NDJSON events. */
async function streamLocalBridge(s: ProviderSettings, history: ChatMessage[], h: StreamHandlers, signal: AbortSignal) {
  const base = (s.baseUrl.trim() || PROVIDERS['local-bridge'].urlPlaceholder).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: transcriptPrompt(history), ...(s.model.trim() ? { model: s.model.trim() } : {}) }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(`Could not reach the Claude Code bridge at ${base}. Start it with bridge/install.sh from read_paper, or run python3 bridge/server.py.`);
  }
  if (!res.ok || !res.body) throw await errorOf(res, 'The bridge refused the request');
  let answered = false;
  let tools = 0;
  for await (const line of lines(res.body)) {
    if (!line.trim()) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.bridge === 'error') throw new Error(String(j.message || 'The bridge reported an error'));
    if (j.bridge === 'done') continue;
    if (j.type === 'item.started') {
      tools += 1;
      const it = j.item || {};
      h.onStatus?.(`Running ${it.name || (it.type === 'web_search' ? 'web search' : 'a command')} (${tools} tool call${tools === 1 ? '' : 's'})`);
    } else if (j.type === 'agent_message' && typeof j.text === 'string') {
      answered = true;
      h.onDelta(j.text);
    }
  }
  if (!answered && !signal.aborted) throw new Error('The bridge finished without an answer');
}

export async function bridgeHealth(baseUrl: string): Promise<{ ok: boolean; claude: string | null }> {
  const base = (baseUrl.trim() || PROVIDERS['local-bridge'].urlPlaceholder).replace(/\/+$/, '');
  const res = await fetch(`${base}/health`);
  const j = await res.json();
  return { ok: !!j.ok, claude: j.claude ?? null };
}

export function streamChat(projectId: string, settings: ChatSettings, history: ChatMessage[], h: StreamHandlers, signal: AbortSignal): Promise<void> {
  const s = settings.providers[settings.provider];
  switch (settings.provider) {
    case 'anthropic':
    case 'openai':
      return streamViaServer(projectId, settings.provider, s, history, h, signal);
    case 'local-openai':
      return streamLocalOpenAI(s, history, h, signal);
    case 'local-bridge':
      return streamLocalBridge(s, history, h, signal);
  }
}
