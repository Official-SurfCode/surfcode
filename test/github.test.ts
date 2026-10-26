import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { mask, removeProviderKey, saveProviderKey } from '../src/core/auth.js';
import {
  createGithubRepository,
  getGithubToken,
  githubGitState,
  githubTokenStatus,
  githubViewer,
  parseGithubRepo,
  publishToGithub,
  redactToken,
  sanitizeRemoteUrl,
  setGithubRemote
} from '../src/core/github.js';

const execFileAsync = promisify(execFile);
const FAKE_TOKEN = 'ghp_surfcode_test_token_1234567890';
const originalFetch = globalThis.fetch;
const originalToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
let home: string;
let workspace: string;
let bareRemote: string;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  });
  return stdout.trim();
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'surfcode-github-'));
  process.env.SURFCODE_HOME = home;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;

  workspace = join(home, 'workspace');
  bareRemote = join(home, 'remote.git');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(workspace, 'node_modules', 'ignored'), { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# Demo\n');
  await writeFile(join(workspace, 'src', 'main.ts'), 'export const value = 1;\n');
  await writeFile(join(workspace, 'node_modules', 'ignored', 'index.js'), 'nope\n');
  await git(workspace, ['init', '-b', 'main']);
  await git(workspace, ['config', 'user.name', 'Surf Tester']);
  await git(workspace, ['config', 'user.email', 'surf@example.com']);
  await git(workspace, ['config', 'commit.gpgsign', 'false']);
  await git(home, ['init', '--bare', 'remote.git']);
  await git(workspace, ['remote', 'add', 'origin', bareRemote]);
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
  if (originalGhToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalGhToken;
  delete process.env.SURFCODE_HOME;
  await rm(home, { recursive: true, force: true });
});

test('github token status supports auth.json and both environment fallbacks', async () => {
  let status = await githubTokenStatus();
  assert.equal(status.configured, false);
  assert.equal(await getGithubToken(), undefined);

  process.env.GITHUB_TOKEN = FAKE_TOKEN;
  status = await githubTokenStatus();
  assert.equal(status.configured, true);
  assert.equal(status.source, 'env');
  assert.equal(status.envName, 'GITHUB_TOKEN');
  assert.equal(status.masked, mask(FAKE_TOKEN));
  assert.equal(await getGithubToken(), FAKE_TOKEN);

  delete process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = FAKE_TOKEN;
  status = await githubTokenStatus();
  assert.equal(status.source, 'env');
  assert.equal(status.envName, 'GH_TOKEN');
  delete process.env.GH_TOKEN;

  await saveProviderKey('github', FAKE_TOKEN);
  status = await githubTokenStatus();
  assert.equal(status.configured, true);
  assert.equal(status.source, 'auth');
  assert.equal(status.masked, mask(FAKE_TOKEN));
  assert.equal(await getGithubToken(), FAKE_TOKEN);

  const stored = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as {
    keys: Record<string, string>;
  };
  assert.equal(stored.keys.github, FAKE_TOKEN);

  assert.equal(await removeProviderKey('github'), true);
  status = await githubTokenStatus();
  assert.equal(status.configured, false);
  assert.equal(await getGithubToken(), undefined);
});

test('repository references parse from names, owner/name, and clone URLs', () => {
  assert.deepEqual(parseGithubRepo('demo'), { name: 'demo' });
  assert.deepEqual(parseGithubRepo('surfer/demo'), { owner: 'surfer', name: 'demo' });
  assert.deepEqual(parseGithubRepo('https://github.com/surfer/demo.git'), {
    owner: 'surfer',
    name: 'demo'
  });
  assert.deepEqual(parseGithubRepo('surfer/demo/'), { owner: 'surfer', name: 'demo' });

  assert.throws(() => parseGithubRepo('a/b/c'), /Invalid GitHub repository/);
  assert.throws(() => parseGithubRepo('bad name'), /Invalid repository name|Invalid GitHub repository/);
  assert.throws(() => parseGithubRepo('..'), /Invalid repository name/);
  assert.throws(() => parseGithubRepo('../demo'), /Invalid GitHub repository/);
});

test('remote URLs and error text never expose credentials', () => {
  assert.equal(
    sanitizeRemoteUrl('https://x-access-token:ghp_secret@github.com/surfer/demo.git'),
    'https://github.com/surfer/demo.git'
  );
  assert.equal(
    sanitizeRemoteUrl('https://surfer:ghp_secret@github.com/surfer/demo.git/'),
    'https://github.com/surfer/demo.git'
  );
  assert.equal(sanitizeRemoteUrl('/tmp/remote.git'), '/tmp/remote.git');
  assert.equal(
    redactToken('fatal: https://ghp_secret@github.com/surfer/demo.git failed', 'ghp_secret'),
    'fatal: https://[redacted]@github.com/surfer/demo.git failed'
  );
});

