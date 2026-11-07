import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

const MOCK = Number(process.env.E2E_MOCK_PORT || 4919);
const SOURCE = '\\documentclass{article}\n\\begin{document}\nThe quick brown fox jumps over the lazy dog.\n\\end{document}\n';
const ANSWER_CODE = 'A swift auburn fox leaps over the idle hound.';

async function selectFoxLine(page: Page) {
  await page.locator('.cm-line', { hasText: 'quick brown fox' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
}

async function setUp(page: Page, provider: string, fields: { url?: string; key?: string; model?: string }) {
  await page.getByTestId('tab-chat').click();
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('chat-provider').selectOption(provider);
  if (fields.model !== undefined) await page.getByTestId('chat-model').fill(fields.model);
  await page.getByTestId('chat-settings-toggle').click();
  if (fields.url !== undefined) await page.getByTestId('chat-url').fill(fields.url);
  if (fields.key !== undefined) await page.getByTestId('chat-key').fill(fields.key);
  await page.getByTestId('chat-settings-toggle').click();
}

test.describe('sidebar chat', () => {
  let id: string;
  test.beforeEach(async ({ page, request }) => {
    id = await createProject(request, 'Chat');
    const res = await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: SOURCE } });
    expect(res.ok()).toBeTruthy();
    await page.addInitScript(() => { try { localStorage.removeItem('aldine.chat.settings'); } catch { /* none */ } });
    await openProject(page, id);
    await expect(page.locator('.cm-content')).toContainText('quick brown fox');
  });
  test.afterEach(async ({ request }) => { await cleanup(request, id); });

  test('Claude through the server: the selection goes along and Replace selection applies the answer', async ({ page }) => {
    await setUp(page, 'anthropic', { url: `http://localhost:${MOCK}`, key: 'chat-key', model: 'claude-test' });
    await selectFoxLine(page);
    await expect(page.getByTestId('chat-selection')).toContainText('main.tex · L3');

    await page.getByTestId('chat-input').fill('Make this more vivid');
    await page.getByTestId('chat-input').press('Enter');
    const answer = page.getByTestId('chat-answer').last();
    await expect(answer).toContainText('Saw the selection.');
    await expect(answer).toContainText(ANSWER_CODE);
    await expect(page.getByTestId('chat-user-message').last()).toContainText('main.tex · L3');

    await answer.getByTestId('chat-replace').click();
    await expect(page.locator('.cm-content')).toContainText(ANSWER_CODE);
    await expect(page.locator('.cm-content')).not.toContainText('quick brown fox');

    // The conversation survives a trip to another tab and a reload.
    await page.getByTestId('tab-files').click();
    await page.getByTestId('tab-chat').click();
    await expect(page.getByTestId('chat-answer')).toHaveCount(1);
    await page.reload();
    await page.getByTestId('tab-chat').click();
    await expect(page.getByTestId('chat-answer').last()).toContainText('Saw the selection.');

    await page.getByTestId('chat-clear').click();
    await expect(page.getByTestId('chat-answer')).toHaveCount(0);
  });

  test('a wrong key shows the provider error in the answer', async ({ page }) => {
    await setUp(page, 'anthropic', { url: `http://localhost:${MOCK}`, key: 'wrong-key', model: 'claude-test' });
    await page.getByTestId('chat-input').fill('Hello');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-error')).toContainText('HTTP 401');
    await expect(page.getByTestId('chat-error')).toContainText('Check the API key');
  });

  test('a local OpenAI-compatible model is called from the browser and Insert puts the code at the cursor', async ({ page }) => {
    const LOCAL = 'http://localhost:11999/v1';
    let sent: any = null;
    await page.route(`${LOCAL}/chat/completions`, async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      sent = route.request().postDataJSON();
      const chunks = ['Local ', 'answer:\n```latex\n', '\\emph{local}\n```'];
      const body = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body });
    });
    await setUp(page, 'local-openai', { url: LOCAL, model: 'llama-test' });
    await selectFoxLine(page);
    await expect(page.getByTestId('chat-selection')).toContainText('main.tex · L3');
    await page.getByTestId('chat-input').fill('Rewrite');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-answer').last()).toContainText('Local answer:');
    expect(sent.model).toBe('llama-test');
    expect(sent.stream).toBe(true);
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages.at(-1).content).toContain('quick brown fox');

    await page.locator('.cm-line', { hasText: '\\end{document}' }).click();
    await page.keyboard.press('Home');
    await page.getByTestId('chat-insert').click();
    await expect(page.locator('.cm-content')).toContainText('\\emph{local}\\end{document}');
  });

  async function mockBridge(page: Page, events: object[], health: object = { service: 'aldine', ok: true, claude: '9.9.9 (Claude Code)' }) {
    const BRIDGE = 'http://127.0.0.1:8766';
    const sent: { body: any } = { body: null };
    await page.route(`${BRIDGE}/**`, async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (req.url().endsWith('/health')) return route.fulfill({ headers: cors, json: health });
      if (req.url().endsWith('/models')) return route.fulfill({ headers: cors, json: { models: [{ id: '', label: 'Default (opus, your Claude Code setting)' }, { id: 'sonnet', label: 'Sonnet (latest)' }, { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }] } });
      sent.body = req.postDataJSON();
      await route.fulfill({ headers: { ...cors, 'content-type': 'application/x-ndjson' }, body: [...events, { bridge: 'done' }].map((l) => JSON.stringify(l)).join('\n') + '\n' });
    });
    return sent;
  }

  test('the local Claude Code bridge gets this project\'s MCP connector and reports its edits', async ({ page }) => {
    const sent = await mockBridge(page, [
      { type: 'item.started', item: { id: 't1', type: 'tool_use', name: 'mcp__aldine__read_file', command: '{"path": "main.tex"}' } },
      { type: 'item.completed', item: { id: 't1', type: 'tool_use', name: 'mcp__aldine__read_file', status: 'completed', aggregated_output: '{}' } },
      { type: 'item.started', item: { id: 't2', type: 'tool_use', name: 'mcp__aldine__edit_file', command: '{"path": "main.tex", "edits": []}' } },
      { type: 'item.completed', item: { id: 't2', type: 'tool_use', name: 'mcp__aldine__edit_file', status: 'completed', aggregated_output: '{"applied":1}' } },
      { type: 'agent_message', text: 'Bridge edited the fox line' },
    ]);
    await page.getByTestId('tab-chat').click();
    await page.getByTestId('chat-provider').selectOption('local-bridge');
    await page.getByTestId('chat-settings-toggle').click();
    await page.getByTestId('chat-bridge-check').click();
    await expect(page.getByTestId('chat-bridge-status')).toContainText('Connected · 9.9.9');
    const model = page.getByTestId('chat-model');
    await expect(model.locator('option')).toHaveText(['Default (opus, your Claude Code setting)', 'Sonnet (latest)', 'Claude Opus 5.5']);
    await model.selectOption('sonnet');
    await page.getByTestId('chat-input').fill('Make the fox line livelier');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-answer').last()).toContainText('Bridge edited the fox line');
    await expect(page.getByTestId('chat-step')).toHaveText(['Reading main.tex', 'Editing main.tex']);
    await expect(page.getByTestId('chat-notice')).toHaveCount(0);

    expect(sent.body.prompt).toContain('Make the fox line livelier');
    expect(sent.body.model).toBe('sonnet');
    expect(sent.body.prompt).not.toContain('Do not modify any files');
    expect(sent.body.aldine.projectId).toBe(id);
    expect(sent.body.aldine.activeFile).toBe('main.tex');
    expect(sent.body.aldine.token).toBe('aldine-e2e-mcp');
    expect(sent.body.aldine.mcpUrl).toMatch(/^https?:\/\/[^/]+\/mcp$/);
    const tools = await page.request.post(sent.body.aldine.mcpUrl, {
      headers: { authorization: `Bearer ${sent.body.aldine.token}`, accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(tools.ok(), 'the credential the bridge receives opens /mcp').toBe(true);
  });

  test('another local bridge on the URL (read_paper\'s) is refused before anything is sent', async ({ page }) => {
    const sent = await mockBridge(page, [{ type: 'agent_message', text: 'should not run' }], { ok: true, claude: '9.9.9 (Claude Code)' });
    await page.getByTestId('tab-chat').click();
    await page.getByTestId('chat-provider').selectOption('local-bridge');
    await page.getByTestId('chat-settings-toggle').click();
    await page.getByTestId('chat-bridge-check').click();
    await expect(page.getByTestId('chat-bridge-status')).toContainText('A different bridge answers here');
    await page.getByTestId('chat-input').fill('Hi bridge');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-error')).toContainText('is not the Aldine bridge');
    expect(sent.body).toBeNull();
  });

  test('a bridge that refuses this page\'s origin says so instead of "not running"', async ({ page }) => {
    await page.route('http://127.0.0.1:8766/**', (route) => route.fulfill({
      status: 403,
      headers: { 'access-control-allow-origin': '*' },
      json: { error: 'Origin http://example.test is not allowed. Re-run install.sh with ALDINE_BRIDGE_ORIGINS including it.' },
    }));
    await page.getByTestId('tab-chat').click();
    await page.getByTestId('chat-provider').selectOption('local-bridge');
    await page.getByTestId('chat-settings-toggle').click();
    await page.getByTestId('chat-bridge-check').click();
    await expect(page.getByTestId('chat-bridge-status')).toContainText('is not allowed');
    await page.getByTestId('chat-input').fill('Hi bridge');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-error')).toContainText('ALDINE_BRIDGE_ORIGINS');
  });

  test('without an MCP credential the bridge only chats, and the answer says why', async ({ page }) => {
    await page.route('**/api/projects/*/ai/bridge-token', (route) =>
      route.fulfill({ status: 409, json: { error: 'This server has no MCP connector, so Local Claude Code can only chat.' } }));
    const sent = await mockBridge(page, [{ type: 'agent_message', text: 'Just chatting' }]);
    await page.getByTestId('tab-chat').click();
    await page.getByTestId('chat-provider').selectOption('local-bridge');
    await page.getByTestId('chat-input').fill('Hi bridge');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-answer').last()).toContainText('Just chatting');
    await expect(page.getByTestId('chat-notice')).toContainText('no MCP connector');
    expect(sent.body.aldine).toBeUndefined();
    expect(sent.body.prompt).toContain('Do not modify any files');
  });
});
