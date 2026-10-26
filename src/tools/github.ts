import type { ToolDefinition, ToolResult } from '../core/types.js';
import { SurfError } from '../core/errors.js';
import {
  createGithubRepository,
  ensureGitRepository,
  gitRemote,
  githubGitState,
  githubTokenStatus,
  publishToGithub,
  requireGithubToken,
  setGithubRemote
} from '../core/github.js';

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function summary(files: string[], limit = 12): string {
  if (files.length === 0) return 'no file changes';
  const shown = files.slice(0, limit).join(', ');
  return files.length > limit ? `${shown}, +${files.length - limit} more` : shown;
}

export const githubStatusTool: ToolDefinition = {
  name: 'github_status',
  description:
    'Check whether a GitHub token is configured and inspect the local git repository: branch, origin remote, dirty state, and commit count. Read-only; never prints the token. Use this before creating or publishing a repository.',
  readOnly: true,
  action: 'read',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  async execute(_args, context): Promise<ToolResult> {
    const [token, git] = await Promise.all([githubTokenStatus(), githubGitState(context.cwd)]);
    const tokenLine = token.configured
      ? `GitHub token: configured (${token.source === 'env' ? token.envName : 'auth.json'} · ${token.masked ?? 'saved'})`
      : 'GitHub token: not configured. Ask the user to run /github login or `surf auth github`; never ask them to paste it in chat.';
    const lines = [
      tokenLine,
      `Local repository: ${git.repo ? 'yes' : 'no'}`,
      `Branch: ${git.branch ?? '—'}`,
      `Origin: ${git.remote ?? '—'}`,
      `Working tree: ${git.repo ? (git.dirty ? 'dirty' : 'clean') : '—'}`,
      `Commits: ${git.repo ? git.commits : '—'}`
    ];
    return {
      output: lines.join('\n'),
      title: 'GitHub status',
      display: { summary: token.configured ? 'token ready' : 'token missing' }
    };
  }
};

export const githubCreateRepoTool: ToolDefinition = {
  name: 'github_create_repo',
  description:
    'Create a new GitHub repository for the current project. The user must explicitly choose private or public. Uses the saved GitHub token, optionally initializes local git, and points origin at the new repository. Does not commit or push code; call github_upload next.',
  readOnly: false,
  action: 'shell',
  permission(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : 'repository';
    const visibility = args.private === true ? 'private' : args.private === false ? 'public' : 'visibility not specified';
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    return {
      title: 'Create GitHub repository',
      detail: `${name} · ${visibility}${description ? `\n${description}` : ''}`,
      risk: 'medium',
      rule: `github:create:${name}`
    };
  },
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Repository name, or owner/name. Use kebab-case unless the user asks otherwise.' },
      private: {
        type: 'boolean',
        description: 'Required. true for a private repository, false for a public repository.'
      },
      description: { type: 'string', description: 'Optional short repository description.' },
      owner: { type: 'string', description: 'Optional organization or user. Defaults to the authenticated user.' },
      set_remote: {
        type: 'boolean',
        description: 'Point origin at the new repository. Defaults to true.'
      },
      replace_remote: {
        type: 'boolean',
        description: 'Replace an existing origin remote. Defaults to false so an existing project remote is never clobbered.'
      }
    },
    required: ['name', 'private']
  },
  async execute(args, context): Promise<ToolResult> {
    const token = await requireGithubToken();
    const name = String(args.name ?? '').trim();
    if (!name) throw new SurfError('A repository name is required.');
    if (typeof args.private !== 'boolean') {
      throw new SurfError('Specify whether the repository should be private.', {
        hint: 'Pass private: true for private or private: false for public. Ask the user if they have not said.'
      });
    }
    const repo = await createGithubRepository({
      token,
      name,
      private: args.private,
      description: typeof args.description === 'string' ? args.description.trim() : undefined,
      owner: typeof args.owner === 'string' ? args.owner.trim() : undefined
    });

    const setRemote = args.set_remote !== false;
    const replaceRemote = args.replace_remote === true;
    let remoteNote = 'Origin was not changed.';
    if (setRemote) {
      await ensureGitRepository(context.cwd);
      const existing = await gitRemote(context.cwd);
      if (existing && !replaceRemote) {
        remoteNote =
          existing === repo.cloneUrl
            ? `origin already points to ${repo.cloneUrl}.`
            : `origin already points to ${existing}; left it unchanged. Pass replace_remote: true only if the user wants to replace it.`;
      } else {
        const updated = await setGithubRemote(context.cwd, repo.cloneUrl, replaceRemote);
        remoteNote = `origin ${updated.changed ? 'set to' : 'already at'} ${updated.remote}.`;
      }
    }

    return {
      output: [
        `Created ${repo.private ? 'private' : 'public'} repository ${repo.fullName}.`,
        repo.htmlUrl,
        remoteNote,
        'Next: use github_upload to stage, commit, and push the code.'
      ].join('\n'),
      title: `github · ${repo.fullName}`,
      display: { summary: `${repo.private ? 'private' : 'public'} · ${repo.fullName}` }
    };
  }
};

