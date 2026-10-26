import {
  credentialStatus,
  isKeylessProvider,
  mask,
  removeProviderKey,
  saveProviderKey
} from '../core/auth.js';
import { loadCatalog } from '../core/catalog.js';
import { loadConfig } from '../core/config.js';
import { SurfError } from '../core/errors.js';
import { FREE_API_HINT, FREE_API_LABEL, hasFreeApi } from '../core/free.js';
import { githubTokenStatus, githubViewer } from '../core/github.js';
import { providerHasEndpoint } from '../core/provider.js';
import type { CatalogProvider, SurfConfig } from '../core/types.js';
import {
  accent,
  credentialUsable,
  danger,
  muted,
  oneLine,
  PRIORITY_PROVIDERS,
  providerStatusLabel,
  readSecret,
  success,
  table,
  title,
  warning,
  write
} from './util.js';

const PRIORITY = new Set(PRIORITY_PROVIDERS);

export interface AuthOptions {
  provider?: string;
  key?: string;
  remove?: boolean;
  list?: boolean;
  all?: boolean;
  env?: boolean;
  json?: boolean;
}

export async function authCommand(options: AuthOptions): Promise<number> {
  const config = await loadConfig();
  const catalog = await loadCatalog(config);
  const providerArg = options.provider && options.provider !== 'list' ? options.provider : undefined;

  if (!providerArg) {
    if (options.remove || options.key || options.env) {
      throw new SurfError('A provider is required for this option.', {
        hint: 'Example: surf auth anthropic --key sk-ant-…'
      });
    }
    return await listAuth(config, options);
  }

  if (providerArg.toLowerCase() === 'github') {
    return await githubAuthCommand(options);
  }

  const provider = catalog.providers.find(
    (entry) =>
      entry.id === providerArg ||
      entry.name.toLowerCase() === providerArg.toLowerCase()
  );
  if (!provider) {
    throw new SurfError(`Unknown provider "${providerArg}"`, {
      hint: 'Run `surf providers --all` to browse provider ids.'
    });
  }

  const statuses = await credentialStatus([provider], config);
  const status = statuses[0];

  if (options.env) {
    if (provider.env.length === 0) {
      write(`${warning(provider.name)} does not use environment keys.`);
      if (provider.local) write(muted('  Local providers are keyless; start the server and use /connect.'));
      return 0;
    }
    write(`${title(provider.name)} ${muted('environment variables')}`);
    for (const name of provider.env) {
      const value = process.env[name]?.trim();
      write(`  ${value ? success('●') : muted('○')} ${accent(name)}${value ? muted(' · set') : ''}`);
    }
    return 0;
  }

  if (options.remove) {
    const removed = await removeProviderKey(provider.id);
    if (removed) {
      write(`${success('✓')} Removed the saved key for ${provider.name}.`);
    } else {
      write(muted(`No saved key for ${provider.name}.`));
    }
    if (config.providers[provider.id]?.apiKey || config.customProviders[provider.id]?.apiKey) {
      const location = config.providers[provider.id]?.apiKey
        ? `providers.${provider.id}.apiKey`
        : `customProviders.${provider.id}.apiKey`;
      write(
        warning(
          `  A key is still set in ${location} inside config.json. Remove it there too.`
        )
      );
    }
    return 0;
  }

  if (options.key?.trim()) {
    return await persistKey(provider, options.key, config, Boolean(options.json));
  }

  if (isKeylessProvider(provider)) {
    write(
      `${success('✓')} ${provider.name} is keyless${provider.local ? ' when its local server is running' : ''}.`
    );
    write(muted('  No API key is needed. Use `surf` and /connect, or select a model with --provider.'));
    return 0;
  }

  if (!process.stdin.isTTY) {
    throw new SurfError(`No key supplied for ${provider.name}`, {
      hint: `Pass --key, or set ${provider.env[0] ?? 'the provider API key'} in the environment.`
    });
  }

  write(`${title(provider.name)} ${muted('· paste your API key')}`);
  if (provider.env[0]) write(muted(`  ${provider.env[0]} works too.`));
  const key = await readSecret(`  key › `);
  if (!key) throw new SurfError('The key was empty.');
  return await persistKey(provider, key, config, Boolean(options.json));
}

