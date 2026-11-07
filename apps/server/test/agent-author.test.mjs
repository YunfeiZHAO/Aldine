/**
 * Who a chat/MCP write is credited to. The signed-in person is the commit
 * author (History shows their name); Claude is the committer, which is what
 * marks the commit as agent work (session review, revert metric, violet dot).
 * Pinned here: the split itself (the agent view only sees a commit whose
 * committer is Claude), operator mode falling back to Claude as author, a
 * person's checkpoint never counting as agent work, and two people's pending
 * agent edits in one debounce window each landing under their own name.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './assert.mjs';

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-agent-author-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.AUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { commitAgentWrite } = await import('../src/collab.ts');

const write = (id, rel, content) => store.writeFile(id, 'main', rel, content);
const headOf = async (id) => (await gitops.log(id, 'main', 1))[0];

// --- one person's chat write: author is the person, the commit is agent work
const p1 = await store.createProject('Attribution one');
write(p1.id, 'intro.tex', 'Intro, first draft.\n');
await gitops.commitAll(p1.id, 'main', 'seed');
write(p1.id, 'intro.tex', 'Intro, edited by the chat.\n');
const named = await gitops.withRepoLock(p1.id, () => gitops.commitAgentWriteHeld(p1.id, 'main', [
  { path: 'intro.tex', before: 'Intro, first draft.\n', after: 'Intro, edited by the chat.\n' },
], 'Sharpen the intro', 'Ada Lovelace'));
const top = await headOf(p1.id);
check(named.committed === true && top.hash === named.hash, 'the chat write lands as one commit');
check(top.author === 'Ada Lovelace', `the commit is credited to the signed-in person (got ${top.author})`);
check(top.agent === true, 'the commit is still marked as Claude\'s work');
const seen = await gitops.agentActivitySince(p1.id, 'main', null);
check(seen.commits.some((c) => c.hash === top.hash && c.message === 'Sharpen the intro'), 'the agent review lists it: Claude\'s committer is what it keys on');

// --- the same write through the server entry point, with no person (operator mode)
write(p1.id, 'intro.tex', 'Intro, operator edit.\n');
const op = await commitAgentWrite(p1.id, 'main', [
  { path: 'intro.tex', before: 'Intro, edited by the chat.\n', after: 'Intro, operator edit.\n' },
], 'Operator edit');
check(op.hash !== null, 'operator-mode write commits');
const opTop = await headOf(p1.id);
check(opTop.author === 'Claude' && opTop.agent === true, `operator mode has no person to credit, so Claude is the author (got ${opTop.author}, agent=${opTop.agent})`);

// --- a person's own checkpoint is not agent work
write(p1.id, 'notes.tex', 'Typed by a person.\n');
await gitops.withRepoLock(p1.id, () => gitops.commitAllHeld(p1.id, 'main', 'Checkpoint by hand', 'Ada Lovelace'));
const human = await headOf(p1.id);
check(human.author === 'Ada Lovelace' && human.agent === false, `a person's own checkpoint is not agent work (got ${human.author}, agent=${human.agent})`);

// --- commits from before the split (author Claude, no committer marker) still count
write(p1.id, 'legacy.tex', 'Written before the split.\n');
const legacy = await gitops.commitPaths(p1.id, 'main', ['legacy.tex'], 'Legacy agent commit', 'Claude');
check(legacy.committed === true, 'setup: legacy-style commit lands');
const legacyTop = await headOf(p1.id);
check(legacyTop.agent === true, 'a commit authored by Claude still reads as agent work');
const flags = await gitops.commitIsAgent(p1.id, [legacyTop.hash, human.hash]);
check(JSON.stringify(flags) === '[true,false]', `the revert metric sees agent and person commits apart (got ${JSON.stringify(flags)})`);

// --- two people's pending agent edits in one debounce window: one commit each
const p2 = await store.createProject('Attribution two');
write(p2.id, 'a.tex', 'seed a\n');
write(p2.id, 'b.tex', 'seed b\n');
await gitops.commitAll(p2.id, 'main', 'seed');
write(p2.id, 'a.tex', 'Ada wrote this.\n');
write(p2.id, 'b.tex', 'Grace wrote this.\n');
gitops.registerAttributedPaths(p2.id, 'main', 'Ada edit', 'Ada Lovelace', ['a.tex'], 'Claude');
gitops.registerAttributedPaths(p2.id, 'main', 'Grace edit', 'Grace Hopper', ['b.tex'], 'Claude');
await gitops.autoCommit(p2.id, 'main');
const two = await gitops.log(p2.id, 'main', 5);
const adaCommit = two.find((c) => c.message === 'Ada edit');
const graceCommit = two.find((c) => c.message === 'Grace edit');
check(adaCommit?.author === 'Ada Lovelace' && adaCommit.agent === true, `Ada's pending edit is credited to Ada (got ${JSON.stringify(adaCommit)})`);
check(graceCommit?.author === 'Grace Hopper' && graceCommit.agent === true, `Grace's pending edit is credited to Grace, not whoever wrote last (got ${JSON.stringify(graceCommit)})`);
const adaStat = adaCommit ? (await gitops.commitDiff(p2.id, adaCommit.hash)).stat : '';
check(adaStat.includes('a.tex') && !adaStat.includes('b.tex'), 'Ada\'s commit holds only her file');

console.log('agent-author: all checks passed');
