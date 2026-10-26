import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import stripAnsi from 'strip-ansi';
import {
  clampExplorerWidth,
  explorerDockWidth,
  explorerParent,
  findExplorerEntry,
  listExplorer,
  readExplorerPreview
} from '../src/tui/explorer.js';
import { renderExplorer } from '../src/tui/overlays.js';
import { getTheme } from '../src/tui/theme.js';
import { visibleWidth } from '../src/tui/ansi.js';

let cwd: string;

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'surfcode-explorer-'));
  await mkdir(join(cwd, 'src', 'tui'), { recursive: true });
  await mkdir(join(cwd, 'node_modules', 'ignored'), { recursive: true });
  await mkdir(join(cwd, '.git'), { recursive: true });
  await writeFile(join(cwd, 'README.md'), '# Demo\nsecond line\n');
  await writeFile(join(cwd, 'src', 'main.ts'), 'export const value = 1;\n');
  await writeFile(join(cwd, 'src', 'tui', 'App.tsx'), 'export default 1;\n');
  await writeFile(join(cwd, 'node_modules', 'ignored', 'index.js'), 'nope\n');
  await writeFile(join(cwd, 'logo.bin'), Buffer.from([0, 1, 2, 3, 4]));
});

after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test('explorer loads lazily and skips build/vendor directories', async () => {
  const root = await listExplorer(cwd, []);
  assert.deepEqual(
    root.map((entry) => entry.path),
    ['src', 'logo.bin', 'README.md']
  );
  assert.ok(!root.some((entry) => entry.path === 'src/main.ts'));
  assert.ok(!root.some((entry) => entry.path.startsWith('node_modules')));
  assert.ok(!root.some((entry) => entry.path.startsWith('.git')));

  const expanded = await listExplorer(cwd, ['src', 'src/tui']);
  const paths = expanded.map((entry) => entry.path);
  assert.ok(paths.includes('src/main.ts'));
  assert.ok(paths.includes('src/tui/App.tsx'));
  assert.equal(findExplorerEntry(expanded, 'src/tui')?.depth, 1);
  assert.equal(findExplorerEntry(expanded, 'src/tui/App.tsx')?.depth, 2);
  assert.equal(explorerParent('src/tui/App.tsx'), 'src/tui');
  assert.equal(explorerParent('README.md'), undefined);
});

test('explorer preview is bounded, numbered, and binary-safe', async () => {
  const readme = await readExplorerPreview(cwd, 'README.md');
  assert.equal(readme.binary, false);
  assert.deepEqual(readme.lines, ['# Demo', 'second line']);

  const binary = await readExplorerPreview(cwd, 'logo.bin');
  assert.equal(binary.binary, true);
  assert.deepEqual(binary.lines, []);

  await assert.rejects(() => readExplorerPreview(cwd, '../outside.txt'));
});

test('explorer dock stays visible, clamps its width, and hides only when tiny', () => {
  assert.equal(explorerDockWidth(34, 120), 34);
  assert.equal(explorerDockWidth(80, 120), 80);
  assert.equal(explorerDockWidth(80, 80), 47);
  assert.equal(explorerDockWidth(34, 60), 27);
  assert.equal(explorerDockWidth(34, 56), 0);
  assert.equal(clampExplorerWidth(10, 120), 24);
  assert.equal(clampExplorerWidth(999, 200), 80);
  assert.equal(clampExplorerWidth(Number.NaN, 120), 34);
});

test('explorer renderer switches its hints when the dock has focus', async () => {
  const entries = await listExplorer(cwd, []);
  const focused = renderExplorer({
    cwd,
    entries,
    selected: 0,
    expanded: [],
    width: 60,
    height: 14,
    theme: getTheme('dark'),
    focused: true
  })
    .map((line) => stripAnsi(line))
    .join('\n');
  assert.match(focused, /esc prompt/);
  assert.match(focused, /\[ \] resize/);

  const idle = renderExplorer({
    cwd,
    entries,
    selected: 0,
    expanded: [],
    width: 60,
    height: 14,
    theme: getTheme('dark')
  })
    .map((line) => stripAnsi(line))
    .join('\n');
  assert.match(idle, /ctrl\+o focus/);
  assert.match(idle, /ctrl\+←→ resize/);
});

test('explorer renderer fits the terminal and highlights the selection', async () => {
  const entries = await listExplorer(cwd, ['src']);
  const preview = await readExplorerPreview(cwd, 'src/main.ts');
  for (const [width, height] of [
    [60, 12],
    [90, 18],
    [120, 40],
    [40, 6]
  ] as const) {
    const lines = renderExplorer({
      cwd,
      entries,
      selected: entries.findIndex((entry) => entry.path === 'src'),
      expanded: ['src'],
      preview,
      width,
      height,
      theme: getTheme('dark')
    });
    assert.equal(lines.length, height, `${width}x${height} line count`);
    assert.ok(
      lines.every((line) => visibleWidth(line) === width),
      `${width}x${height} every row is exactly the terminal width`
    );
    // Both borders must survive the slice, including when the preview is shown.
    const first = stripAnsi(lines[0]!);
    const last = stripAnsi(lines.at(-1)!);
    assert.ok(first.startsWith('╭') && first.endsWith('╮'), `${width}x${height} top border`);
    assert.ok(last.startsWith('╰') && last.endsWith('╯'), `${width}x${height} bottom border`);
  }

  const lines = renderExplorer({
    cwd,
    entries,
    selected: entries.findIndex((entry) => entry.path === 'src'),
    expanded: ['src'],
    preview,
    width: 90,
    height: 18,
    theme: getTheme('dark')
  });
  const plain = lines.map((line) => stripAnsi(line)).join('\n');
  assert.match(plain, /EXPLORER/);
  assert.match(plain, /preview/);
  assert.match(plain, /src\/main\.ts/);
  assert.match(plain, /export const value = 1/);
});
