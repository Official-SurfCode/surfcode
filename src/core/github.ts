import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { getStoredKey, mask } from './auth.js';
import { SurfError, errorMessage } from './errors.js';
import { resolveWorkspacePath } from './workspace.js';

const execFileAsync = promisify(execFile);
const API = 'https://api.github.com';
const TOKEN_KEY = 'github';
const TOKEN_ENV = ['GITHUB_TOKEN', 'GH_TOKEN'];

const REPO_PART = /^[A-Za-z0-9._-]{1,100}$/;

function validRepoPart(part: string): boolean {
  return REPO_PART.test(part) && part !== '.' && part !== '..';
}
const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.yarn',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache'
];

export interface GithubTokenStatus {
  configured: boolean;
  source?: 'auth' | 'env';
  envName?: string;
  masked?: string;
}

export interface GithubViewer {
  login: string;
  name?: string;
  htmlUrl?: string;
}

export interface GithubRepository {
  name: string;
  owner: string;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  private: boolean;
}

export interface GithubState {
  repo: boolean;
  branch?: string;
  remote?: string;
  dirty: boolean;
  commits: number;
}

export interface PublishResult {
  branch: string;
  commit?: string;
  remote?: string;
  pushed: boolean;
  files: string[];
  nothingToCommit: boolean;
}

export async function githubTokenStatus(): Promise<GithubTokenStatus> {
  const stored = await getStoredKey(TOKEN_KEY);
  if (stored) return { configured: true, source: 'auth', masked: mask(stored) };
  for (const name of TOKEN_ENV) {
    const value = process.env[name]?.trim();
    if (value) return { configured: true, source: 'env', envName: name, masked: mask(value) };
  }
  return { configured: false };
}

export async function getGithubToken(): Promise<string | undefined> {
  const stored = await getStoredKey(TOKEN_KEY);
  if (stored) return stored;
  for (const name of TOKEN_ENV) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export async function requireGithubToken(): Promise<string> {
  const token = await getGithubToken();
  if (!token) {
    throw new SurfError('No GitHub token is configured.', {
      hint: 'Run /github login in the TUI, `surf auth github`, or set GITHUB_TOKEN. Never paste a token into the chat.'
    });
  }
  return token;
}

export function parseGithubRepo(input: string): { owner?: string; name: string } {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length === 1) {
    const name = parts[0]!;
    if (!validRepoPart(name)) {
      throw new SurfError(`Invalid repository name "${name}".`, {
        hint: 'Use letters, numbers, dots, dashes, or underscores.'
      });
    }
    return { name };
  }
  if (parts.length === 2) {
    const owner = parts[0]!;
    const name = parts[1]!;
    if (!validRepoPart(owner) || !validRepoPart(name)) {
      throw new SurfError(`Invalid GitHub repository "${input}".`, {
        hint: 'Use owner/name, for example surfcode/demo.'
      });
    }
    return { owner, name };
  }
  throw new SurfError(`Invalid GitHub repository "${input}".`, {
    hint: 'Use a repository name or owner/name.'
  });
}

export async function githubViewer(token: string): Promise<GithubViewer> {
  const data = await githubRequest<Record<string, unknown>>('/user', { token });
  if (typeof data.login !== 'string' || !data.login) {
    throw new SurfError('GitHub returned an unexpected user response.');
  }
  return {
    login: data.login,
    name: typeof data.name === 'string' ? data.name : undefined,
    htmlUrl: typeof data.html_url === 'string' ? data.html_url : undefined
  };
}

export async function createGithubRepository(options: {
  token: string;
  name: string;
  private: boolean;
  description?: string;
  owner?: string;
}): Promise<GithubRepository> {
  if (typeof options.private !== 'boolean') {
    throw new SurfError('Specify whether the repository is private.', {
      hint: 'Pass private: true for a private repository or private: false for a public one.'
    });
  }
  const parsed = parseGithubRepo(options.name);
  const owner = options.owner?.trim() || parsed.owner;
  const viewer = await githubViewer(options.token);
  const target =
    owner && owner.toLowerCase() !== viewer.login.toLowerCase()
      ? `/orgs/${encodeURIComponent(owner)}/repos`
      : '/user/repos';
  const data = await githubRequest<Record<string, unknown>>(target, {
    token: options.token,
    method: 'POST',
    body: {
      name: parsed.name,
      private: options.private,
      description: options.description?.slice(0, 350) || undefined,
      auto_init: false,
      has_issues: true,
      has_projects: false,
      has_wiki: false
    }
  });
  return repositoryFromApi(data);
}

