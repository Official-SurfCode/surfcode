import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { SurfError } from '../core/errors.js';
import { getPaths, writeFileAtomic } from '../core/paths.js';
import { sessionRecordSchema } from '../core/session.js';
import type { SessionRecord } from '../core/types.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

const storedSessionSchema = z.object({
  cursor: z.number().int().min(0),
  session: sessionRecordSchema
});

const stateSchema = z.object({
  version: z.literal(1),
  cursor: z.number().int().min(0),
  sessions: z.record(z.string(), storedSessionSchema)
});

const requestSchema = z.object({
  since: z.number().int().min(0).default(0),
  pull: z.boolean().default(true),
  sessions: z.array(sessionRecordSchema).default([])
});

interface StoredSession {
  cursor: number;
  session: SessionRecord;
}

interface SyncState {
  version: 1;
  cursor: number;
  sessions: Record<string, StoredSession>;
}

export interface SyncServerOptions {
  token: string;
  host?: string;
  port?: number;
  dataDir?: string;
}

export interface RunningSyncServer {
  url: string;
  host: string;
  port: number;
  sessions: number;
  close(): Promise<void>;
}

export async function startSyncServer(options: SyncServerOptions): Promise<RunningSyncServer> {
  const token = options.token.trim();
  if (!token) throw new SurfError('The sync server requires a token.');
  const host = options.host?.trim() || '127.0.0.1';
  const port = options.port ?? 8787;
  const dataDir = options.dataDir?.trim() || join(getPaths().dataDir, 'sync-server');
  const stateFile = join(dataDir, 'sessions.json');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  let state = await loadState(stateFile);
  let queue: Promise<unknown> = Promise.resolve();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://sync.local');
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        json(response, 200, { ok: true, sessions: Object.keys(state.sessions).length });
        return;
      }
      if (url.pathname !== '/v1/sync') {
        json(response, 404, { error: 'not_found' });
        return;
      }
      if (request.method !== 'POST') {
        json(response, 405, { error: 'method_not_allowed' });
        return;
      }
      if (!authorized(request, token)) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }

      const raw = await readBody(request);
      let body: z.infer<typeof requestSchema>;
      try {
        body = requestSchema.parse(JSON.parse(raw));
      } catch {
        json(response, 400, { error: 'invalid_request' });
        return;
      }

      const result = await mutate(async () => {
        let accepted = 0;
        for (const session of body.sessions) {
          const current = state.sessions[session.id];
          if (current && current.session.updatedAt >= session.updatedAt) continue;
          state.cursor += 1;
          state.sessions[session.id] = { cursor: state.cursor, session };
          accepted += 1;
        }
        if (accepted > 0) await saveState(stateFile, state);

        const changed = body.pull
          ? Object.values(state.sessions)
              .filter((entry) => entry.cursor > body.since)
              .sort((a, b) => a.cursor - b.cursor)
              .map((entry) => entry.session)
          : [];
        return {
          accepted,
          cursor: state.cursor,
          sessions: changed
        };
      });

      json(response, 200, result);
    } catch (error) {
      if (!response.headersSent) {
        json(response, 500, {
          error: 'internal_error',
          message: error instanceof Error ? error.message : String(error)
        });
      } else {
        response.destroy();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    url: `http://${displayHost}:${actualPort}`,
    host,
    port: actualPort,
    sessions: Object.keys(state.sessions).length,
    close: () => closeServer(server)
  };

  function mutate<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const supplied = Buffer.from(match[1]!.trim());
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new SurfError('Sync request body is too large.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function loadState(path: string): Promise<SyncState> {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed.success) throw new Error('invalid state');
    return parsed.data as SyncState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, cursor: 0, sessions: {} };
    }
    throw new SurfError(`Could not read sync state at ${path}.`, {
      hint: 'Move the file aside to start a fresh sync store.'
    });
  }
}

async function saveState(path: string, state: SyncState): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
