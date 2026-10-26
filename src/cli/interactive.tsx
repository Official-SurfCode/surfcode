import { render } from 'ink';
import { discoverLocalModels, loadCatalog } from '../core/catalog.js';
import { loadConfig, updateConfig } from '../core/config.js';
import { SurfError } from '../core/errors.js';
import { latestSession, loadSession } from '../core/session.js';
import type { EffortSetting, SessionRecord, SurfConfig } from '../core/types.js';
import App from '../tui/App.js';
import { getTheme, THEMES } from '../tui/theme.js';
import { accent, muted, prepareStartup, safeText, success, warning, write } from './util.js';

export interface InteractiveOptions {
  cwd: string;
  provider?: string;
  model?: string;
  plan?: boolean;
  theme?: string;
  effort?: EffortSetting;
  session?: string;
  continue?: boolean;
  initialPrompt?: string;
}

export async function runInteractive(options: InteractiveOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new SurfError('The interactive UI needs a terminal', {
      hint: 'Run `surf run "your prompt"` for headless output, or open SurfCode in a TTY.'
    });
  }
  if (options.session && options.continue) {
    throw new SurfError('Choose either --session or --continue, not both.');
  }

  let config = await loadConfig();
  if (options.theme) {
    const wanted = THEMES.find(
      (theme) =>
        theme.name === options.theme?.toLowerCase() ||
        theme.label.toLowerCase() === options.theme?.toLowerCase()
    );
    if (!wanted) {
      throw new SurfError(`Unknown theme "${options.theme}"`, {
        hint: `Available themes: ${THEMES.map((theme) => theme.name).join(', ')}.`
      });
    }
    config = await updateConfig({ theme: wanted.name });
  }
  if (options.effort) {
    config = await updateConfig({ effort: options.effort });
  }

  const catalog = await loadCatalog(config);
  await discoverLocalModels(catalog);

  let session: SessionRecord | undefined;
  if (options.session) {
    session = await loadSession(options.session);
    if (!session) {
      throw new SurfError(`Session not found: ${options.session}`, {
        hint: 'Run `surf sessions` to list saved sessions.'
      });
    }
  } else if (options.continue) {
    session = await latestSession(options.cwd);
    if (!session) {
      throw new SurfError(`No saved sessions for ${options.cwd}`, {
        hint: 'Run `surf` to start a new session.'
      });
    }
  }

  const startup = await prepareStartup({
    config,
    catalog,
    provider: options.provider ?? session?.provider,
    model: options.model ?? session?.model
  });

  const mode = options.plan ? 'plan' : (session?.mode ?? startup.config.mode);
  const themed = getTheme(startup.config.theme);
  const readyConfig: SurfConfig = {
    ...startup.config,
    theme: themed.name,
    mode,
    provider: session?.provider ?? startup.config.provider,
    model: session?.model ?? startup.config.model
  };

  const notices: string[] = [];
  if (startup.note) notices.push(startup.note);
  if (session) {
    const count = session.messages.length;
    notices.push(
      `Resumed ${safeText(session.title)} · ${count} message${count === 1 ? '' : 's'} · ${session.provider}/${session.model}`
    );
  }

  const activeSession = session ?? createEmptySession(options.cwd, readyConfig, mode);
  let finalSession: SessionRecord = activeSession;
  let saved = false;

  const instance = render(
    <App
      cwd={options.cwd}
      config={readyConfig}
      catalog={catalog}
      session={activeSession}
      initialNotice={notices.length > 0 ? notices.join('\n') : undefined}
      initialPrompt={options.initialPrompt?.trim() || undefined}
      onExit={(record, wasSaved) => {
        finalSession = record;
        saved = wasSaved;
      }}
    />,
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 60
    }
  );

  try {
    await instance.waitUntilExit();
  } finally {
    printFarewell(readyConfig, finalSession, saved);
  }
  return 0;
}

function createEmptySession(cwd: string, config: SurfConfig, mode: 'build' | 'plan'): SessionRecord {
  const now = Date.now();
  return {
    version: 1,
    id: `ses_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    title: 'New session',
    cwd,
    provider: config.provider ?? '',
    model: config.model ?? '',
    mode,
    createdAt: now,
    updatedAt: now,
    messages: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      requests: 0
    }
  };
}

function printFarewell(config: SurfConfig, session: SessionRecord, saved: boolean): void {
  write();
  write(`${accent('≋')} ${success('surf’s up.')} ${muted('come back soon.')}`);
  if (saved) {
    write(
      muted(
        `  resume with ${accent(`surf --session ${session.id}`)} ${muted(`· ${config.provider ?? 'no provider'}/${config.model ?? 'no model'}`)}`
      )
    );
  } else {
    write(muted('  start again with ') + accent('surf'));
  }
  if (config.mode === 'plan') write(warning('  plan mode was active'));
}
