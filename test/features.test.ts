import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../src/core/config.js';
import {
  activeEffort,
  anthropicThinkingBudget,
  effortLabel,
  googleThinkingBudget,
  googleThinkingControl,
  parseEffort
} from '../src/core/effort.js';
import { parseWorkerRef, workerLabel } from '../src/core/agents.js';
import { hasFreeApi } from '../src/core/free.js';

test('free API badges cover permanent no-cost tiers only', () => {
  for (const id of ['google', 'groq', 'mistral', 'openrouter', 'cloudflare-workers-ai']) {
    assert.equal(hasFreeApi(id), true, `${id} should be marked free`);
  }
  // Cerebras only offers a $5 trial after a payment method, so it is not a
  // permanent no-cost tier. Trial credits never earn the badge.
  for (const id of ['openai', 'anthropic', 'deepseek', 'xai', 'huggingface', 'cerebras', 'ollama']) {
    assert.equal(hasFreeApi(id), false, `${id} should not be marked free`);
  }
});

test('effort settings parse case-insensitively and keep the provider default', () => {
  assert.equal(parseEffort('LOW'), 'low');
  assert.equal(parseEffort(' high '), 'high');
  assert.equal(parseEffort('auto'), 'auto');
  assert.equal(parseEffort('turbo'), undefined);
  assert.equal(activeEffort('auto'), undefined);
  assert.equal(activeEffort('medium'), 'medium');
  assert.equal(effortLabel('auto'), 'auto (provider default)');
  assert.equal(defaultConfig().effort, 'auto');
});

test('thinking budgets leave room for the answer', () => {
  assert.equal(anthropicThinkingBudget('low', 8_192), 2_048);
  assert.equal(anthropicThinkingBudget('high', 8_192), 7_168);
  assert.equal(anthropicThinkingBudget('high', 1_024), undefined);

  assert.equal(googleThinkingBudget('low', 8_192), 1_024);
  assert.equal(googleThinkingBudget('high', 8_192), 7_680);
  assert.equal(googleThinkingBudget('high', 512), undefined);
});

test('Gemini 3 uses thinking levels and Flash-Lite can truly stop thinking', () => {
  assert.deepEqual(googleThinkingControl('gemini-3.1-flash-lite-preview', 'low', 8_192), {
    thinkingLevel: 'minimal'
  });
  assert.deepEqual(googleThinkingControl('gemini-3-flash-preview', 'medium', 8_192), {
    thinkingLevel: 'medium'
  });
  assert.deepEqual(googleThinkingControl('gemini-2.5-flash', 'low', 8_192), {
    thinkingBudget: 0
  });
  assert.deepEqual(googleThinkingControl('gemini-2.5-pro', 'low', 8_192), {
    thinkingBudget: 1_024
  });
});

test('new performance and access settings default to the fast, safe path', () => {
  const config = defaultConfig();
  assert.equal(config.streaming, false);
  assert.equal(config.explorerWidth, 34);
  assert.equal(config.fullAccess, false);
  assert.deepEqual(config.agents, { enabled: false, workers: [] });
});

test('agent worker references keep model ids that contain slashes', () => {
  assert.deepEqual(parseWorkerRef('openrouter/meta-llama/llama-3.3-70b'), {
    provider: 'openrouter',
    model: 'meta-llama/llama-3.3-70b'
  });
  assert.equal(parseWorkerRef('just-a-model'), undefined);
  assert.equal(workerLabel({ provider: 'google', model: 'gemini-3.1-flash-lite-preview' }), 'google/gemini-3.1-flash-lite-preview');
});
