import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { defaultConfig, saveConfig } from '../src/core/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(join(tmpdir(), 'surfcode-cli-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'surfcode-cli-work-'));
let server: Server;
let baseURL = '';
let requests = 0;

before(async () => {
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    let parsed: { messages?: Array<{ role?: string }> } = {};
    try {
      parsed = JSON.parse(body || '{}') as typeof parsed;
    } catch {
      parsed = {};
    }
    requests += 1;
    const hasTool = (parsed.messages ?? []).some((message) => message.role === 'tool');
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    if (!hasTool) {
      for (const delta of ['Let me ', 'read that.']) {
        send({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
        });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      }
      send({
        id: 'chatcmpl_test',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_read_1',
                  type: 'function',
                  function: { name: 'read', arguments: '{"path":"hello.txt"}' }
                }
              ]
            },
            finish_reason: null
          }
        ]
      });
      send({
        id: 'chatcmpl_test',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 120, completion_tokens: 18 }
      });
    } else {
      for (const delta of [
        'I read **hello.txt**. It looks friendly.\n\n',
        '### Next\n- Say hi back\n- Keep surfing'
      ]) {
        send({
          id: 'chatcmpl_test',
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
        });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      }
      send({
        id: 'chatcmpl_test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 180, completion_tokens: 32 }
      });
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${address.port}/v1`;

  process.env.SURFCODE_HOME = home;
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'hello.txt'), 'hello from the test workspace\n');

  const config = defaultConfig();
  config.provider = 'mock';
  config.model = 'mock-chat';
  config.permissions.read = 'allow';
  config.permissions.write = 'allow';
  config.permissions.shell = 'deny';
  config.customProviders.mock = {
    name: 'Mock',
    baseURL,
    keyless: true,
    models: [
      {
        id: 'mock-chat',
        name: 'Mock Chat',
        tool_call: true,
        context: 128_000,
        output: 8192
      }
    ]
  };
  await saveConfig(config);
});

after(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

test('headless JSON run streams events and saves a session', { timeout: 60_000 }, async () => {
  const started = requests;
  const result = await runCli(['run', '--yes', '--json', 'read hello.txt']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests, started + 2, 'mock should receive a tool round and a final round');

  const events = result.stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, any>);
  assert.equal(events.some((event) => event.type === 'error'), false, result.stderr);

  const sessionEvent = events.find((event) => event.type === 'session');
  assert.ok(sessionEvent?.sessionId);
  assert.equal(sessionEvent?.provider, 'mock');
  assert.equal(sessionEvent?.model, 'mock-chat');

  const toolStart = events.find((event) => event.type === 'tool_start');
  assert.equal(toolStart?.name, 'read');
  const toolResult = events.find((event) => event.type === 'tool_result');
  assert.equal(toolResult?.isError, false);
  assert.match(String(toolResult?.output), /hello from the test workspace/);

  const resultEvent = events.find((event) => event.type === 'result');
  assert.ok(resultEvent);
  assert.equal(resultEvent?.aborted, false);
  assert.match(String(resultEvent?.text), /It looks friendly/);
  assert.equal(resultEvent?.usage.inputTokens, 300);
  assert.equal(resultEvent?.usage.outputTokens, 50);

  const sessions = await runCli(['sessions', '--json']);
  assert.equal(sessions.code, 0, sessions.stderr);
  const listed = JSON.parse(sessions.stdout) as { sessions: Array<{ id: string }> };
  assert.ok(listed.sessions.some((session) => session.id === sessionEvent?.sessionId));
});

test('plain headless mode keeps stdout clean for piping', { timeout: 60_000 }, async () => {
  const result = await runCli(['run', '--yes', 'read hello.txt']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /It looks friendly/);
  assert.doesNotMatch(result.stdout, /◆ read/);
  assert.match(result.stderr, /read/);
});

test('config commands redact secrets', { timeout: 60_000 }, async () => {
  const set = await runCli([
    'config',
    'set',
    'providers.openai.apiKey',
    'sk-super-secret-value'
  ]);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /providers\.openai\.apiKey/);
  assert.match(set.stdout, /<redacted>/);
  assert.doesNotMatch(set.stdout, /sk-super-secret-value/);

  const raw = await readFile(join(home, 'config.json'), 'utf8');
  assert.match(raw, /sk-super-secret-value/);

  const get = await runCli(['config', 'get', 'providers.openai.apiKey']);
  assert.equal(get.code, 0, get.stderr);
  assert.equal(get.stdout.trim(), '<redacted>');

  const syncSet = await runCli(['config', 'set', 'sync.token', 'sync-secret-value']);
  assert.equal(syncSet.code, 0, syncSet.stderr);
  assert.match(syncSet.stdout, /<redacted>/);
  assert.doesNotMatch(syncSet.stdout, /sync-secret-value/);

  const show = await runCli(['config']);
  assert.equal(show.code, 0, show.stderr);
  assert.doesNotMatch(show.stdout, /sk-super-secret-value/);
  assert.doesNotMatch(show.stdout, /sync-secret-value/);
  assert.match(show.stdout, /<redacted>/);
});

test('inspection commands return useful JSON', { timeout: 60_000 }, async () => {
  const models = await runCli(['models', '--json', '--limit', '3']);
  assert.equal(models.code, 0, models.stderr);
  const modelData = JSON.parse(models.stdout) as { models: unknown[]; total: number };
  assert.equal(modelData.models.length, 3);
  assert.ok(modelData.total > 1000);

  const doctor = await runCli(['doctor', '--json']);
  assert.equal(doctor.code, 0, doctor.stderr);
  const doctorData = JSON.parse(doctor.stdout) as {
    ok: boolean;
    checks: Array<{ id: string; status: string }>;
  };
  assert.equal(doctorData.ok, true);
  assert.equal(doctorData.checks.find((check) => check.id === 'selection')?.status, 'ok');
});

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(root, 'src', 'cli.tsx'), '--cwd', workspace, ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          SURFCODE_HOME: home,
          NO_COLOR: '1',
          FORCE_COLOR: '0'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`surf ${args.join(' ')} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}
