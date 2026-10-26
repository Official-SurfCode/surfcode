import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import stripAnsi from 'strip-ansi';
import { getStoredKey, mask, removeProviderKey, saveProviderKey } from '../src/core/auth.js';
import {
  loadCatalog,
  providerById,
  recommendedModel,
  allModels
} from '../src/core/catalog.js';
import {
  defaultConfig,
  loadConfig,
  readConfigValue,
  updateConfigPath
} from '../src/core/config.js';
import { ensurePaths, getPaths, writeFileAtomic } from '../src/core/paths.js';
import { resolveSelection } from '../src/core/provider.js';
import {
  createSession,
  deleteSession,
  latestSession,
  listSessions,
  loadSession,
  saveSession
} from '../src/core/session.js';
import type { ChatMessage } from '../src/core/types.js';
import { costForUsage, emptyUsage, formatCost, formatTokens } from '../src/core/usage.js';
import { prepareStartup } from '../src/cli/util.js';
import { renderLive, renderTimeline } from '../src/tui/render.js';
import { getTheme } from '../src/tui/theme.js';
import { timelineFromMessages, type LiveMessage, type TimelineItem } from '../src/tui/types.js';

const home = await mkdtemp(join(tmpdir(), 'surfcode-core-'));

before(() => {
  process.env.SURFCODE_HOME = home;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

test('bundled catalog has providers, models, and local servers', async () => {
  const catalog = await loadCatalog();
  assert.ok(catalog.providers.length >= 200, `expected 200+ providers, got ${catalog.providers.length}`);
  assert.ok(allModels(catalog).length >= 8000, 'expected a large model catalog');
  const anthropic = providerById(catalog, 'anthropic');
  assert.ok(anthropic);
  const recommended = recommendedModel(anthropic);
  assert.ok(recommended);
  assert.equal(recommended.tool_call, true);
  assert.ok(providerById(catalog, 'ollama')?.local);
});

test('custom providers resolve their endpoint and keyless setting', async () => {
  const config = defaultConfig();
  config.customProviders.localmock = {
    name: 'Local Mock',
    baseURL: 'http://127.0.0.1:4321/v1',
    keyless: true,
    models: [{ id: 'local-model', name: 'Local Model', tool_call: true, context: 32_000, output: 4096 }]
  };
  const catalog = await loadCatalog(config);
  const selection = await resolveSelection(catalog, config, {
    provider: 'localmock',
    model: 'local-model'
  });
  assert.equal(selection.provider.dialect, 'openai');
  assert.equal(selection.provider.baseURL, 'http://127.0.0.1:4321/v1');
  assert.equal(selection.provider.keyless, true);
  assert.equal(selection.model.contextWindow, 32_000);
});

test('an explicit provider chooses that provider\'s model', async () => {
  const config = defaultConfig();
  config.provider = 'openai';
  config.model = 'gpt-5.6';
  config.customProviders.localmock = {
    name: 'Local Mock',
    baseURL: 'http://127.0.0.1:4321/v1',
    keyless: true,
    models: [{ id: 'local-model', name: 'Local Model', tool_call: true, context: 32_000, output: 4096 }]
  };
  const catalog = await loadCatalog(config);
  const prepared = await prepareStartup({
    config,
    catalog,
    provider: 'localmock'
  });
  assert.equal(prepared.config.provider, 'localmock');
  assert.equal(prepared.config.model, 'local-model');
  assert.equal(prepared.autoSelected, false);
});

test('provider/model CLI references select the provider without breaking slash model ids', async () => {
  const catalog = await loadCatalog();

  const googleConfig = defaultConfig();
  googleConfig.provider = 'google';
  googleConfig.model = 'gemini-3.1-flash-lite';
  const sameProvider = await prepareStartup({
    config: googleConfig,
    catalog,
    model: 'google/gemini-3.5-flash-lite'
  });
  assert.equal(sameProvider.config.provider, 'google');
  assert.equal(sameProvider.config.model, 'gemini-3.5-flash-lite');

  const crossProvider = await prepareStartup({
    config: googleConfig,
    catalog,
    model: 'openrouter/anthropic/claude-sonnet-5'
  });
  assert.equal(crossProvider.config.provider, 'openrouter');
  assert.equal(crossProvider.config.model, 'anthropic/claude-sonnet-5');

  const openrouterConfig = defaultConfig();
  openrouterConfig.provider = 'openrouter';
  openrouterConfig.model = 'anthropic/claude-sonnet-5';
  const slashModel = await prepareStartup({
    config: openrouterConfig,
    catalog,
    model: 'anthropic/claude-sonnet-5'
  });
  assert.equal(slashModel.config.provider, 'openrouter');
  assert.equal(slashModel.config.model, 'anthropic/claude-sonnet-5');

  const explicit = await prepareStartup({
    config: googleConfig,
    catalog,
    provider: 'openrouter',
    model: 'openrouter/anthropic/claude-sonnet-5'
  });
  assert.equal(explicit.config.provider, 'openrouter');
  assert.equal(explicit.config.model, 'anthropic/claude-sonnet-5');
});

test('known providers resolve official endpoints and stored credentials', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-value';
  try {
    const config = defaultConfig();
    const catalog = await loadCatalog(config);
    const openai = providerById(catalog, 'openai');
    assert.ok(openai);
    const model = recommendedModel(openai);
    assert.ok(model);
    const selection = await resolveSelection(catalog, config, {
      provider: 'openai',
      model: model.id
    });
    assert.equal(selection.provider.baseURL, 'https://api.openai.com/v1');
    assert.equal(selection.provider.headers.authorization, 'Bearer sk-test-value');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('usage and cost accounting handles cache tokens', () => {
  const usage = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 0
  };
  const meta = { id: 'm', name: 'm', cost: { input: 2, output: 10, cache_read: 0.5 } };
  const openai = costForUsage(meta, usage, 'openai');
  assert.ok(Math.abs(openai - 0.0067) < 1e-9);
  const anthropic = costForUsage(meta, usage, 'anthropic');
  assert.ok(Math.abs(anthropic - 0.0071) < 1e-9);
  assert.equal(formatTokens(1_500_000), '1.5m');
  assert.equal(formatCost(0), '$0.00');
  assert.equal(emptyUsage().requests, 0);
});

test('config updates preserve JSONC comments and reject invalid values', async () => {
  const paths = await ensurePaths();
  await writeFileAtomic(
    paths.configFile,
    `{\n  // keep this comment\n  "theme": "aurora"\n}\n`
  );

  const updated = await updateConfigPath(['theme'], 'violet');
  assert.equal(updated.theme, 'violet');
  const raw = await readFile(paths.configFile, 'utf8');
  assert.match(raw, /keep this comment/);

  await updateConfigPath(['permissions', 'shell'], 'deny');
  const config = await loadConfig();
  assert.equal(config.permissions.shell, 'deny');
  assert.equal(readConfigValue(config, ['permissions', 'shell']), 'deny');

  await assert.rejects(
    () => updateConfigPath(['permissions', 'shell'], 'sometimes'),
    /invalid config/i
  );
  assert.equal((await loadConfig()).permissions.shell, 'deny');
});

test('sync env credentials opt in without copying the token to disk', async () => {
  process.env.SURFCODE_SYNC_URL = 'https://sync.example.test';
  process.env.SURFCODE_SYNC_TOKEN = 'env-only-sync-secret';
  try {
    const config = await loadConfig();
    assert.equal(config.sync.enabled, true);
    assert.equal(config.sync.url, 'https://sync.example.test');
    assert.equal(config.sync.token, 'env-only-sync-secret');

    await updateConfigPath(['sync', 'cursor'], 7);
    const raw = await readFile(getPaths().configFile, 'utf8');
    assert.doesNotMatch(raw, /env-only-sync-secret/);
    assert.match(raw, /"cursor":\s*7/);
  } finally {
    delete process.env.SURFCODE_SYNC_URL;
    delete process.env.SURFCODE_SYNC_TOKEN;
  }
});

test('auth keys are stored privately and can be removed', async () => {
  await saveProviderKey('example', 'sk-example-secret');
  assert.equal(await getStoredKey('example'), 'sk-example-secret');
  assert.equal(mask('sk-example-secret'), 'sk-e…cret');
  const info = await stat(getPaths().authFile);
  if (process.platform !== 'win32') {
    assert.equal(info.mode & 0o077, 0, 'auth.json must not be group/world readable');
  }
  assert.equal(await removeProviderKey('example'), true);
  assert.equal(await getStoredKey('example'), undefined);
});

test('sessions save, list, load by prefix, and delete', async () => {
  const session = createSession({
    cwd: '/tmp/surfcode-workspace',
    provider: 'mock',
    model: 'mock-chat',
    mode: 'build'
  });
  session.messages.push(
    { role: 'user', content: 'Fix the parser in src/parser.ts' },
    { role: 'assistant', content: 'Done. The parser now handles trailing commas.' }
  );
  await saveSession(session);

  const latest = await latestSession('/tmp/surfcode-workspace');
  assert.equal(latest?.id, session.id);
  assert.match(latest?.title ?? '', /Fix the parser/);

  const listed = await listSessions({ cwd: '/tmp/surfcode-workspace' });
  assert.equal(listed.length, 1);

  const loaded = await loadSession(session.id.slice(0, 12));
  assert.equal(loaded?.messages.length, 2);

  assert.equal(await deleteSession(session.id), true);
  assert.equal(await loadSession(session.id), undefined);
});

test('timeline keeps preamble, tools, and the final answer in order', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'read hello.txt' },
    {
      role: 'assistant',
      content: 'Let me read it.',
      toolCalls: [
        { id: 'call_1', name: 'read', arguments: { path: 'hello.txt' } }
      ]
    },
    {
      role: 'tool',
      toolCallId: 'call_1',
      name: 'read',
      content: 'hello.txt (1 lines)\n1│ hello'
    },
    { role: 'assistant', content: 'It says hello.' }
  ];

  const timeline = timelineFromMessages(messages);
  assert.equal(timeline.length, 2);
  const assistant = timeline[1]!;
  assert.equal(assistant.preamble, 'Let me read it.');
  assert.equal(assistant.content, 'It says hello.');
  assert.equal(assistant.toolViews?.length, 1);

  const rendered = stripAnsi(
    renderTimeline(timeline, 80, getTheme('aurora'), {
      showReasoning: false,
      verboseTools: false,
      spinner: '⠋'
    }).join('\n')
  );
  const preambleAt = rendered.indexOf('Let me read it.');
  const toolAt = rendered.indexOf('✓ read');
  const answerAt = rendered.indexOf('It says hello.');
  assert.ok(preambleAt >= 0 && toolAt > preambleAt && answerAt > toolAt, rendered);
});

