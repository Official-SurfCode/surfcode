import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensurePaths, getPaths, writeFileAtomic } from './paths.js';
import type { ChatMessage, SessionRecord, Usage } from './types.js';
import { emptyUsage } from './usage.js';

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  rawArguments: z.string().optional(),
  signature: z.string().optional()
});

const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    reasoning: z.string().optional(),
    toolCalls: z.array(toolCallSchema).optional()
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string(),
    name: z.string(),
    content: z.string(),
    isError: z.boolean().optional()
  })
]);

export const sessionRecordSchema = z.object({
  version: z.literal(1),
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value)),
  title: z.string(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string(),
  mode: z.enum(['build', 'plan']),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  messages: z.array(messageSchema),
  usage: z.object({
    inputTokens: z.number().finite().nonnegative(),
    outputTokens: z.number().finite().nonnegative(),
    reasoningTokens: z.number().finite().nonnegative().optional(),
    cacheReadTokens: z.number().finite().nonnegative().optional(),
    cacheWriteTokens: z.number().finite().nonnegative().optional(),
    cost: z.number().finite().nonnegative(),
    requests: z.number().finite().nonnegative()
  })
});

export function createSession(options: {
  cwd: string;
  provider: string;
  model: string;
  mode: 'build' | 'plan';
}): SessionRecord {
  const now = Date.now();
  return {
    version: 1,
    id: `ses_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    title: 'New session',
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    createdAt: now,
    updatedAt: now,
    messages: [],
    usage: emptyUsage()
  };
}

export async function saveSession(
  session: SessionRecord,
  options: { preserveUpdatedAt?: boolean } = {}
): Promise<void> {
  const paths = await ensurePaths();
  const title = deriveTitle(session.messages, session.title);
  const record: SessionRecord = {
    ...session,
    title,
    updatedAt: options.preserveUpdatedAt ? session.updatedAt : Date.now()
  };
  await writeFileAtomic(join(paths.sessionsDir, `${safeId(record.id)}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

export async function loadSession(idOrPrefix: string): Promise<SessionRecord | undefined> {
  await ensurePaths();
  const paths = getPaths();
  const files = await readdir(paths.sessionsDir).catch(() => [] as string[]);
  const match = files.find((file) => file === `${safeId(idOrPrefix)}.json`) ?? files.find((file) => file.startsWith(`${safeId(idOrPrefix)}`));
  if (!match) return undefined;
  return await readSessionFile(join(paths.sessionsDir, match));
}

export async function listSessions(options: { cwd?: string; all?: boolean; limit?: number } = {}): Promise<SessionRecord[]> {
  await ensurePaths();
  const paths = getPaths();
  const files = (await readdir(paths.sessionsDir).catch(() => [] as string[])).filter((file) => file.endsWith('.json'));
  const sessions: SessionRecord[] = [];
  for (const file of files) {
    const session = await readSessionFile(join(paths.sessionsDir, file));
    if (!session) continue;
    if (!options.all && options.cwd && session.cwd !== options.cwd) continue;
    sessions.push(session);
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions.slice(0, options.limit ?? 100);
}

export async function latestSession(cwd: string): Promise<SessionRecord | undefined> {
  return (await listSessions({ cwd, limit: 1 }))[0];
}

export async function deleteSession(id: string): Promise<boolean> {
  await ensurePaths();
  const paths = getPaths();
  try {
    await unlink(join(paths.sessionsDir, `${safeId(id)}.json`));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function deriveTitle(messages: ChatMessage[], fallback = 'New session'): string {
  const first = messages.find((message) => message.role === 'user');
  if (!first || first.role !== 'user') return fallback;
  const clean = first.content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return fallback;
  return clean.length > 64 ? `${clean.slice(0, 61)}…` : clean;
}

export function addSessionUsage(base: Usage, delta: Usage): Usage {
  return {
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    reasoningTokens: (base.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0),
    cacheReadTokens: (base.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
    cacheWriteTokens: (base.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
    cost: base.cost + delta.cost,
    requests: base.requests + delta.requests
  };
}

async function readSessionFile(path: string): Promise<SessionRecord | undefined> {
  try {
    const parsed = sessionRecordSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed.success) return undefined;
    return parsed.data as SessionRecord;
  } catch {
    return undefined;
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}