export async function githubGitState(cwd: string): Promise<GithubState> {
  const inside = await gitMaybe(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') {
    return { repo: false, dirty: false, commits: 0 };
  }
  const [symbolic, head, remote, status, count] = await Promise.all([
    gitMaybe(cwd, ['symbolic-ref', '--short', 'HEAD']),
    gitMaybe(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitMaybe(cwd, ['remote', 'get-url', 'origin']),
    gitMaybe(cwd, ['status', '--porcelain']),
    gitMaybe(cwd, ['rev-list', '--count', 'HEAD'])
  ]);
  return {
    repo: true,
    // An empty repository has no HEAD commit yet, but symbolic-ref still
    // names the unborn branch, which is exactly what the first push needs.
    branch: symbolic?.trim() || head?.trim() || undefined,
    remote: remote?.trim() ? sanitizeRemoteUrl(remote.trim()) : undefined,
    dirty: Boolean(status?.trim()),
    commits: Number.parseInt(count?.trim() || '0', 10) || 0
  };
}

export async function ensureGitRepository(cwd: string): Promise<{ created: boolean; state: GithubState }> {
  const before = await githubGitState(cwd);
  if (before.repo) return { created: false, state: before };
  try {
    await runGit(cwd, ['init', '-b', 'main']);
  } catch {
    await runGit(cwd, ['init']);
    await runGit(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  return { created: true, state: await githubGitState(cwd) };
}

export async function gitRemote(cwd: string): Promise<string | undefined> {
  const url = await gitMaybe(cwd, ['remote', 'get-url', 'origin']);
  return url?.trim() ? sanitizeRemoteUrl(url.trim()) : undefined;
}

export async function setGithubRemote(
  cwd: string,
  cloneUrl: string,
  replace = false
): Promise<{ changed: boolean; existing?: string; remote: string }> {
  const clean = sanitizeRemoteUrl(cloneUrl);
  const existing = await gitRemote(cwd);
  if (existing && !replace) return { changed: false, existing, remote: existing };
  if (existing) await runGit(cwd, ['remote', 'set-url', 'origin', clean]);
  else await runGit(cwd, ['remote', 'add', 'origin', clean]);
  return { changed: true, remote: clean };
}

/**
 * Stage a change set, commit it, and push with the token supplied through an
 * askpass helper. The token never appears in a URL, the git config, or argv.
 */
export async function publishToGithub(
  cwd: string,
  options: {
    message: string;
    files?: string[];
    push?: boolean;
    branch?: string;
  }
): Promise<PublishResult> {
  const token = await requireGithubToken();
  const message = options.message.trim();
  if (!message) throw new SurfError('A commit message is required.');
  if (message.length > 4_000) throw new SurfError('The commit message is too long.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) {
    throw new SurfError('The commit message contains control characters.');
  }

  const { state } = await ensureGitRepository(cwd);
  const remote = state.remote ?? (await gitRemote(cwd));
  if (!remote) {
    throw new SurfError('This project has no origin remote.', {
      hint: 'Use github_create_repo first, or add an origin remote and try again.'
    });
  }

  await stage(cwd, options.files);
  const staged = (await runGit(cwd, ['diff', '--cached', '--name-only']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const branch = options.branch?.trim() || (await currentBranch(cwd)) || 'main';
  if (!/^[A-Za-z0-9._/-]{1,240}$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    throw new SurfError(`Invalid branch name "${branch}".`);
  }

  let commit: string | undefined;
  if (staged.length > 0) {
    commit = await commitWithHint(cwd, message);
  } else if (state.commits === 0) {
    throw new SurfError('Nothing was staged for the first commit.', {
      hint: 'Check .gitignore, or pass specific files to upload.'
    });
  }

  let pushed = false;
  if (options.push !== false) {
    await withAskpass(token, async (env) => {
      await runGit(cwd, ['push', '-u', 'origin', `HEAD:${branch}`], { env, timeout: 180_000 });
    });
    pushed = true;
  }

  return {
    branch,
    commit,
    remote,
    pushed,
    files: staged,
    nothingToCommit: staged.length === 0
  };
}

export function sanitizeRemoteUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/\/[^/@\s]+@/, '//');
  }
}

export function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join('[redacted]');
}

async function stage(cwd: string, files: string[] | undefined): Promise<void> {
  if (files && files.length > 0) {
    const paths = files
      .map((file) => file.trim())
      .filter(Boolean)
      .map((file) => {
        if (file.startsWith(':') || file.startsWith('!')) {
          throw new SurfError(`Unsupported pathspec "${file}".`, {
            hint: 'Pass ordinary workspace-relative file or directory paths.'
          });
        }
        const resolved = resolveWorkspacePath(file, cwd, false);
        if (resolved.relative === '.') throw new SurfError('Pass a file or directory, not the workspace root.');
        return relative(cwd, resolved.absolute).split('\\').join('/');
      });
    if (paths.length === 0) throw new SurfError('No files were selected.');
    await runGit(cwd, ['add', '--', ...paths]);
    return;
  }
  await runGit(cwd, [
    'add',
    '-A',
    '--',
    '.',
    ...DEFAULT_EXCLUDES.map((directory) => `:(exclude)${directory}`)
  ]);
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  return (await gitMaybe(cwd, ['symbolic-ref', '--short', 'HEAD']))?.trim() || undefined;
}

async function commitWithHint(cwd: string, message: string): Promise<string> {
  try {
    await runGit(cwd, ['commit', '-m', message]);
  } catch (error) {
    const text = errorMessage(error);
    if (/user\.name|user\.email|author identity|empty ident/i.test(text)) {
      throw new SurfError('Git needs an author identity before it can commit.', {
        hint: 'Run `git config user.name "Your Name"` and `git config user.email "you@example.com"`, then retry.'
      });
    }
    throw error;
  }
  return (await runGit(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
}

async function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...options.env },
      windowsHide: true
    });
    return stdout;
  } catch (error) {
    const failure = error as { code?: string; stderr?: string; stdout?: string; message?: string };
    if (failure.code === 'ENOENT') {
      throw new SurfError('Git is not installed or is not on PATH.');
    }
    const detail = (failure.stderr || failure.stdout || failure.message || 'git failed').trim();
    const token = options.env?.SURFCODE_GITHUB_TOKEN;
    throw new SurfError(redactToken(detail, token).slice(0, 2_000), {
      hint: 'Fix the git error, then retry. SurfCode never stores the GitHub token in the remote URL.'
    });
  }
}

