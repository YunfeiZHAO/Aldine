import { useEffect, useRef, useState } from 'react';
import type { PaneSelection } from './CodePane';
import { useToast } from './Toast';
import { IconX } from './Icons';
import { safeStorage } from '../util/safeStorage';
import {
  ChatContext, ChatMessage, ChatSettings, PROVIDERS, PROVIDER_ORDER,
  applicableText, bridgeHealth, mergeSettings, splitFences, streamChat,
} from '../util/chat';

/** Endpoints, keys and models, this browser only. */
const SETTINGS_KEY = 'aldine.chat.settings';
const historyKey = (projectId: string) => `aldine.chat.history.${projectId}`;
/** Kept per project; older turns fall off so the store stays under quota. */
const HISTORY_MAX = 100;

interface Props {
  projectId: string;
  activeFile: string | null;
  selection: PaneSelection | null;
  visible: boolean;
  onBusy(busy: boolean): void;
  insertAtCursor(text: string): void;
  /** False when the selected text has changed since it was sent. */
  replaceRange(ctx: ChatContext, text: string): boolean;
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function lineLabel(c: { fromLine: number; toLine: number }) {
  return c.fromLine === c.toLine ? `L${c.fromLine}` : `L${c.fromLine}–${c.toLine}`;
}

function Answer({ text }: { text: string }) {
  return (
    <>
      {splitFences(text).map((p, i) => p.code
        ? <pre key={i} className="chat__code"><code>{p.text}</code></pre>
        : <div key={i} className="chat__prose">{p.text}</div>)}
    </>
  );
}

export default function ChatPanel({ projectId, activeFile, selection, visible, onBusy, insertAtCursor, replaceRange }: Props) {
  const toast = useToast();
  const [settings, setSettings] = useState<ChatSettings>(() => mergeSettings(safeStorage.getJSON(SETTINGS_KEY, null)));
  const [history, setHistory] = useState<ChatMessage[]>(() => safeStorage.getJSON<ChatMessage[]>(historyKey(projectId), [], (v): v is ChatMessage[] => Array.isArray(v)));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [includeSel, setIncludeSel] = useState(true);
  const [bridge, setBridge] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const provider = settings.provider;
  const info = PROVIDERS[provider];
  const ps = settings.providers[provider];
  const needsSetup = (info.needsKey && !ps.apiKey.trim()) || (!info.local && !ps.model.trim()) || (provider === 'local-openai' && !ps.model.trim());

  useEffect(() => { safeStorage.setJSON(SETTINGS_KEY, settings); }, [settings]);
  useEffect(() => {
    if (!busy) safeStorage.setJSON(historyKey(projectId), history.slice(-HISTORY_MAX));
  }, [history, busy, projectId]);
  // A new selection is offered again even after the last one was dismissed.
  useEffect(() => { setIncludeSel(true); }, [selection?.from, selection?.to, activeFile]);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, visible]);
  useEffect(() => { if (visible && !needsSetup) inputRef.current?.focus(); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const setProviderField = (k: 'baseUrl' | 'apiKey' | 'model', v: string) =>
    setSettings((s) => ({ ...s, providers: { ...s.providers, [s.provider]: { ...s.providers[s.provider], [k]: v } } }));

  const context: ChatContext | undefined = includeSel && selection && activeFile
    ? { file: activeFile, from: selection.from, to: selection.to, fromLine: selection.fromLine, toLine: selection.toLine, text: selection.text }
    : undefined;

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (needsSetup) { setShowSettings(true); return; }
    const user: ChatMessage = { id: newId(), role: 'user', content: text, ...(context ? { context } : {}) };
    const answer: ChatMessage = { id: newId(), role: 'assistant', content: '', via: `${info.label}${ps.model.trim() ? ` · ${ps.model.trim()}` : ''}` };
    const turns = [...history, user];
    setHistory([...turns, answer]);
    setDraft('');
    setIncludeSel(false);
    setBusy(true);
    setStatus('');
    const ac = new AbortController();
    abortRef.current = ac;
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setHistory((h) => h.map((m) => (m.id === answer.id ? fn(m) : m)));
    try {
      await streamChat(projectId, settings, turns, {
        onDelta: (d) => { setStatus(''); patch((m) => ({ ...m, content: m.content + d })); },
        onStatus: setStatus,
      }, ac.signal);
    } catch (err: any) {
      if (!ac.signal.aborted) patch((m) => ({ ...m, error: String(err?.message || err) }));
    } finally {
      if (ac.signal.aborted) patch((m) => (m.content ? m : { ...m, error: 'Stopped' }));
      abortRef.current = null;
      setBusy(false);
      setStatus('');
    }
  };

  const stop = () => abortRef.current?.abort();

  const clear = () => {
    stop();
    setHistory([]);
    safeStorage.remove(historyKey(projectId));
  };

  const checkBridge = async () => {
    setBridge('Checking…');
    try {
      const h = await bridgeHealth(ps.baseUrl);
      setBridge(h.ok ? `Connected${h.claude ? ` · ${h.claude}` : ''}` : 'The bridge is running but cannot find the claude CLI');
    } catch {
      setBridge('Not running');
    }
  };

  const contextFor = (i: number): ChatContext | undefined => {
    for (let j = i - 1; j >= 0; j--) if (history[j].role === 'user') return history[j].context;
    return undefined;
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('Copied the answer', 'ok'); }
    catch { toast('Could not copy: the browser blocked the clipboard', 'error'); }
  };

  const replace = (ctx: ChatContext, text: string) => {
    if (ctx.file !== activeFile) { toast(`Open ${ctx.file} to replace the selection`, 'error'); return; }
    if (replaceRange(ctx, text)) toast(`Replaced ${lineLabel(ctx)} in ${ctx.file}`, 'ok');
    else toast('The selected text has changed since you asked; select it again', 'error');
  };

  return (
    <div className="chat" data-testid="chat-panel">
      <div className="chat__bar">
        <select
          className="input chat__provider"
          value={provider}
          aria-label="Chat provider"
          data-testid="chat-provider"
          onChange={(e) => { setSettings((s) => ({ ...s, provider: e.target.value as ChatSettings['provider'] })); setBridge(null); }}
        >
          {PROVIDER_ORDER.map((id) => <option key={id} value={id}>{PROVIDERS[id].label}</option>)}
        </select>
        <input
          className="input chat__model"
          value={ps.model}
          placeholder={info.modelPlaceholder}
          aria-label="Model"
          data-testid="chat-model"
          onChange={(e) => setProviderField('model', e.target.value)}
        />
        <button
          className={`btn btn--ghost btn--small${showSettings ? ' chat__toggle--on' : ''}`}
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
          title="Endpoint and key for this provider"
          data-testid="chat-settings-toggle"
        >
          Settings
        </button>
      </div>

      {showSettings && (
        <div className="chat__settings" data-testid="chat-settings">
          <label className="field__label" htmlFor="chat-url">{info.local ? 'Address on this computer' : 'Base URL'}</label>
          <input id="chat-url" className="input" value={ps.baseUrl} placeholder={info.urlPlaceholder} onChange={(e) => setProviderField('baseUrl', e.target.value)} data-testid="chat-url" spellCheck={false} />
          {provider !== 'local-bridge' && (
            <>
              <label className="field__label" htmlFor="chat-key">API key{info.needsKey ? '' : ' (optional)'}</label>
              <input id="chat-key" className="input" type="password" autoComplete="off" value={ps.apiKey} onChange={(e) => setProviderField('apiKey', e.target.value)} data-testid="chat-key" spellCheck={false} />
            </>
          )}
          <p className="chat__hint">
            {info.local
              ? provider === 'local-bridge'
                ? 'Your browser talks to the read_paper bridge on this computer, which runs your local Claude Code. Nothing passes through the Aldine server.'
                : 'Your browser calls the model on this computer directly (Ollama, LM Studio, llama.cpp). The server must allow this page as an origin, e.g. OLLAMA_ORIGINS=*.'
              : 'Kept in this browser only. Each message is sent through the Aldine server to this endpoint; the server does not store the key.'}
          </p>
          {provider === 'local-bridge' && (
            <div className="chat__bridge">
              <button className="btn btn--small" onClick={checkBridge} data-testid="chat-bridge-check">Check connection</button>
              {bridge && <span className="chat__hint" data-testid="chat-bridge-status">{bridge}</span>}
            </div>
          )}
        </div>
      )}

      <div className="chat__list" ref={listRef} data-testid="chat-messages" aria-live="polite">
        {history.length === 0 && (
          <p className="chat__empty">Select text in the editor and ask about it, or ask anything about your document.</p>
        )}
        {history.map((m, i) => m.role === 'user' ? (
          <div key={m.id} className="chat__msg chat__msg--user" data-testid="chat-user-message">
            {m.context && <div className="chat__ctx" title={m.context.text}>{m.context.file} · {lineLabel(m.context)}</div>}
            <div className="chat__prose">{m.content}</div>
          </div>
        ) : (
          <div key={m.id} className="chat__msg chat__msg--assistant" data-testid="chat-answer">
            {m.via && <div className="chat__via">{m.via}</div>}
            {m.content && <Answer text={m.content} />}
            {!m.content && !m.error && busy && i === history.length - 1 && <div className="chat__status" data-testid="chat-status">{status || 'Thinking…'}</div>}
            {m.error && <div className="chat__error" role="alert" data-testid="chat-error">{m.error}</div>}
            {m.content && !(busy && i === history.length - 1) && (() => {
              const ctx = contextFor(i);
              const apply = applicableText(m.content);
              return (
                <div className="chat__actions">
                  <button className="btn btn--ghost btn--small" onClick={() => copy(m.content)} data-testid="chat-copy">Copy</button>
                  <button className="btn btn--ghost btn--small" onClick={() => insertAtCursor(apply)} disabled={!activeFile} title="Insert the answer's code (or the whole answer) at the cursor" data-testid="chat-insert">Insert</button>
                  {ctx && <button className="btn btn--ghost btn--small" onClick={() => replace(ctx, apply)} title={`Replace ${ctx.file} ${lineLabel(ctx)} with the answer's code`} data-testid="chat-replace">Replace selection</button>}
                </div>
              );
            })()}
          </div>
        ))}
      </div>

      <div className="chat__composer">
        {context ? (
          <div className="chat__chip" data-testid="chat-selection" title={context.text}>
            <span className="chat__chip-text">{context.file} · {lineLabel(context)} · {context.text.length} chars</span>
            <button className="chat__chip-x" onClick={() => setIncludeSel(false)} aria-label="Don't send the selection" data-testid="chat-selection-remove"><IconX /></button>
          </div>
        ) : (
          <div className="chat__chip chat__chip--none">{selection ? 'Selection not attached' : 'No text selected'}</div>
        )}
        <textarea
          ref={inputRef}
          className="input chat__input"
          rows={3}
          value={draft}
          placeholder={needsSetup ? `Set up ${info.label} in Settings first` : 'Ask about the selection… (Enter to send, Shift+Enter for a new line)'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
          aria-label="Message"
          data-testid="chat-input"
        />
        <div className="chat__send-row">
          <button className="btn btn--ghost btn--small" onClick={clear} disabled={history.length === 0} data-testid="chat-clear">Clear</button>
          {busy
            ? <button className="btn btn--small" onClick={stop} data-testid="chat-stop">Stop</button>
            : <button className="btn btn--primary btn--small" onClick={send} disabled={!draft.trim()} data-testid="chat-send">Send</button>}
        </div>
      </div>
    </div>
  );
}