test('GitHub API uses bearer auth and requires an explicit visibility', async () => {
  const requests: Array<{
    url: string;
    method: string;
    auth?: string;
    body?: Record<string, unknown>;
  }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method,
      auth: headers.get('authorization') ?? undefined,
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
    });
    if (url.endsWith('/user')) return json({ login: 'surfer', name: 'Surf' });
    if (url.endsWith('/user/repos')) {
      return json(
        {
          name: 'demo',
          full_name: 'surfer/demo',
          html_url: 'https://github.com/surfer/demo',
          clone_url: 'https://github.com/surfer/demo.git',
          private: true,
          owner: { login: 'surfer' }
        },
        201
      );
    }
    return json({ message: 'unexpected request' }, 500);
  }) as typeof fetch;

  try {
    const viewer = await githubViewer(FAKE_TOKEN);
    assert.equal(viewer.login, 'surfer');
    assert.equal(requests[0]?.auth, `Bearer ${FAKE_TOKEN}`);
    assert.ok(!JSON.stringify(viewer).includes(FAKE_TOKEN));

    const repo = await createGithubRepository({
      token: FAKE_TOKEN,
      name: 'demo',
      private: true,
      description: 'A demo'
    });
    assert.equal(repo.fullName, 'surfer/demo');
    assert.equal(repo.private, true);

    const post = requests.find((request) => request.method === 'POST');
    assert.ok(post, 'repository creation should POST');
    assert.equal(post.auth, `Bearer ${FAKE_TOKEN}`);
    assert.equal(post.body?.name, 'demo');
    assert.equal(post.body?.private, true);
    assert.equal(post.body?.auto_init, false);

    await assert.rejects(
      () =>
        createGithubRepository({
          token: FAKE_TOKEN,
          name: 'demo',
          private: undefined as unknown as boolean
        }),
      /Specify whether the repository is private/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitHub API errors include actionable hints without the token', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/user')) {
      return json({ login: 'surfer' });
    }
    return json({ message: 'Repository creation failed.' }, 422);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => createGithubRepository({ token: FAKE_TOKEN, name: 'demo', private: true }),
      (error: Error & { hint?: string }) => {
        assert.match(error.message, /GitHub API 422/);
        assert.match(error.message, /Repository creation failed/);
        assert.match(error.hint ?? '', /already exist or be invalid/);
        assert.ok(!error.message.includes(FAKE_TOKEN));
        assert.ok(!(error.hint ?? '').includes(FAKE_TOKEN));
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () =>
    json({ message: 'Bad credentials' }, 401)) as typeof fetch;
  try {
    await assert.rejects(
      () => githubViewer(FAKE_TOKEN),
      (error: Error & { hint?: string }) => {
        assert.match(error.message, /GitHub API 401/);
        assert.match(error.hint ?? '', /github login/i);
        assert.ok(!error.message.includes(FAKE_TOKEN));
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('setGithubRemote strips credentials and leaves an existing origin alone', async () => {
  const directory = join(home, 'remote-test');
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '-b', 'main']);

  const first = await setGithubRemote(
    directory,
    'https://x-access-token:ghp_secret@github.com/surfer/demo.git'
  );
  assert.equal(first.changed, true);
  assert.equal(first.remote, 'https://github.com/surfer/demo.git');
  const config = await readFile(join(directory, '.git', 'config'), 'utf8');
  assert.ok(!config.includes('ghp_secret'));
  assert.ok(!config.includes('x-access-token'));

  const second = await setGithubRemote(directory, 'https://github.com/surfer/other.git');
  assert.equal(second.changed, false);
  assert.equal(second.existing, 'https://github.com/surfer/demo.git');

  const third = await setGithubRemote(
    directory,
    'https://surfer:ghp_secret@github.com/surfer/other.git',
    true
  );
  assert.equal(third.changed, true);
  assert.equal(
    await git(directory, ['remote', 'get-url', 'origin']),
    'https://github.com/surfer/other.git'
  );
});

test('publishToGithub stages the workspace, commits, and pushes with askpass', async () => {
  process.env.GITHUB_TOKEN = FAKE_TOKEN;
  try {
    const state = await githubGitState(workspace);
    assert.equal(state.repo, true);
    assert.equal(state.branch, 'main');
    assert.equal(state.remote, bareRemote);
    assert.equal(state.commits, 0);

    const result = await publishToGithub(workspace, {
      message: 'Initial upload',
      push: true
    });
    assert.equal(result.pushed, true);
    assert.equal(result.branch, 'main');
    assert.ok(result.commit);
    assert.ok(result.files.includes('README.md'));
    assert.ok(result.files.includes('src/main.ts'));
    assert.ok(!result.files.some((file) => file.startsWith('node_modules')));

    const subject = await git(bareRemote, ['log', '-1', '--format=%s', 'main']);
    assert.equal(subject, 'Initial upload');
    const files = await git(bareRemote, ['show', '--name-only', '--format=', 'main']);
    assert.deepEqual(files.split('\n').filter(Boolean).sort(), ['README.md', 'src/main.ts']);

    const noOrigin = join(home, 'no-origin');
    await mkdir(noOrigin, { recursive: true });
    await writeFile(join(noOrigin, 'file.txt'), 'hello\n');
    await assert.rejects(
      () => publishToGithub(noOrigin, { message: 'No remote', push: true }),
      /no origin remote/
    );
    assert.equal((await githubGitState(noOrigin)).repo, true);

    await assert.rejects(
      () => publishToGithub(workspace, { message: 'bad\u0000message', push: false }),
      /control characters/
    );
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test('publishToGithub can commit only selected files', async () => {
  process.env.GITHUB_TOKEN = FAKE_TOKEN;
  try {
    await writeFile(join(workspace, 'src', 'extra.ts'), 'export const extra = true;\n');
    await writeFile(join(workspace, 'notes.txt'), 'leave me uncommitted\n');

    const result = await publishToGithub(workspace, {
      message: 'Add extra module',
      files: ['src/extra.ts'],
      push: true
    });
    assert.equal(result.pushed, true);
    assert.deepEqual(result.files, ['src/extra.ts']);
    assert.equal(result.nothingToCommit, false);

    const files = await git(workspace, ['show', '--name-only', '--format=', 'HEAD']);
    assert.equal(files, 'src/extra.ts');
    const status = await git(workspace, ['status', '--porcelain']);
    assert.match(status, /notes\.txt/);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});
