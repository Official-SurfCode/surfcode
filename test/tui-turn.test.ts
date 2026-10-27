import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import App from '../src/tui/App.js';
import { loadCatalog } from '../src/core/catalog.js';
import { defaultConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import type { SurfConfig } from '../src/core/types.js';

const ANSWER = 'ONLY_ONE_REPLY';
const SECOND_ANSWER = 'SECOND_TURN_REPLY';

async function waitFor(
  app: ReturnType<typeof render>,
  predicate: (frame: string) => boolean,
  timeout = 8_000
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = stripAnsi(app.lastFrame() ?? '');
    if (predicate(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for the TUI frame:\n${stripAnsi(app.lastFrame() ?? '')}`);
}

async function type(app: ReturnType<typeof render>, text: string): Promise<void> {
  for (const character of text) {
    app.stdin.write(character);
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}

test('a completed turn hands the live message over to the timeline exactly once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'surfcode-tui-turn-'));
  const previousHome = process.env.SURFCODE_HOME;
  const previousFetch = globalThis.fetch;
  process.env.SURFCODE_HOME = home;

  const config: SurfConfig = {
    ...defaultConfig(),
    provider: 'mock',
    model: 'mock-model',
    theme: 'mono',
    mode: 'build',
    permissions: { read: 'allow', write: 'allow', shell: 'allow', fetch: 'allow' },
    customProviders: {
      mock: {
        name: 'Mock',
        baseURL: 'http://127.0.0.1:9/v1',
        dialect: 'openai',
        keyless: true,
        models: [{ id: 'mock-model', name: 'Mock Model', context: 128_000, output: 4096, tool_call: false }]
      }
    },
    sync: { enabled: false, auto: false, cursor: 0 }
  };

  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };
        send({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: ANSWER }, finish_reason: null }]
        });
        send({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  const catalog = await loadCatalog(config);
  const session = createSession({ cwd: home, provider: 'mock', model: 'mock-model', mode: 'build' });
  const app = render(
    React.createElement(App, {
      cwd: home,
      config,
      catalog,
      session,
      initialPrompt: 'reply once'
    })
  );

  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const frame = stripAnsi(app.lastFrame() ?? '');
      if (frame.includes(ANSWER) && frame.includes(' ready')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const frames = app.stdout.frames.map((frame) => stripAnsi(frame));
    const duplicates = frames.filter((frame) => frame.split(ANSWER).length - 1 > 1);
    assert.equal(
      duplicates.length,
      0,
      `assistant reply was painted twice in ${duplicates.length} frame(s):\n${duplicates[0] ?? ''}`
    );
    assert.equal(
      frames.filter((frame) => frame.split(ANSWER).length - 1 === 1).length > 0,
      true,
      'expected the assistant reply to appear in the transcript'
    );
    assert.equal(requests, 1);
  } finally {
    app.unmount();
    app.cleanup();
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.SURFCODE_HOME;
    else process.env.SURFCODE_HOME = previousHome;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('an empty MAX_TOKENS turn is explained and the next turn still works', async () => {
  const home = await mkdtemp(join(tmpdir(), 'surfcode-tui-empty-'));
  const previousHome = process.env.SURFCODE_HOME;
  const previousFetch = globalThis.fetch;
  process.env.SURFCODE_HOME = home;

  const config: SurfConfig = {
    ...defaultConfig(),
    provider: 'mock-google',
    model: 'mock-gemini',
    theme: 'mono',
    mode: 'build',
    permissions: { read: 'allow', write: 'allow', shell: 'allow', fetch: 'allow' },
    customProviders: {
      'mock-google': {
        name: 'Mock Google',
        baseURL: 'http://127.0.0.1:9',
        dialect: 'google',
        keyless: true,
        models: [
          {
            id: 'mock-gemini',
            name: 'Mock Gemini',
            context: 128_000,
            output: 65_536,
            tool_call: false,
            reasoning: true
          }
        ]
      }
    },
    sync: { enabled: false, auto: false, cursor: 0 }
  };

  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    const encoder = new TextEncoder();
    const payload =
      requests === 1
        ? {
            candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 0, thoughtsTokenCount: 96 }
          }
        : {
            candidates: [
              { content: { parts: [{ text: SECOND_ANSWER }] }, finishReason: 'STOP' }
            ]
          };
    return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  const catalog = await loadCatalog(config);
  const session = createSession({
    cwd: home,
    provider: 'mock-google',
    model: 'mock-gemini',
    mode: 'build'
  });
  const app = render(
    React.createElement(App, {
      cwd: home,
      config,
      catalog,
      session,
      initialPrompt: 'think hard'
    })
  );

  try {
    const first = await waitFor(
      app,
      (frame) => /output limit/i.test(frame) && frame.includes(' ready')
    );
    assert.match(first, /output limit/i);
    assert.equal(requests, 1);

    await type(app, 'try again');
    app.stdin.write('\r');
    const second = await waitFor(
      app,
      (frame) => frame.includes(SECOND_ANSWER) && frame.includes(' ready')
    );
    assert.match(second, new RegExp(SECOND_ANSWER));
    assert.equal(requests, 2);
  } finally {
    app.unmount();
    app.cleanup();
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.SURFCODE_HOME;
    else process.env.SURFCODE_HOME = previousHome;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