test('live rendering shows tools between preamble and streamed answer', () => {
  const live: LiveMessage = {
    content: 'It says hello.',
    preamble: 'Let me read it.',
    reasoning: '',
    tools: [
      {
        call: { id: 'call_1', name: 'read', arguments: { path: 'hello.txt' } },
        result: { output: 'hello', display: { summary: '1 line' } },
        durationMs: 4,
        pending: false
      }
    ],
    startedAt: Date.now() - 500,
    thinkingMs: 0,
    step: 1,
    phase: 'writing'
  };
  const rendered = stripAnsi(
    renderLive(live, 80, getTheme('aurora'), {
      showReasoning: false,
      verboseTools: false,
      spinner: '⠋'
    }).join('\n')
  );
  const preambleAt = rendered.indexOf('Let me read it.');
  const toolAt = rendered.indexOf('✓ read');
  const answerAt = rendered.indexOf('It says hello.');
  assert.ok(preambleAt >= 0 && toolAt > preambleAt && answerAt > toolAt, rendered);
});

test('live rendering hides partial text when streaming is disabled', () => {
  const live: LiveMessage = {
    content: 'partial answer that should stay hidden',
    preamble: 'partial preamble',
    reasoning: 'partial reasoning',
    tools: [],
    startedAt: Date.now() - 500,
    thinkingMs: 0,
    step: 1,
    phase: 'writing'
  };
  const rendered = stripAnsi(
    renderLive(live, 80, getTheme('aurora'), {
      showReasoning: true,
      verboseTools: false,
      spinner: '⠋',
      streaming: false
    }).join('\n')
  );
  assert.doesNotMatch(rendered, /partial/);
  assert.match(rendered, /composing reply/);
});

