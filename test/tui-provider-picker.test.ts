import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { render } from 'ink-testing-library';
import App from '../src/tui/App.js';
import type { Catalog } from '../src/core/catalog.js';
import { defaultConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import type { CatalogModel, CatalogProvider, SurfConfig } from '../src/core/types.js';

const ENV_NAME = 'SURFCODE_TEST_ZETA_PICKER_KEY';

function model(provider: string, id: string): CatalogModel {
  return {
    id,
    name: id,
    tool_call: true,
    limit: { context: 128_000, output: 8_192 }
  };
}

function provider(
  id: string,
  name: string,
  env: string[],
  extra: Partial<CatalogProvider> = {}
): CatalogProvider {
  return {
    id,
    name,
    env,
    models: { [`${id}-model`]: model(id, `${id}-model`) },
    ...extra
  };
}

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

test('enter opens the highlighted provider, not a differently sorted row', async () => {
  const home = await mkdtemp(join(tmpdir(), 'surfcode-tui-provider-'));
  const previousHome = process.env.SURFCODE_HOME;
  const previousKey = process.env[ENV_NAME];
  process.env.SURFCODE_HOME = home;
  // Zeta has a credential but no endpoint, so the old credential-only sort
  // moved it above Alpha. The picker's rendered order (ready first, then name)
  // keeps Alpha highlighted, and Enter must resolve that exact row.
  process.env[ENV_NAME] = 'zeta-test-key';

  const alpha = provider('alpha-picker', 'Alpha Picker Test', [], {
    api: 'https://alpha.invalid/v1'
  });
  const zeta = provider('zeta-picker', 'Zeta Picker Test', [ENV_NAME]);
  const catalog: Catalog = { source: 'bundled', providers: [zeta, alpha] };

  const config: SurfConfig = {
    ...defaultConfig(),
    theme: 'mono',
    mode: 'build',
    providers: {},
    customProviders: {},
    sync: { enabled: false, auto: false, cursor: 0 }
  };

  const session = createSession({ cwd: home, provider: '', model: '', mode: 'build' });
  const app = render(
    React.createElement(App, {
      cwd: home,
      config,
      catalog,
      session
    })
  );

  try {
    await type(app, '/provider');
    app.stdin.write('\r');
    const open = await waitFor(
      app,
      (frame) =>
        frame.includes('PROVIDERS') &&
        frame.includes('1 connected') &&
        frame.includes('Alpha Picker Test') &&
        frame.includes('Zeta Picker Test')
    );
    assert.match(open, /▌ ○ Alpha Picker Test/);
    assert.doesNotMatch(open, /▌ ○ Zeta Picker Test/);

    app.stdin.write('\r');
    const connect = await waitFor(app, (frame) => frame.includes('connect · Alpha Picker Test'));
    assert.match(connect, /connect · Alpha Picker Test/);
    assert.doesNotMatch(connect, /Zeta Picker Test needs a custom endpoint/);
  } finally {
    app.unmount();
    app.cleanup();
    if (previousHome === undefined) delete process.env.SURFCODE_HOME;
    else process.env.SURFCODE_HOME = previousHome;
    if (previousKey === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = previousKey;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
