import { SurfError } from './errors.js';
import { listSessions, saveSession, sessionRecordSchema } from './session.js';
import type { SessionRecord, SurfConfig, SyncSettings } from './types.js';

export type SyncDirection = 'both' | 'push' | 'pull';

export interface SyncResult {
  accepted: number;
  pulled: number;
  cursor: number;
  remote: SessionRecord[];
}

interface SyncResponse {
  cursor: number;
  accepted: number;
  sessions: SessionRecord[];
}

export function resolveSyncSettings(config: SurfConfig): SyncSettings {
  return (
    config.sync ?? {
      enabled: false,
      auto: false,
      cursor: 0
    }
  );
}

export function syncEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/v1\/sync$/.test(base)) return base;
  return `${base}/v1/sync`;
}

export function requireSyncSettings(config: SurfConfig): Required<Pick<SyncSettings, 'url' | 'token'>> {
  const sync = resolveSyncSettings(config);
  if (!sync.url?.trim()) {
    throw new SurfError('Session sync is not configured.', {
      hint: 'Run `surf sync setup --url https://your-sync-host --token <token>`.'
    });
  }
  if (!sync.token?.trim()) {
    throw new SurfError('Session sync has no token.', {
      hint: 'Run `surf sync setup --url <url> --token <token>` or set SURFCODE_SYNC_TOKEN.'
    });
  }
  if (!/^https:\/\//i.test(sync.url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(sync.url)) {
    throw new SurfError('Session sync requires HTTPS unless it points at localhost.', {
      hint: 'Use an HTTPS endpoint or a localhost sync server.'
    });
  }
  return { url: sync.url.trim(), token: sync.token.trim() };
}

/**
 * Push local sessions and pull remote changes. Only SessionRecord objects are
 * sent over the wire; provider API keys, auth.json, and provider settings never
 * leave the machine.
 */
export async function syncSessions(options: {
  config: SurfConfig;
  direction?: SyncDirection;
  signal?: AbortSignal;
  timeout?: number;
}): Promise<SyncResult> {
  const { url, token } = requireSyncSettings(options.config);
  const sync = resolveSyncSettings(options.config);
  const direction = options.direction ?? 'both';
  const local = direction === 'pull' ? [] : await listSessions({ all: true, limit: 100_000 });
  const since = direction === 'push' ? 0 : sync.cursor;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 20_000)])
    : AbortSignal.timeout(options.timeout ?? 20_000);

  let response: Response;
  try {
    response = await fetch(syncEndpoint(url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': 'surfcode-sync/0.1'
      },
      body: JSON.stringify({
        since,
        pull: direction !== 'push',
        sessions: local
      }),
      signal
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new SurfError('Session sync timed out.', {
        hint: 'Check the sync server URL and network connection.'
      });
    }
    throw new SurfError(`Could not reach the sync server: ${error instanceof Error ? error.message : String(error)}`, {
      hint: `Tried ${syncEndpoint(url)}.`
    });
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 2_000);
    throw new SurfError(`Sync server returned ${response.status}${body ? ` — ${body}` : ''}`, {
      hint:
        response.status === 401 || response.status === 403
          ? 'Check the sync token with `surf sync status`.'
          : undefined
    });
  }

  const payload = (await response.json().catch(() => undefined)) as
    | Partial<SyncResponse>
    | undefined;
  const cursor = payload?.cursor;
  const accepted = payload?.accepted;
  if (
    !payload ||
    typeof cursor !== 'number' ||
    !Number.isFinite(cursor) ||
    typeof accepted !== 'number' ||
    !Number.isFinite(accepted)
  ) {
    throw new SurfError('Sync server returned an invalid response.');
  }

  const remote: SessionRecord[] = [];
  for (const entry of Array.isArray(payload.sessions) ? payload.sessions : []) {
    const parsed = sessionRecordSchema.safeParse(entry);
    if (parsed.success) remote.push(parsed.data as SessionRecord);
  }

  const byId = new Map((await listSessions({ all: true, limit: 100_000 })).map((session) => [session.id, session]));
  let pulled = 0;
  for (const session of remote) {
    const existing = byId.get(session.id);
    if (!existing || session.updatedAt > existing.updatedAt) {
      await saveSession(session, { preserveUpdatedAt: true });
      pulled += 1;
    }
  }

  return {
    accepted,
    pulled,
    cursor,
    remote
  };
}

export function maskSyncToken(token: string | undefined): string {
  if (!token) return '(not set)';
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