async function githubAuthCommand(options: AuthOptions): Promise<number> {
  const status = await githubTokenStatus();
  if (options.env) {
    write(`${title('GitHub')} ${muted('environment variables')}`);
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      const value = process.env[name]?.trim();
      write(`  ${value ? success('●') : muted('○')} ${accent(name)}${value ? muted(' · set') : ''}`);
    }
    if (status.source === 'auth') {
      write(muted('  A token is also saved in auth.json.'));
    }
    return 0;
  }
  if (options.remove) {
    const removed = await removeProviderKey('github');
    const remaining = await githubTokenStatus();
    if (!removed && !remaining.configured) {
      write(muted('No saved GitHub token.'));
      return 0;
    }
    if (removed) write(`${success('✓')} Removed the saved GitHub token.`);
    if (remaining.configured) {
      write(warning(`  ${remaining.envName ?? 'An environment token'} is still set and will keep working.`));
    } else {
      write(muted('  GitHub tools will ask you to connect again.'));
    }
    return 0;
  }
  if (options.key?.trim()) {
    return await persistGithubKey(options.key, Boolean(options.json));
  }
  if (!process.stdin.isTTY) {
    throw new SurfError('No GitHub token supplied', {
      hint: 'Pass --key, or set GITHUB_TOKEN / GH_TOKEN in the environment.'
    });
  }

  write(`${title('GitHub')} ${muted('· paste a personal access token')}`);
  write(muted('  Classic scope: repo. Fine-grained: Contents + Administration read/write.'));
  write(muted('  The token is stored in auth.json with mode 600 and is never printed in full.'));
  const key = await readSecret('  token › ');
  if (!key) throw new SurfError('The token was empty.');
  return await persistGithubKey(key, Boolean(options.json));
}

async function persistGithubKey(raw: string, json: boolean): Promise<number> {
  const key = raw.trim();
  if (!key) throw new SurfError('The token was empty.');
  if (/\s/.test(key)) {
    throw new SurfError('That token contains whitespace.', {
      hint: 'Copy it again without line breaks or spaces.'
    });
  }
  const viewer = await githubViewer(key);
  await saveProviderKey('github', key);
  if (json) {
    write(
      JSON.stringify(
        {
          provider: 'github',
          configured: true,
          source: 'auth',
          login: viewer.login,
          masked: mask(key)
        },
        null,
        2
      )
    );
    return 0;
  }
  write(`${success('✓')} Connected to GitHub as ${accent(viewer.login)} ${muted(`· ${mask(key)}`)}`);
  write(muted('  Ask the agent: “create a private repo for this project and upload everything”.'));
  write(muted('  The agent can create repos, upload code, and commit only when you ask.'));
  return 0;
}

async function persistKey(
  provider: CatalogProvider,
  raw: string,
  config: SurfConfig,
  json: boolean
): Promise<number> {
  const key = raw.trim();
  if (!key) throw new SurfError('The key was empty.');
  if (/\s/.test(key)) {
    throw new SurfError('That key contains whitespace.', {
      hint: 'Copy it again without line breaks or spaces.'
    });
  }
  await saveProviderKey(provider.id, key);

  if (json) {
    write(
      JSON.stringify(
        {
          provider: provider.id,
          configured: true,
          source: 'auth',
          masked: mask(key)
        },
        null,
        2
      )
    );
    return 0;
  }

  write(`${success('✓')} Saved a key for ${provider.name} ${muted(`· ${mask(key)}`)}`);
  if (!providerHasEndpoint(provider, config)) {
    const location = config.customProviders[provider.id]
      ? `customProviders.${provider.id}.baseURL`
      : `providers.${provider.id}.baseURL`;
    write(
      warning(
        `  This provider still needs an endpoint. Add ${location} to the config.`
      )
    );
  }
  const configured = (await credentialStatus([provider], config))[0];
  if (configured?.configured === false) {
    write(warning('  The key was saved but the provider is not ready yet.'));
  }
  write(muted('  Start SurfCode with `surf`, or pick a model with `surf models`.'));
  return 0;
}

