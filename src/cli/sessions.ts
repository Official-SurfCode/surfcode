import { SurfError } from '../core/errors.js';
import { deleteSession, listSessions, loadSession } from '../core/session.js';
import type { ChatMessage, SessionRecord } from '../core/types.js';
import { formatCost, formatTokens } from '../core/usage.js';
import {
  accent,
  confirm,
  danger,
  formatAge,
  muted,
  oneLine,
  safeText,
  success,
  table,
  title,
  warning,
  write
} from './util.js';

export interface SessionsListOptions {
  cwd: string;
  all?: boolean;
  limit?: number;
  json?: boolean;
}

export async function sessionsListCommand(options: SessionsListOptions): Promise<number> {
  const sessions = await listSessions({
    cwd: options.cwd,
    all: options.all,
    limit: Math.max(1, Math.min(options.limit ?? 50, 500))
  });

  if (options.json) {
    write(
      JSON.stringify(
        {
          cwd: options.cwd,
          all: Boolean(options.all),
          total: sessions.length,
          sessions: sessions.map((session) => ({
            id: session.id,
            title: session.title,
            cwd: session.cwd,
            provider: session.provider,
            model: session.model,
            mode: session.mode,
            messages: session.messages.length,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            usage: session.usage
          }))
        },
        null,
        2
      )
    );
    return 0;
  }

  write(
    `${title('Sessions')} ${muted(`· ${sessions.length} ${options.all ? 'total' : `in ${options.cwd}`}`)}`
  );
  write();

  if (sessions.length === 0) {
    write(
      muted(
        options.all
          ? 'No saved sessions yet. Start one with `surf`.'
          : 'No saved sessions in this directory. Use --all to see every workspace.'
      )
    );
    return 0;
  }

  table(
    ['ID', 'Title', 'Model', 'Updated', 'Msgs', 'Cost'],
    sessions.map((session, index) => [
      `${index === 0 ? accent('●') : ' '}${session.id}`,
      safeText(session.title),
      `${session.provider}/${session.model}`,
      formatAge(session.updatedAt),
      String(session.messages.length),
      formatCost(session.usage.cost)
    ])
  );
  write();
  write(muted('Resume with `surf --session <id>` or `surf sessions show <id>`.'));
  return 0;
}

export interface SessionShowOptions {
  json?: boolean;
  full?: boolean;
}

export async function sessionShowCommand(reference: string, options: SessionShowOptions): Promise<number> {
  const session = await loadSession(reference);
  if (!session) {
    throw new SurfError(`Session not found: ${reference}`, {
      hint: 'Run `surf sessions` to list saved sessions.'
    });
  }

  if (options.json) {
    write(JSON.stringify(session, null, 2));
    return 0;
  }

  write(`${title(safeText(session.title))}`);
  write(
    muted(
      [
        session.id,
        `${session.provider}/${session.model}`,
        `${session.mode} mode`,
        `${session.messages.length} messages`,
        formatAge(session.updatedAt),
        formatCost(session.usage.cost)
      ].join(' · ')
    )
  );
  write(muted(session.cwd));
  write();

  if (session.messages.length === 0) {
    write(muted('No messages yet.'));
    return 0;
  }

  for (const message of session.messages) {
    printMessage(message, Boolean(options.full));
  }

  const usage = session.usage;
  write();
  write(
    muted(
      [
        `${formatTokens(usage.inputTokens)} in`,
        `${formatTokens(usage.outputTokens)} out`,
        formatCost(usage.cost),
        `${usage.requests} request${usage.requests === 1 ? '' : 's'}`
      ].join(' · ')
    )
  );
  return 0;
}

export interface SessionRemoveOptions {
  yes?: boolean;
  json?: boolean;
}

export async function sessionRemoveCommand(
  reference: string,
  options: SessionRemoveOptions
): Promise<number> {
  const session = await loadSession(reference);
  if (!session) {
    throw new SurfError(`Session not found: ${reference}`, {
      hint: 'Run `surf sessions` to list saved sessions.'
    });
  }

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new SurfError('Refusing to delete a session without confirmation.', {
        hint: 'Pass --yes to delete it non-interactively.'
      });
    }
    const ok = await confirm(
      `${warning('delete')} ${safeText(session.title)} ${muted(`(${session.id})`)}? [y/N] `
    );
    if (!ok) {
      write(muted('Cancelled.'));
      return 0;
    }
  }

  const removed = await deleteSession(session.id);
  if (!removed) {
    throw new SurfError(`Could not find ${session.id} on disk.`);
  }

  if (options.json) {
    write(JSON.stringify({ removed: true, id: session.id, title: session.title }, null, 2));
    return 0;
  }
  write(`${success('✓')} Deleted ${safeText(session.title)} ${muted(`(${session.id})`)}`);
  return 0;
}

function printMessage(message: ChatMessage, full: boolean): void {
  if (message.role === 'user') {
    write(`${accent('›')} ${indent(safeText(message.content).trim(), '  ')}`);
    write();
    return;
  }

  if (message.role === 'assistant') {
    if (message.reasoning) {
      write(muted(indent(oneLine(message.reasoning, 500), '  ')));
    }
    if (message.content.trim()) {
      write(indent(safeText(message.content).trim(), '  '));
      write();
    }
    for (const call of message.toolCalls ?? []) {
      const detail = toolSummary(call.arguments);
      write(`  ${warning('⚙')} ${call.name}${detail ? ` ${muted(detail)}` : ''}`);
    }
    if ((message.toolCalls?.length ?? 0) > 0) write();
    return;
  }

  if (message.isError) {
    write(`  ${danger('✗')} ${muted(oneLine(message.content, 300))}`);
  } else if (full) {
    write(indent(muted(safeText(message.content).trim()), '    '));
  } else {
    const lines = safeText(message.content).trim().split('\n');
    const excerpt = lines.slice(0, 3).join('\n');
    write(indent(muted(excerpt), '    '));
    if (lines.length > 3) write(muted(`    … ${lines.length - 3} more lines`));
  }
  write();
}

function indent(value: string, prefix: string): string {
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function toolSummary(args: Record<string, unknown>): string {
  const value = args.command ?? args.path ?? args.pattern ?? args.url ?? args.query ?? args.file;
  return typeof value === 'string' ? oneLine(value.replace(/\n/g, ' '), 90) : '';
}

export function sessionCountLabel(sessions: SessionRecord[]): string {
  return `${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
}
