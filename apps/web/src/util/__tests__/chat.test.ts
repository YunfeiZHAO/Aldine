import { describe, expect, it } from 'vitest';
import { apiMessages, applicableText, bridgeToolStatus, lines, mergeSettings, splitFences, sseData, transcriptPrompt, type ChatMessage } from '../chat';

const stream = (chunks: string[]) => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
};
const collect = async (it: AsyncGenerator<string>) => { const out: string[] = []; for await (const x of it) out.push(x); return out; };

const ctx = { file: 'main.tex', from: 10, to: 20, fromLine: 3, toLine: 4, text: 'Hello world' };

describe('chat messages', () => {
  it('quotes the selection before the question', () => {
    const [m] = apiMessages([{ id: '1', role: 'user', content: 'Tighten this', context: ctx }]);
    expect(m.role).toBe('user');
    expect(m.content).toContain('Selected text from main.tex (lines 3–4)');
    expect(m.content).toContain('```latex\nHello world\n```');
    expect(m.content.endsWith('Tighten this')).toBe(true);
  });

  it('drops failed answers and merges turns so roles alternate', () => {
    const h: ChatMessage[] = [
      { id: '1', role: 'user', content: 'a' },
      { id: '2', role: 'assistant', content: '', error: 'HTTP 401' },
      { id: '3', role: 'user', content: 'b' },
      { id: '4', role: 'assistant', content: 'ok' },
      { id: '5', role: 'user', content: 'c' },
    ];
    expect(apiMessages(h)).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'c' },
    ]);
  });

  it('puts the whole conversation into one bridge prompt, the last message last', () => {
    const p = transcriptPrompt([{ id: '1', role: 'user', content: 'first' }, { id: '2', role: 'assistant', content: 'reply' }, { id: '3', role: 'user', content: 'second' }]);
    expect(p).toContain('User:\nfirst');
    expect(p).toContain('Assistant:\nreply');
    expect(p.trimEnd().endsWith('second')).toBe(true);
  });

  it('tells the bridge not to edit unless it was given the project', () => {
    const h: ChatMessage[] = [{ id: '1', role: 'user', content: 'Fix the typo' }];
    expect(transcriptPrompt(h)).toContain('Do not modify any files.');
    const editing = transcriptPrompt(h, true);
    expect(editing).not.toContain('Do not modify any files.');
    expect(editing).toContain('edit_file');
  });
});

describe('bridge tool progress', () => {
  it('names the Aldine tool and the file it touches', () => {
    expect(bridgeToolStatus({ type: 'tool_use', name: 'mcp__aldine__edit_file', command: '{"path": "sections/intro.tex", "edits": []}' })).toBe('Editing sections/intro.tex');
    expect(bridgeToolStatus({ type: 'tool_use', name: 'mcp__aldine__read_file', command: '{"path": "main.tex"}' })).toBe('Reading main.tex');
    expect(bridgeToolStatus({ type: 'tool_use', name: 'mcp__aldine__compile', command: '{}' })).toBe('Compiling');
    expect(bridgeToolStatus({ type: 'tool_use', name: 'mcp__aldine__edit_file', command: '{"path": "main.tex", "edits": [{"quo' })).toBe('Editing');
    expect(bridgeToolStatus({ type: 'tool_use', name: 'mcp__aldine__get_pdf_url' })).toBe('Running get pdf url');
    expect(bridgeToolStatus({ type: 'tool_use', name: 'Skill' })).toBe('Using a skill');
    expect(bridgeToolStatus({ type: 'command_execution', name: 'Bash' })).toBe('Running a command');
  });
});

describe('answers', () => {
  it('applies the first fenced block, or the whole answer without one', () => {
    expect(applicableText('Here:\n```latex\n\\textbf{x}\n```\nDone.')).toBe('\\textbf{x}');
    expect(applicableText('Just text')).toBe('Just text');
  });

  it('splits prose from code, an unclosed block included while streaming', () => {
    expect(splitFences('a\n```tex\nb\n```\nc')).toEqual([
      { code: false, text: 'a\n' }, { code: true, lang: 'tex', text: 'b' }, { code: false, text: '\nc' },
    ]);
    expect(splitFences('x\n```\npartial')).toEqual([{ code: false, text: 'x\n' }, { code: true, lang: undefined, text: 'partial' }]);
  });
});

describe('streams', () => {
  it('reads lines across chunk boundaries', async () => {
    expect(await collect(lines(stream(['{"a":', '1}\n{"b"', ':2}\r\n', 'tail'])))).toEqual(['{"a":1}', '{"b":2}', 'tail']);
  });

  it('reads SSE data payloads', async () => {
    expect(await collect(sseData(stream(['data: one\n\n', 'event: x\ndata: two\ndata: lines\n\n', 'data: [DONE]\n\n'])))).toEqual(['one', 'two\nlines', '[DONE]']);
  });
});

describe('settings', () => {
  it('fills missing providers and ignores junk', () => {
    const s = mergeSettings({ provider: 'local-openai', providers: { 'local-openai': { model: 'llama3.2', apiKey: 5 } } });
    expect(s.provider).toBe('local-openai');
    expect(s.providers['local-openai'].model).toBe('llama3.2');
    expect(s.providers['local-openai'].apiKey).toBe('');
    expect(s.providers.anthropic.model).toBeTruthy();
    expect(mergeSettings({ provider: 'nope' }).provider).toBe('anthropic');
  });
});