async function listAuth(config: SurfConfig, options: AuthOptions): Promise<number> {
  const catalog = await loadCatalog(config);
  const statuses = await credentialStatus(catalog.providers, config);
  const github = await githubTokenStatus();
  const byId = new Map(statuses.map((status) => [status.provider.id, status]));
  const configured = statuses.filter((status) => status.configured);
  const ready = statuses.filter((status) => credentialUsable(status, config));
  const readyIds = new Set(ready.map((status) => status.provider.id));

  let providers = catalog.providers.filter((provider) => {
    if (options.all) return true;
    const status = byId.get(provider.id);
    return (
      readyIds.has(provider.id) ||
      Boolean(status?.configured && status.source !== 'keyless') ||
      PRIORITY.has(provider.id) ||
      provider.id === config.provider ||
      provider.custom
    );
  });

  providers.sort((a, b) => {
    const readyOrder = Number(readyIds.has(b.id)) - Number(readyIds.has(a.id));
    if (readyOrder !== 0) return readyOrder;
    const priority =
      (PRIORITY.has(a.id) ? PRIORITY_PROVIDERS.indexOf(a.id) : PRIORITY.size) -
      (PRIORITY.has(b.id) ? PRIORITY_PROVIDERS.indexOf(b.id) : PRIORITY.size);
    if (priority !== 0) return priority;
    return a.name.localeCompare(b.name);
  });

  if (options.json) {
    write(
      JSON.stringify(
        {
          configured: configured.length,
          ready: ready.length,
          total: catalog.providers.length,
          github: {
            configured: github.configured,
            source: github.source ?? null,
            envName: github.envName ?? null,
            masked: github.masked ?? null
          },
          providers: providers.map((provider) => {
            const status = byId.get(provider.id);
            return {
              id: provider.id,
              name: provider.name,
              configured: Boolean(status?.configured),
              usable: status ? credentialUsable(status, config) : false,
              source: status?.source ?? null,
              env: provider.env,
              envName: status?.envName ?? null,
              local: Boolean(provider.local),
              custom: Boolean(provider.custom),
              freeApi: hasFreeApi(provider.id)
            };
          })
        },
        null,
        2
      )
    );
    return 0;
  }

  write(
    `${title('Authentication')} ${muted(`· ${ready.length} ready · ${catalog.providers.length} providers`)}`
  );
  if (ready.length === 0) {
    write();
    write(muted('No provider credentials found. Add one with `surf auth <provider>`.'));
    write(muted('Environment variables are also supported; run `surf auth <provider> --env`.'));
  }
  write();

  table(
    ['Provider', 'ID', 'Status', 'Source', 'Environment'],
    providers.map((provider) => {
      const status = byId.get(provider.id);
      const ready = status ? credentialUsable(status, config) : false;
      let label = providerStatusLabel(status, provider, config);
      if (status?.configured && !ready) {
        label = warning(
          providerHasEndpoint(provider, config) ? 'key saved · not ready' : 'key saved · no endpoint'
        );
      }
      const source = status?.configured
        ? status.source === 'auth'
          ? 'auth.json'
          : status.source === 'env'
            ? oneLine(status.envName ?? 'environment', 20)
            : (status.source ?? '—')
        : '—';
      return [
        `${provider.name}${hasFreeApi(provider.id) ? ` ${success(FREE_API_LABEL)}` : ''}`,
        provider.id,
        label,
        muted(source),
        muted(oneLine(provider.env.join(', ') || '—', 34))
      ];
    }),
    { protectFirst: true }
  );

  if (!options.all) {
    write();
    write(muted('Showing configured providers and popular defaults. Use --all to list all.'));
  }
  write();
  write(
    `${github.configured ? success('●') : muted('○')} ${title('GitHub')} ${muted(
      github.configured
        ? `· connected via ${github.source === 'env' ? github.envName : 'auth.json'} · ${github.masked ?? ''}`
        : '· not connected · /github login or surf auth github'
    )}`
  );
  if (providers.some((provider) => hasFreeApi(provider.id))) {
    write(muted(`${FREE_API_LABEL} = ${FREE_API_HINT}; model availability varies.`));
  }
  if (ready.length > 0) {
    write();
    write(`${success('●')} ${muted(`Ready: ${ready.slice(0, 12).map((status) => status.provider.id).join(', ')}${ready.length > 12 ? '…' : ''}`)}`);
  }
  return 0;
}

export function authHelpText(): string {
  return [
    `${title('surf auth')} ${muted('[provider]')}`,
    muted('  Save an API key in auth.json, or inspect environment variables.'),
    '',
    `${muted('examples')}`,
    `  surf auth anthropic`,
    `  surf auth openai --key sk-…`,
    `  surf auth google --env`,
    `  surf auth openrouter --remove`,
    `  surf auth github`,
    `  surf auth github --key ghp_…`,
    '',
    `${muted('GitHub uses a personal access token for repository creation and publishing.')}`,
    `${muted('keys are stored with mode 600 and are never printed in full.')}`
  ].join('\n');
}

export function missingKeyHint(provider: CatalogProvider): string {
  return provider.env.length > 0
    ? `Run \`surf auth ${provider.id}\` or set ${danger(provider.env.join(' or '))}.`
    : `Run \`surf auth ${provider.id}\`.`;
}
