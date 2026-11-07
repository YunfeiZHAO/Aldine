/**
 * POST /api/projects/:id/ai/bridge-token with accounts: a short-lived token
 * scoped to the one project, earlier ones for that project revoked, refused
 * to outsiders and to access tokens, and the minted token actually resolves.
 *
 * Runs against the real route table (Fastify inject) on a throwaway JSON
 * datastore — env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-bridge-token-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_MCP = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PUBLIC_URL;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const bob = await auth.register('bob@example.com', 'password123', 'Bob');
const adaCookie = `aldine_session=${await auth.createSession(ada.id)}`;
const bobCookie = `aldine_session=${await auth.createSession(bob.id)}`;
const project = await store.createProject('Bridge', { 'main.tex': 'Hello.\n' }, ada.id);
const other = await store.createProject('Other', { 'main.tex': 'Other.\n' }, ada.id);

const issue = (id, headers) => app.inject({ method: 'POST', url: `/api/projects/${id}/ai/bridge-token`, headers: { host: 'latex.example.org', ...headers } });

const first = await issue(project.id, { cookie: adaCookie });
eq(first.statusCode, 200, 'the owner gets a bridge token');
const c1 = first.json();
eq(c1.mcpUrl, 'http://latex.example.org/mcp', 'the MCP URL is this instance\'s /mcp');
check(c1.token.startsWith('aldn_'), 'a personal access token');
const ttl = Date.parse(c1.expiresAt) - Date.now();
check(ttl > 11 * 3600e3 && ttl <= 12 * 3600e3, 'it expires in about 12 hours');

const hit = await auth.userFromToken(`Bearer ${c1.token}`);
eq(hit?.user.id, ada.id, 'the token resolves to the caller');
eq(hit?.tokenScope.projectIds, [project.id], 'scoped to this project only');

await issue(other.id, { cookie: adaCookie });
const second = (await issue(project.id, { cookie: adaCookie })).json();
check(second.token !== c1.token, 'a new token each time');
check((await auth.userFromToken(`Bearer ${c1.token}`)) === null, 'the earlier token for the project is revoked');
const live = (await auth.listAccessTokens(ada.id)).filter((t) => t.name === 'Local Claude Code (chat)');
eq(live.map((t) => t.projectIds[0]).sort(), [project.id, other.id].sort(), 'one live bridge token per project');

const outsider = await issue(project.id, { cookie: bobCookie });
check(outsider.statusCode === 403 || outsider.statusCode === 404, `a non-member is refused (got ${outsider.statusCode})`);
eq((await issue(project.id, {})).statusCode, 401, 'signed out is refused');
const viaToken = await issue(project.id, { authorization: `Bearer ${second.token}` });
eq(viaToken.statusCode, 403, 'an access token cannot mint more tokens');

process.env.ALDINE_MCP = '0';
const off = await issue(project.id, { cookie: adaCookie });
eq(off.statusCode, 409, 'without the MCP connector the bridge can only chat');
check(/ALDINE_MCP=1/.test(off.json().error), 'and the error names the setting');

console.log('ai-bridge-token: ok');
process.exit(0);
