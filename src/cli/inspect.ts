import { stat } from 'node:fs/promises';
import { credentialStatus } from '../core/auth.js';
import {
  allModels,
  catalogAge,
  catalogIsStale,
  discoverLocalModels,
  loadCatalog,
  providerById,
  refreshCatalog,
  scoreModel,
  type Catalog
} from '../core/catalog.js';
import { loadConfig } from '../core/config.js';
import { SurfError } from '../core/errors.js';
import { FREE_API_HINT, FREE_API_LABEL, hasFreeApi } from '../core/free.js';
import { ensurePaths, getPaths } from '../core/paths.js';
import { knownEndpoint, resolveSelection } from '../core/provider.js';
import type { SurfConfig } from '../core/types.js';
import {
  accent,
  assertWritable,
  cell,
  contextLabel,
  credentialUsable,
  danger,
  formatAge,
  isChatModel,
  muted,
  oneLine,
  PRIORITY_PROVIDERS,
  priceLabel,
  providerStatusLabel,
  safeText,
  success,
  table,
  title,
  warning,
  write
} from './util.js';
import { VERSION } from '../version.js';

const PRIORITY = new Map(PRIORITY_PROVIDERS.map((id, index) => [id, index]));

export interface ModelsOptions {
  query?: string[];
  provider?: string;
  all?: boolean;
  limit?: number;
  json?: boolean;
  refresh?: boolean;
}

export async function modelsCommand(options: ModelsOptions): Promise<number> {
  const config = await loadConfig();
  if (options.refresh) {
    if (!options.json) write(muted('Refreshing the models.dev catalog…'));
    try {
      await refreshCatalog();
    } catch (error) {
      throw new SurfError(`Could not refresh the catalog: ${errorText(error)}`, {
        hint: 'Check your network connection, or keep using the bundled snapshot.'
      });
    }
  }

  const catalog = await loadCatalog(config);
  const query = (options.query ?? []).join(' ').trim().toLowerCase();
  let entries = allModels(catalog);

  if (options.provider) {
    const provider = providerById(catalog, options.provider);
    if (!provider) {
      throw new SurfError(`Unknown provider "${options.provider}"`, {
        hint: 'Run `surf providers --all` to browse provider ids.'
      });
    }
    entries = entries.filter((entry) => entry.provider.id === provider.id);
  }

  if (!options.all) {
    entries = entries.filter((entry) => isChatModel(entry.model.id, entry.model.name, entry.model));
  }

  if (query) {
    entries = entries.filter((entry) =>
      `${entry.provider.id} ${entry.provider.name} ${entry.model.id} ${entry.model.name}`
        .toLowerCase()
        .includes(query)
    );
  }

  entries.sort((a, b) => {
    const score = scoreModel(b.model) - scoreModel(a.model);
    if (score !== 0) return score;
    const priority =
      (PRIORITY.get(a.provider.id) ?? PRIORITY.size) - (PRIORITY.get(b.provider.id) ?? PRIORITY.size);
    if (priority !== 0) return priority;
    return a.model.name.localeCompare(b.model.name);
  });

  const total = entries.length;
  const limit = Math.max(1, Math.min(options.limit ?? (options.json ? total : 25), 1000));
  const shown = entries.slice(0, limit);

  if (options.json) {
    write(
      JSON.stringify(
        {
          source: catalog.source,
          updatedAt: catalog.updatedAt ?? null,
          total,
          shown: shown.length,
          current: config.provider && config.model ? { provider: config.provider, model: config.model } : null,
          models: shown.map(({ provider, model }) => ({
            provider: provider.id,
            providerName: provider.name,
            id: model.id,
            name: model.name,
            context: model.limit?.context ?? null,
            output: model.limit?.output ?? null,
            toolCall: model.tool_call !== false,
            reasoning: Boolean(model.reasoning),
            price: {
              input: model.cost?.input ?? null,
              output: model.cost?.output ?? null
            },
            score: Math.round(scoreModel(model) * 10) / 10
          }))
        },
        null,
        2
      )
    );
    return 0;
  }

  write(
    `${title('Models')} ${muted(`· ${total} match${total === 1 ? '' : 'es'} · ${catalogSummary(catalog)}`)}`
  );
  if (config.provider && config.model) {
    write(`${muted('current')} ${accent(`${config.provider}/${config.model}`)}`);
  }
  write();

  if (shown.length === 0) {
    write(muted('No models matched. Try `surf models --all` or a different search.'));
    return 0;
  }

  table(
    ['', 'Provider', 'Model', 'Context', 'Price', 'Tags'],
    shown.map(({ provider, model }) => {
      const current = provider.id === config.provider && model.id === config.model;
      const tags = [
        model.tool_call !== false ? 'tools' : '',
        model.reasoning ? 'reason' : '',
        model.attachment ? 'files' : ''
      ]
        .filter(Boolean)
        .join(' ');
      return [
        current ? accent('●') : ' ',
        provider.id,
        model.id,
        contextLabel(model),
        priceLabel(model),
        muted(tags || '—')
      ];
    })
  );

  if (total > shown.length) {
    write();
    write(muted(`…and ${total - shown.length} more. Use --limit to show more, or search to narrow.`));
  }
  return 0;
}

