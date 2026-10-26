import assert from 'node:assert/strict';
import { test } from 'node:test';
import stripAnsi from 'strip-ansi';
import { bg, chalk, shimmer, visibleWidth } from '../src/tui/ansi.js';
import { renderHero, renderInput, renderStatus, type HeroInfo } from '../src/tui/layout.js';
import { renderBtwOverlay, renderGithubInfo, renderPicker } from '../src/tui/overlays.js';
import { getTheme, nextTheme, THEMES } from '../src/tui/theme.js';

const theme = getTheme('aurora');
const heroInfo: HeroInfo = {
  cwd: '/home/surfer/project',
  provider: 'openai',
  model: 'gpt-5.1-codex',
  mode: 'build',
  configuredProviders: 1,
  totalProviders: 235
};

test('welcome hero uses the full block wordmark on wide terminals', () => {
  const lines = renderHero(heroInfo, 120, theme, 20).map((line) => stripAnsi(line));
  assert.ok(lines.some((line) => line.includes('▀▀▀▓▄▄')));
  assert.ok(lines.some((line) => line.includes('terminal-native AI engineering')));
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test('welcome hero has compact and tiny fallbacks', () => {
  const compact = renderHero(heroInfo, 80, theme, 20).map((line) => stripAnsi(line));
  assert.ok(compact.some((line) => line.includes('______')));
  assert.ok(compact.every((line) => visibleWidth(line) <= 80));

  const tiny = renderHero(heroInfo, 40, theme, 20).map((line) => stripAnsi(line));
  assert.ok(tiny.some((line) => line.includes('SURFCODE')));

  const short = renderHero(heroInfo, 120, theme, 8).map((line) => stripAnsi(line));
  assert.ok(short.some((line) => line.includes('SURFCODE')));
});

test('welcome wordmark reveals before settling', () => {
  const opening = renderHero({ ...heroInfo, tick: 0 }, 120, theme, 20).map((line) => stripAnsi(line));
  const settled = renderHero({ ...heroInfo, tick: 30 }, 120, theme, 20).map((line) => stripAnsi(line));
  assert.ok(!opening.join('\n').includes('▀'));
  assert.ok(settled.join('\n').includes('▀▀▀▓▄▄'));
});

test('main prompt is a simple rounded box without title or hint', () => {
  const box = renderInput(
    {
      value: '',
      cursor: 0,
      placeholder: 'Ask anything…',
      title: 'ignored title',
      hint: 'ignored hint',
      theme,
      focused: true,
      variant: 'minimal'
    },
    80
  );
  const plain = box.lines.map((line) => stripAnsi(line));
  assert.equal(box.lines.length, 3);
  assert.ok(plain[0]!.startsWith('╭────'));
  assert.ok(plain[2]!.startsWith('╰────'));
  assert.match(plain[1]!, /❯\s+Ask anything…/);
  assert.ok(!plain.join('\n').includes('ignored title'));
  assert.ok(!plain.join('\n').includes('ignored hint'));
  assert.ok(box.lines.every((line) => visibleWidth(line) === 80));
});

test('titled prompt keeps its title and hint inside the border', () => {
  const box = renderInput(
    {
      value: '',
      cursor: 0,
      placeholder: 'paste your key…',
      title: 'connect · openai',
      hint: 'enter save · esc cancel · stored with mode 600',
      theme,
      focused: true,
      secret: true
    },
    40
  );
  const plain = box.lines.map((line) => stripAnsi(line));
  assert.match(plain[0]!, /connect · openai/);
  assert.match(plain[2]!, /enter save · esc cancel/);
  assert.ok(box.lines.every((line) => visibleWidth(line) === 40));
});

test('status keeps mode visible on standard terminals and model on wide ones', () => {
  const base = {
    theme,
    hint: '/connect to connect · /model to choose a model',
    contextUsed: 1_240,
    contextWindow: 128_000,
    cost: 0,
    state: 'ready' as const,
    spinner: '⠋',
    mode: 'build' as const,
    provider: 'openai',
    model: 'gpt-5.1-codex'
  };
  const standard = stripAnsi(renderStatus({ ...base, width: 80 }));
  const wide = stripAnsi(renderStatus({ ...base, width: 120 }));
  assert.match(standard, /build/);
  assert.doesNotMatch(standard, /gpt-5\.1-codex/);
  assert.match(wide, /build/);
  assert.match(wide, /openai\/gpt-5\.1-codex/);
});

test('status shows the selected reasoning effort', () => {
  const standard = stripAnsi(
    renderStatus({
      theme,
      width: 100,
      hint: '/ commands',
      contextUsed: 1_240,
      contextWindow: 128_000,
      cost: 0,
      state: 'ready',
      spinner: '⠋',
      mode: 'build',
      effort: 'high',
      provider: 'google',
      model: 'gemini-test'
    })
  );
  assert.match(standard, /build · high/);
});

test('provider picker marks providers with a free API', () => {
  const lines = renderPicker({
    title: 'providers',
    items: [{ id: 'google', label: 'Google', freeApi: true, configured: false }],
    selected: 0,
    width: 80,
    height: 10,
    theme
  }).map((line) => stripAnsi(line));
  assert.ok(lines.some((line) => line.includes('[FREE API]')));
});

test('btw overlay shows the answer and says it is ephemeral', () => {
  const lines = renderBtwOverlay(
    {
      question: 'why is the test failing?',
      answer: 'The fixture is missing.',
      done: true,
      startedAt: Date.now() - 1_200,
      now: Date.now()
    },
    80,
    20,
    theme,
    '⠋'
  ).map((line) => stripAnsi(line));
  const joined = lines.join('\n');
  assert.match(joined, /why is the test failing\?/);
  assert.match(joined, /The fixture is missing\./);
  assert.match(joined, /not saved to the session/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});

test('github info overlay explains publishing scopes without leaking or suggesting deletion', () => {
  const lines = renderGithubInfo({
    configured: true,
    source: 'auth.json',
    masked: 'ghp_…abcd',
    width: 80,
    height: 24,
    theme
  }).map((line) => stripAnsi(line));
  const joined = lines.join('\n');
  assert.match(joined, /GitHub token saved/);
  assert.match(joined, /ghp_…abcd/);
  assert.match(joined, /Contents.*Administration/);
  assert.match(joined, /stored in auth\.json with mode 600/);
  assert.doesNotMatch(joined, /delete_repo|repository deletion|delete a repository/i);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));

  const missing = renderGithubInfo({
    configured: false,
    width: 80,
    height: 24,
    theme
  })
    .map((line) => stripAnsi(line))
    .join('\n');
  assert.match(missing, /No GitHub token yet/);
});

test('status has explicit stopping and syncing states', () => {
  const base = {
    theme,
    hint: '/ commands',
    contextUsed: 1_240,
    contextWindow: 128_000,
    cost: 0,
    state: 'ready' as const,
    spinner: '⠋',
    mode: 'build' as const,
    provider: 'openai',
    model: 'gpt-5.1-codex'
  };
  assert.match(stripAnsi(renderStatus({ ...base, width: 100, state: 'stopping' })), /■ stopping/);
  assert.match(stripAnsi(renderStatus({ ...base, width: 100, state: 'sync' })), /⟳ syncing/);
});

test('status pins an animated SurfCode mark to the bottom-right corner', () => {
  const base = {
    theme,
    hint: '/connect to connect · /model to choose a model',
    contextUsed: 1_240,
    contextWindow: 128_000,
    cost: 0,
    state: 'ready' as const,
    spinner: '⠋',
    mode: 'build' as const,
    provider: 'openai',
    model: 'gpt-5.1-codex'
  };
  for (const width of [20, 40, 80, 120]) {
    const first = renderStatus({ ...base, width, tick: 0 });
    const second = renderStatus({ ...base, width, tick: 2 });
    const firstPlain = stripAnsi(first);
    const secondPlain = stripAnsi(second);
    assert.equal(visibleWidth(first), width);
    assert.equal(visibleWidth(second), width);
    assert.match(firstPlain, /SURFCODE$/);
    assert.match(secondPlain, /SURFCODE$/);
    assert.notEqual(firstPlain, secondPlain);
  }
});

test('shimmer preserves the visible wordmark', () => {
  const colored = shimmer('SURFCODE', theme.gradient, 7);
  assert.equal(stripAnsi(colored), 'SURFCODE');
  assert.equal(visibleWidth(colored), 8);
});

test('frame background is restored after inline-code resets', () => {
  const previous = chalk.level;
  chalk.level = 3;
  try {
    const line = bg(
      '#000000',
      `before ${chalk.hex('#F9A8D4').bgHex('#831843')(' code ')} after`
    );
    assert.equal(stripAnsi(line), 'before  code  after');
    assert.ok(line.startsWith('\x1b[48;2;0;0;0m'));
    assert.ok(line.includes('\x1b[49m\x1b[48;2;0;0;0m'));
    assert.ok(!line.endsWith('\x1b[48;2;0;0;0m'));
  } finally {
    chalk.level = previous;
  }
});

test('dark theme is available and theme cycling reaches every palette', () => {
  const dark = getTheme('dark');
  assert.equal(dark.name, 'dark');
  assert.equal(dark.label, 'Dark');
  assert.match(dark.description, /blue/i);
  assert.equal(dark.background, '#000000');
  assert.ok(THEMES.some((entry) => entry.name === 'dark'));

  const seen = new Set<string>();
  let current = THEMES[0]!.name;
  for (let index = 0; index < THEMES.length; index += 1) {
    seen.add(current);
    current = nextTheme(current).name;
  }
  assert.equal(seen.size, THEMES.length);
  assert.equal(current, THEMES[0]!.name);
});

