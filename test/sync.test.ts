import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { saveProviderKey } from '../src/core/auth.js';
import { defaultConfig } from '../src/core/config.js';
import { SurfError } from '../src/core/errors.js';
import {
  createSession,
  deleteSession,
  loadSession,
  saveSession
} from '../src/core/session.js';
import { syncSessions } from '../src/core/sync.js';
import type { SurfConfig } from '../src/core/types.js';
import { startSyncServer, type RunningSyncServer } from '../src/sync/server.js';

const home = await mkdtemp(join(tmpdir(), 'surfcode-sync-'));
const serverData = join(home, 'server');
let server: RunningSyncServer;
let config: SurfConfig;
let sessionId = '';

before(async () => {
  process.env.SURFCODE_HOME = home;
  await saveProviderKey('openai', 'sk-super-secret-key');
  server = await startSyncServer({
    token: 'test-sync-token',
    port: 0,
    dataDir: serverData
  });
  config = defaultConfig();
  config.provider = 'openai';
  config.model = 'gpt-test';
  config.providers.openai = { apiKey: 'sk-super-secret-key' };
  config.sync = {
    url: server.url,
    token: 'test-sync-token',
    enabled: true,
    auto: false,
    cursor: 0
  };

  const session = createSession({
    cwd: '/tmp/surfcode-sync-workspace',
    provider: 'openai',
    model: 'gpt-test',
    mode: 'build'
  });
  session.messages.push(
    { role: 'user', content: 'Sync me between machines.' },
    { role: 'assistant', content: 'Only sessions leave this machine.' }
  );
  sessionId = session.id;
  await saveSession(session);
});

after(async () => {
  await server.close();
  await rm(home, { recursive: true, force: true });
});

test('sync pushes sessions and never uploads provider keys', async () => {
  assert.ok(server.url.startsWith('http://127.0.0.1:'));
  const result = await syncSessions({ config, direction: 'both' });
  config.sync.cursor = result.cursor;

  assert.equal(result.accepted, 1);
  assert.ok(result.cursor > 0);

  const store = await readFile(join(serverData, 'sessions.json'), 'utf8');
  assert.match(store, new RegExp(sessionId));
  assert.match(store, /Sync me between machines/);
  assert.doesNotMatch(store, /sk-super-secret-key/);
  assert.doesNotMatch(store, /test-sync-token/);
  assert.doesNotMatch(store, /"apiKey"/);
});

test('pull restores a missing session and advances the cursor', async () => {
  await deleteSession(sessionId);
  config.sync.cursor = 0;
  const pulled = await syncSessions({ config, direction: 'pull' });
  assert.equal(pulled.pulled, 1);

  const restored = await loadSession(sessionId);
  assert.ok(restored);
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[1]?.content, 'Only sessions leave this machine.');

  config.sync.cursor = pulled.cursor;
  const noop = await syncSessions({ config, direction: 'pull' });
  assert.equal(noop.pulled, 0);
});

test('last write wins and the token is enforced', async () => {
  const local = await loadSession(sessionId);
  assert.ok(local);
  local.messages.push({ role: 'assistant', content: 'A newer local edit wins.' });
  await saveSession(local);

  const pushed = await syncSessions({ config, direction: 'push' });
  assert.equal(pushed.accepted, 1);
  const store = await readFile(join(serverData, 'sessions.json'), 'utf8');
  assert.match(store, /A newer local edit wins/);

  await assert.rejects(
    () =>
      syncSessions({
        config: { ...config, sync: { ...config.sync, token: 'wrong-token' } },
        direction: 'pull'
      }),
    (error: unknown) => error instanceof SurfError && error.message.includes('401')
  );
});