test('live rendering never leaks reasoning while thinking text is hidden', () => {
  const live: LiveMessage = {
    content: '',
    reasoning: 'SECRET_PLAN: inspect the vault and hide the evidence',
    tools: [],
    startedAt: Date.now() - 500,
    thinkingMs: 0,
    step: 1,
    phase: 'thinking'
  };
  const hidden = stripAnsi(
    renderLive(live, 80, getTheme('aurora'), {
      showReasoning: false,
      verboseTools: false,
      spinner: '⠋',
      streaming: true
    }).join('\n')
  );
  assert.doesNotMatch(hidden, /SECRET_PLAN|inspect the vault/);
  assert.match(hidden, /thinking/);

  const shown = stripAnsi(
    renderLive(live, 80, getTheme('aurora'), {
      showReasoning: true,
      verboseTools: false,
      spinner: '⠋',
      streaming: true
    }).join('\n')
  );
  assert.match(shown, /SECRET_PLAN/);
});

test('timeline hides stored reasoning unless thinking text is enabled', () => {
  const item: TimelineItem = {
    id: 'item_reasoning',
    type: 'assistant',
    content: 'The answer is ready.',
    reasoning: 'SECRET_PLAN: inspect the vault and hide the evidence'
  };
  const hidden = stripAnsi(
    renderTimeline([item], 80, getTheme('aurora'), {
      showReasoning: false,
      verboseTools: false,
      spinner: '⠋'
    }).join('\n')
  );
  assert.doesNotMatch(hidden, /SECRET_PLAN|inspect the vault/);
  assert.match(hidden, /thought process hidden/);
  assert.match(hidden, /The answer is ready\./);

  const shown = stripAnsi(
    renderTimeline([item], 80, getTheme('aurora'), {
      showReasoning: true,
      verboseTools: false,
      spinner: '⠋'
    }).join('\n')
  );
  assert.match(shown, /SECRET_PLAN/);
});