export const githubUploadTool: ToolDefinition = {
  name: 'github_upload',
  description:
    'Commit and push code to the origin GitHub repository. Use with no files to upload the whole workspace (common build directories are excluded), or pass files/directories to upload a selected set. This is a publish action: only use it when the user explicitly asks. Never include a token in arguments or commit messages.',
  readOnly: false,
  action: 'shell',
  permission(args) {
    const files = stringArray(args.files);
    const message = typeof args.message === 'string' ? args.message.trim() : 'Upload from SurfCode';
    return {
      title: 'Upload code to GitHub',
      detail: `Commit: ${message}\nFiles: ${files ? files.join(', ') : 'all workspace changes (build dirs excluded)'}\nPush: ${args.push === false ? 'no' : 'yes'}`,
      risk: 'high',
      rule: `github:upload:${message}`
    };
  },
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message. Write a clear summary of the project or changes.' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative files or directories. Omit to upload everything.'
      },
      push: { type: 'boolean', description: 'Push after committing. Defaults to true.' },
      branch: { type: 'string', description: 'Optional branch to push. Defaults to the current branch.' }
    },
    required: ['message']
  },
  async execute(args, context): Promise<ToolResult> {
    const message = String(args.message ?? '').trim();
    if (!message) throw new SurfError('A commit message is required.');
    const result = await publishToGithub(context.cwd, {
      message,
      files: stringArray(args.files),
      push: args.push !== false,
      branch: typeof args.branch === 'string' ? args.branch : undefined
    });
    return publishResult(result);
  }
};

export const githubCommitTool: ToolDefinition = {
  name: 'github_commit',
  description:
    'Commit changes and push them to the origin GitHub repository. Use after the user asks to commit or save progress. Pass files to commit only those paths, or omit files to commit every workspace change. Never commit or push unless the user explicitly asks.',
  readOnly: false,
  action: 'shell',
  permission(args) {
    const files = stringArray(args.files);
    const message = typeof args.message === 'string' ? args.message.trim() : 'Commit from SurfCode';
    return {
      title: 'Commit and push to GitHub',
      detail: `Commit: ${message}\nFiles: ${files ? files.join(', ') : 'all workspace changes'}\nPush: ${args.push === false ? 'no' : 'yes'}`,
      risk: 'high',
      rule: `github:commit:${message}`
    };
  },
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message describing the change.' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative files or directories. Omit to commit everything.'
      },
      push: { type: 'boolean', description: 'Push after committing. Defaults to true.' },
      branch: { type: 'string', description: 'Optional branch to push. Defaults to the current branch.' }
    },
    required: ['message']
  },
  async execute(args, context): Promise<ToolResult> {
    const message = String(args.message ?? '').trim();
    if (!message) throw new SurfError('A commit message is required.');
    const result = await publishToGithub(context.cwd, {
      message,
      files: stringArray(args.files),
      push: args.push !== false,
      branch: typeof args.branch === 'string' ? args.branch : undefined
    });
    return publishResult(result);
  }
};

function publishResult(result: Awaited<ReturnType<typeof publishToGithub>>): ToolResult {
  const status = result.nothingToCommit
    ? 'Nothing new to commit; the working tree is clean.'
    : `Committed ${result.files.length} file${result.files.length === 1 ? '' : 's'}${result.commit ? ` as ${result.commit}` : ''}.`;
  const push = result.pushed
    ? `Pushed ${result.branch} to origin.`
    : 'Commit created but not pushed.';
  return {
    output: [
      status,
      push,
      result.remote ? `Repository: ${result.remote}` : '',
      result.files.length > 0 ? `Files: ${summary(result.files)}` : ''
    ]
      .filter(Boolean)
      .join('\n'),
    title: result.pushed ? `github · pushed ${result.branch}` : `github · committed ${result.branch}`,
    display: {
      summary: result.nothingToCommit
        ? 'nothing to commit'
        : `${result.files.length} file${result.files.length === 1 ? '' : 's'}${result.pushed ? ' · pushed' : ''}`
    }
  };
}