export interface ProvidersOptions {
  query?: string[];
  all?: boolean;
  connected?: boolean;
  json?: boolean;
}

export async function providersCommand(options: ProvidersOptions): Promise<number> {
  if (options.all && options.connected) {
    throw new SurfError('Choose either --all or --connected, not both.');
  }
  const config = await loadConfig();
  const catalog = await loadCatalog(config);
  await discoverLocalModels(catalog);
  const statuses = new Map(
    (await credentialStatus(catalog.providers, config)).map((status) => [status.provider.id, status])
  );
  const connectedIds = new Set(
    [...statuses.values()]
      .filter((status) => credentialUsable(status, config))
      .map((status) => status.provider.id)
  );

  const query = (options.query ?? []).join(' ').trim().toLowerCase();
  let providers = catalog.providers.filter((provider) => {
    if (!query) return true;
    return `${provider.id} ${provider.name} ${provider.env.join(' ')}`.toLowerCase().includes(query);
  });

  if (options.connected) {
    providers = providers.filter((provider) => connectedIds.has(provider.id));
  } else if (!options.all) {
    providers = providers.filter(
      (provider) =>
        connectedIds.has(provider.id) ||
        PRIORITY.has(provider.id) ||
        provider.id === config.provider ||
        provider.custom ||
        provider.discovered
    );
  }

  providers.sort((a, b) => {
    const ready = Number(connectedIds.has(b.id)) - Number(connectedIds.has(a.id));
    if (ready !== 0) return ready;
    const priority = (PRIORITY.get(a.id) ?? PRIORITY.size) - (PRIORITY.get(b.id) ?? PRIORITY.size);
    if (priority !== 0) return priority;
    return a.name.localeCompare(b.name);
  });

  if (options.json) {
    write(
      JSON.stringify(
        {
          total: catalog.providers.length,
          connected: connectedIds.size,
          providers: providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            configured: connectedIds.has(provider.id),
            source: statuses.get(provider.id)?.source ?? null,
            env: provider.env,
            models: Object.keys(provider.models).length,
            endpoint:
              config.providers[provider.id]?.baseURL ??
              config.customProviders[provider.id]?.baseURL ??
              provider.api ??
              knownEndpoint(provider) ??
              null,
            local: Boolean(provider.local),
            discovered: Boolean(provider.discovered),
            custom: Boolean(provider.custom),
            freeApi: hasFreeApi(provider.id)
          }))
        },
        null,
        2
      )
    );
    return 0;
  }

  write(
    `${title('Providers')} ${muted(`· ${connectedIds.size} connected · ${catalog.providers.length} available`)}`
  );
  write();

  if (providers.length === 0) {
    write(
      muted(
        options.connected
          ? 'No providers are connected yet. Add a key with `surf auth <provider>`.'
          : 'No providers matched. Try `surf providers --all`.'
      )
    );
    return 0;
  }

  table(
    ['Provider', 'ID', 'Status', 'Models', 'Endpoint'],
    providers.map((provider) => {
      const status = statuses.get(provider.id);
      return [
        `${provider.name}${hasFreeApi(provider.id) ? ` ${success(FREE_API_LABEL)}` : ''}`,
        provider.id,
        providerStatusLabel(status, provider, config),
        String(Object.keys(provider.models).length),
        muted(oneLine(config.providers[provider.id]?.baseURL ?? config.customProviders[provider.id]?.baseURL ?? provider.api ?? knownEndpoint(provider) ?? '—', 44))
      ];
    }),
    { protectFirst: true }
  );

  if (!options.all && !options.connected) {
    write();
    write(muted('Showing connected providers and popular defaults. Use --all to list all.'));
  }
  if (providers.some((provider) => hasFreeApi(provider.id))) {
    write(muted(`${FREE_API_LABEL} = ${FREE_API_HINT}; model availability varies.`));
  }
  return 0;
}