async function gitMaybe(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGit(cwd, args, { timeout: 8_000 });
  } catch {
    return undefined;
  }
}

async function withAskpass<T>(token: string, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'surfcode-git-'));
  const windows = process.platform === 'win32';
  const file = join(directory, windows ? 'askpass.cmd' : 'askpass.sh');
  const script = windows
    ? '@echo off\r\necho %~1 | findstr /I "username" >nul\r\nif %errorlevel%==0 (echo x-access-token) else (echo %SURFCODE_GITHUB_TOKEN%)\r\n'
    : '#!/bin/sh\ncase "$1" in\n  *[Uu]sername*) printf \'%s\\n\' "x-access-token" ;;\n  *) printf \'%s\\n\' "$SURFCODE_GITHUB_TOKEN" ;;\nesac\n';
  await writeFile(file, script, { mode: windows ? undefined : 0o700 });
  if (!windows) await chmod(file, 0o700);
  try {
    return await run({
      GIT_ASKPASS: file,
      GIT_TERMINAL_PROMPT: '0',
      SURFCODE_GITHUB_TOKEN: token
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function githubRequest<T>(
  path: string,
  options: { token: string; method?: string; body?: unknown }
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'SurfCode'
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    throw new SurfError(`Could not reach GitHub: ${errorMessage(error)}`, {
      hint: 'Check your network connection and try again.'
    });
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) throw githubHttpError(response.status, data);
  return data as T;
}

function githubHttpError(status: number, data: unknown): SurfError {
  const message =
    data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
      ? (data as { message: string }).message
      : undefined;
  const base = `GitHub API ${status}${message ? `: ${message}` : ''}`;
  if (status === 401) {
    return new SurfError(base, {
      hint: 'The token was rejected. Run /github login or `surf auth github` with a fresh personal access token.'
    });
  }
  if (status === 403) {
    return new SurfError(base, {
      hint: 'The token may lack the repo scope, or the GitHub rate limit was reached. Check the token and try later.'
    });
  }
  if (status === 404) {
    return new SurfError(base, {
      hint: 'Check the repository owner and name. A fine-grained token also needs access to that organization.'
    });
  }
  if (status === 422) {
    return new SurfError(base, {
      hint: 'The repository name may already exist or be invalid. Choose another name or reuse the existing repository.'
    });
  }
  return new SurfError(base);
}

function repositoryFromApi(data: Record<string, unknown>): GithubRepository {
  const owner =
    data.owner && typeof data.owner === 'object' && typeof (data.owner as { login?: unknown }).login === 'string'
      ? (data.owner as { login: string }).login
      : '';
  const name = typeof data.name === 'string' ? data.name : '';
  const fullName = typeof data.full_name === 'string' ? data.full_name : owner && name ? `${owner}/${name}` : name;
  const htmlUrl = typeof data.html_url === 'string' ? data.html_url : '';
  const cloneUrl =
    typeof data.clone_url === 'string'
      ? data.clone_url
      : htmlUrl
        ? `${htmlUrl.replace(/\/$/, '')}.git`
        : '';
  if (!fullName || !htmlUrl || !cloneUrl) {
    throw new SurfError('GitHub returned an incomplete repository response.');
  }
  return {
    name,
    owner,
    fullName,
    htmlUrl,
    cloneUrl,
    private: data.private === true
  };
}
