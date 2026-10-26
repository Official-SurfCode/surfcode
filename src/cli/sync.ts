import { randomBytes } from 'node:crypto';
import { loadConfig, updateConfig, updateConfigPath } from '../core/config.js';
import { SurfError } from '../core/errors.js';
import { maskSyncToken, resolveSyncSettings, syncEndpoint, syncSessions, type SyncDirection } from '../core/sync.js';
import type { SurfConfig, SyncSettings } from '../core/types.js';
import { startSyncServer } from '../sync/server.js';
import { accent, danger, muted, success, title, warning, write, writeError } from './util.js';

export interface SyncCommandOptions {
  action?: string;
  url?: string;
  token?: string;
  auto?: boolean;
  port?: number;
  host?: string;
  dataDir?: string;
  json?: boolean;
}

export async function syncCommand(options: SyncCommandOptions): Promise<number> {
  const action = (options.action ?? 'both').toLowerCase();
  if (action === 'serve') return await serve(options);
  if (action === 'setup' || action === 'connect') return await setup(options);
  if (action === 'disable') return await setEnabled(false);
  if (action === 'enable') return await setEnabled(true);
  if (action === 'status') return await status(options);

  const direction: SyncDirection | undefined =
    action === 'push' ? 'push' : action === 'pull' ? 'pull' : action === 'both' || action === 'run' ? 'both' : undefined;
  if (!direction) {
    throw new SurfError(`Unknown sync action "${action}"`, {
      hint: 'Use push, pull, both, status, setup, enable, disable, or serve.'
    });
  }

  const config = await loadConfig();
  const sync = resolveSyncSettings(config);
  if (!sync.enabled && action !== 'status') {
    throw new SurfError('Session sync is disabled.', {
      hint: 'Run `surf sync setup --url <url> --token <token>` first.'
    });
  }

  const result = await syncSessions({ config, direction });
  const next = await saveProgress(result.cursor);
  if (options.json) {
    write(
      JSON.stringify(
        {
          direction,
          accepted: result.accepted,
          pulled: result.pulled,
          cursor: result.cursor,
          lastSyncAt: next.sync.lastSyncAt,
          endpoint: syncEndpoint(requireUrl(next))
        },
        null,
        2
      )
    );
    return 0;
  }

  write(`${success('✓')} ${title('Synced')} ${muted(syncEndpoint(requireUrl(next)))}`);
  write(
    muted(
      `${result.accepted} pushed · ${result.pulled} pulled · cursor ${result.cursor} · ${new Date(
        next.sync.lastSyncAt ?? Date.now()
      ).toLocaleString()}`
    )
  );
  return 0;
}

async function status(options: SyncCommandOptions): Promise<number> {
  const config = await loadConfig();
  const sync = resolveSyncSettings(config);
  const data = {
    enabled: sync.enabled,
    auto: sync.auto,
    url: sync.url ?? null,
    endpoint: sync.url ? syncEndpoint(sync.url) : null,
    token: maskSyncToken(sync.token),
    cursor: sync.cursor,
    lastSyncAt: sync.lastSyncAt ?? null
  };
  if (options.json) {
    write(JSON.stringify(data, null, 2));
    return 0;
  }
  write(`${title('Session sync')} ${sync.enabled ? success('● enabled') : muted('○ disabled')}`);
  write(muted(`  endpoint  ${data.endpoint ?? '(not configured)'}`));
  write(muted(`  token     ${data.token}`));
  write(muted(`  auto      ${sync.auto ? 'after each turn' : 'manual'}`));
  write(muted(`  cursor    ${sync.cursor}`));
  write(
    muted(`  last      ${sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : 'never'}`)
  );
  if (!sync.enabled) {
    write();
    write(muted('Set up with `surf sync setup --url <url> --token <token>`.'));
  }
  return 0;
}