export interface UpdateModelsOptions {
  url?: string;
  json?: boolean;
}

export async function updateModelsCommand(options: UpdateModelsOptions): Promise<number> {
  const paths = await ensurePaths();
  try {
    await refreshCatalog(options.url);
  } catch (error) {
    throw new SurfError(`Could not refresh the catalog: ${errorText(error)}`, {
      hint: 'Check your network connection and try again.'
    });
  }
  const catalog = await loadCatalog();
  const models = catalog.providers.reduce(
    (sum, provider) => sum + Object.keys(provider.models).length,
    0
  );
  if (options.json) {
    write(
      JSON.stringify(
        {
          providers: catalog.providers.length,
          models,
          cache: paths.modelsCache,
          updatedAt: catalog.updatedAt ?? null
        },
        null,
        2
      )
    );
    return 0;
  }
  write(
    `${success('✓')} Updated the model catalog ${muted(`· ${catalog.providers.length} providers · ${models} models`)}`
  );
  write(muted(`  ${paths.modelsCache}`));
  return 0;
}

type CheckStatus = 'ok' | 'warn' | 'fail';

interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOptions {
  cwd: string;
  json?: boolean;
  network?: boolean;
}

export async function doctorCommand(options: DoctorOptions): Promise<number> {
  const checks: Check[] = [];
  const paths = getPaths();
  const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0);
  checks.push({
    id: 'node',
    label: 'Node.js',
    status: nodeMajor >= 22 ? 'ok' : 'fail',
    detail: `v${process.versions.node}${nodeMajor >= 22 ? '' : ' (requires >= 22)'}`
  });
  checks.push({
    id: 'platform',
    label: 'Platform',
    status: 'ok',
    detail: `${process.platform} ${process.arch}`
  });
  checks.push({
    id: 'terminal',
    label: 'Terminal',
    status: process.stdout.isTTY && process.stdin.isTTY ? 'ok' : 'warn',
    detail:
      process.stdout.isTTY && process.stdin.isTTY
        ? `${process.stdout.columns ?? '?'}×${process.stdout.rows ?? '?'} TTY`
        : 'not a TTY (headless mode only)'
  });

  let config: SurfConfig | undefined;
  try {
    config = await loadConfig();
    checks.push({
      id: 'config',
      label: 'Config',
      status: 'ok',
      detail: oneLine(paths.configFile, 120)
    });
  } catch (error) {
    checks.push({
      id: 'config',
      label: 'Config',
      status: 'fail',
      detail: oneLine(errorText(error), 200)
    });
  }

  try {
    await ensurePaths();
    checks.push({
      id: 'paths',
      label: 'Directories',
      status: 'ok',
      detail: oneLine(paths.configDir, 120)
    });
  } catch (error) {
    checks.push({
      id: 'paths',
      label: 'Directories',
      status: 'fail',
      detail: oneLine(errorText(error), 200)
    });
  }

  if (process.platform !== 'win32') {
    try {
      const info = await stat(paths.authFile);
      const open = (info.mode & 0o077) !== 0;
      checks.push({
        id: 'auth-file',
        label: 'Credentials',
        status: open ? 'warn' : 'ok',
        detail: open
          ? `${paths.authFile} is readable by other users`
          : `${paths.authFile} is private (0600)`
      });
    } catch {
      checks.push({
        id: 'auth-file',
        label: 'Credentials',
        status: 'ok',
        detail: 'no saved auth file (environment keys still work)'
      });
    }
  }

  let catalog: Catalog | undefined;
  try {
    catalog = await loadCatalog(config);
    const models = catalog.providers.reduce(
      (sum, provider) => sum + Object.keys(provider.models).length,
      0
    );
    checks.push({
      id: 'catalog',
      label: 'Model catalog',
      status: catalogIsStale(catalog.updatedAt) && catalog.source === 'cache' ? 'warn' : 'ok',
      detail: `${catalog.providers.length} providers · ${models} models · ${catalogSummary(catalog)}`
    });
  } catch (error) {
    checks.push({
      id: 'catalog',
      label: 'Model catalog',
      status: 'fail',
      detail: oneLine(errorText(error), 200)
    });
  }

  if (catalog && config) {
    try {
      const statuses = await credentialStatus(catalog.providers, config);
      const connected = statuses.filter((status) => credentialUsable(status, config));
      checks.push({
        id: 'credentials',
        label: 'Connections',
        status: connected.length > 0 ? 'ok' : 'warn',
        detail:
          connected.length > 0
            ? `${connected.length} provider${connected.length === 1 ? '' : 's'}: ${connected
                .slice(0, 8)
                .map((status) => status.provider.id)
                .join(', ')}${connected.length > 8 ? '…' : ''}`
            : 'no providers connected · run `surf auth <provider>`'
      });
    } catch (error) {
      checks.push({
        id: 'credentials',
        label: 'Connections',
        status: 'fail',
        detail: oneLine(errorText(error), 200)
      });
    }

    if (config.provider) {
      try {
        const selection = await resolveSelection(catalog, config, {
          provider: config.provider,
          model: config.model
        });
        checks.push({
          id: 'selection',
          label: 'Selected model',
          status: 'ok',
          detail: `${selection.provider.id}/${selection.model.id} · ${oneLine(selection.provider.baseURL, 80)}`
        });
      } catch (error) {
        checks.push({
          id: 'selection',
          label: 'Selected model',
          status: 'fail',
          detail: oneLine(errorText(error), 220)
        });
      }
    } else {
      checks.push({
        id: 'selection',
        label: 'Selected model',
        status: 'warn',
        detail: 'no provider selected · `surf auth <provider>` or use /connect in the TUI'
      });
    }
  }

  const writable = await assertWritable(options.cwd);
  checks.push({
    id: 'workspace',
    label: 'Workspace',
    status: writable ? 'ok' : 'warn',
    detail: `${options.cwd}${writable ? '' : ' (not writable)'}`
  });

  if (options.network) {
    const started = Date.now();
    try {
      const response = await fetch(process.env.SURFCODE_MODELS_URL || 'https://models.dev/api.json', {
        method: 'HEAD',
        signal: AbortSignal.timeout(8_000)
      });
      checks.push({
        id: 'network',
        label: 'models.dev',
        status: response.ok ? 'ok' : 'warn',
        detail: `HTTP ${response.status} · ${Date.now() - started}ms`
      });
    } catch (error) {
      checks.push({
        id: 'network',
        label: 'models.dev',
        status: 'warn',
        detail: oneLine(errorText(error), 160)
      });
    }
  }

  const failed = checks.some((check) => check.status === 'fail');
  if (options.json) {
    write(
      JSON.stringify(
        {
          ok: !failed,
          version: VERSION,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          cwd: options.cwd,
          configFile: paths.configFile,
          authFile: paths.authFile,
          checks
        },
        null,
        2
      )
    );
    return failed ? 1 : 0;
  }

  write(`${title('Doctor')} ${muted(`· SurfCode on ${process.platform}`)}`);
  write();
  for (const check of checks) {
    const icon =
      check.status === 'ok'
        ? success('✓')
        : check.status === 'warn'
          ? warning('!')
          : danger('✗');
    write(`${icon} ${cell(check.label, 16)} ${muted(safeText(check.detail))}`);
  }
  write();
  const warnings = checks.filter((check) => check.status === 'warn').length;
  if (failed) {
    write(danger(`✗ ${checks.filter((check) => check.status === 'fail').length} check(s) failed`));
  } else if (warnings > 0) {
    write(warning(`! everything essential works · ${warnings} warning${warnings === 1 ? '' : 's'}`));
  } else {
    write(success('✓ everything looks good'));
  }
  return failed ? 1 : 0;
}

function catalogSummary(catalog: Catalog): string {
  if (catalog.source === 'bundled') return 'bundled snapshot';
  const age = catalogAge(catalog.updatedAt);
  if (age === undefined) return 'cached';
  return `cached ${formatAge(catalog.updatedAt ?? Date.now())}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