async function setup(options: SyncCommandOptions): Promise<number> {
  const url = options.url?.trim();
  const token = options.token?.trim();
  if (!url || !token) {
    throw new SurfError('Sync setup needs a URL and token.', {
      hint: 'surf sync setup --url https://sync.example.com --token <token>'
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SurfError(`Invalid sync URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)) {
    throw new SurfError('Session sync requires HTTPS unless the host is localhost.', {
      hint: 'Use an HTTPS endpoint or a local sync server on 127.0.0.1.'
    });
  }
  const config = await loadConfig();
  const previous = resolveSyncSettings(config);
  const normalizedUrl = parsed.toString().replace(/\/+$/, '');
  const sameEndpoint = previous.url?.trim().replace(/\/+$/, '') === normalizedUrl;
  const sync: SyncSettings = {
    ...previous,
    url: normalizedUrl,
    token,
    enabled: true,
    auto: options.auto ?? false,
    // A cursor belongs to one server's stream. Changing endpoints starts a
    // fresh pull instead of silently skipping sessions from the new server.
    cursor: sameEndpoint ? previous.cursor : 0
  };
  await updateConfig({ sync });
  if (options.json) {
    write(JSON.stringify({ enabled: true, endpoint: syncEndpoint(sync.url!), auto: sync.auto }, null, 2));
    return 0;
  }
  write(`${success('✓')} Session sync enabled ${muted(syncEndpoint(sync.url!))}`);
  write(muted(`  token ${maskSyncToken(token)} · auto ${sync.auto ? 'on' : 'off'}`));
  if (!sync.auto) write(muted('  Auto-push is off. Use /sync or `surf sync` when you want to sync.'));
  write(muted('  Provider API keys are never uploaded.'));
  return 0;
}

async function setEnabled(enabled: boolean): Promise<number> {
  const config = await loadConfig();
  const sync = resolveSyncSettings(config);
  if (enabled && (!sync.url || !sync.token)) {
    throw new SurfError('Configure sync before enabling it.', {
      hint: 'Run `surf sync setup --url <url> --token <token>`.'
    });
  }
  await updateConfigPath(['sync', 'enabled'], enabled);
  write(`${enabled ? success('✓') : muted('○')} Session sync ${enabled ? 'enabled' : 'disabled'}.`);
  return 0;
}

async function serve(options: SyncCommandOptions): Promise<number> {
  const generated = !options.token;
  const token = options.token?.trim() || randomBytes(24).toString('base64url');
  const server = await startSyncServer({
    token,
    host: options.host,
    port: options.port ?? 8787,
    dataDir: options.dataDir
  });
  const setup = `surf sync setup --url ${server.url} --token ${token}`;
  if (options.json) {
    write(
      JSON.stringify(
        {
          listening: server.url,
          sessions: server.sessions,
          token: generated ? token : maskSyncToken(token)
        },
        null,
        2
      )
    );
  } else {
    write(`${title('Sync server')} ${success('● listening')} ${accent(server.url)}`);
    write(muted(`  ${server.sessions} session${server.sessions === 1 ? '' : 's'} in the store`));
    write(muted('  Provider keys are never accepted or stored by this endpoint.'));
    if (generated) {
      write();
      write(`${warning('▲')} Generated token ${accent(token)}`);
      write(muted('  Save it now. It is not written to disk.'));
    }
    write();
    write(muted(`  ${setup}`));
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await server.close();
  if (!options.json) write(muted('Sync server stopped.'));
  return 0;
}

async function saveProgress(cursor: number): Promise<SurfConfig> {
  await updateConfigPath(['sync', 'cursor'], cursor);
  return await updateConfigPath(['sync', 'lastSyncAt'], Date.now());
}

function requireUrl(config: SurfConfig): string {
  const url = resolveSyncSettings(config).url;
  if (!url) {
    writeError(`${danger('error')} Sync URL is missing.`);
    throw new SurfError('Sync URL is missing.');
  }
  return url;
}
