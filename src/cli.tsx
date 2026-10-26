#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import chalk from 'chalk';
import { Command, InvalidArgumentError } from 'commander';
import { parseEffort } from './core/effort.js';
import { errorMessage, isAbortError, SurfError } from './core/errors.js';
import type { EffortSetting } from './core/types.js';
import { VERSION } from './version.js';
import { authCommand } from './cli/auth.js';
import {
  configEditCommand,
  configGetCommand,
  configPathCommand,
  configSetCommand,
  configShowCommand,
  configValidateCommand
} from './cli/config.js';
import {
  doctorCommand,
  modelsCommand,
  providersCommand,
  updateModelsCommand
} from './cli/inspect.js';
import {
  sessionRemoveCommand,
  sessionShowCommand,
  sessionsListCommand
} from './cli/sessions.js';
import { syncCommand } from './cli/sync.js';
import { danger, muted, warning, writeError } from './cli/util.js';

interface GlobalOptions {
  cwd?: string;
  home?: string;
  color?: boolean;
  provider?: string;
  model?: string;
  plan?: boolean;
  theme?: string;
  continue?: boolean;
  session?: string;
  print?: boolean;
  yes?: boolean;
  json?: boolean;
  quiet?: boolean;
  save?: boolean;
  effort?: EffortSetting;
}

type RunOptions = GlobalOptions & {
  reasoning?: boolean;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
};

const program = new Command();

program
  .name('surf')
  .description(
    'SurfCode — a beautiful, provider-agnostic AI coding agent for your terminal.\nRide the code.'
  )
  .version(VERSION, '-v, --version', 'print the SurfCode version')
  .usage('[prompt...] [options]')
  .argument('[prompt...]', 'prompt to send in the interactive UI (or headless when piped)')
  .option('--cwd <dir>', 'working directory for tools and sessions')
  .option('--home <dir>', 'override the SurfCode config/data directory')
  .option('--no-color', 'disable ANSI color output')
  .option('-p, --provider <id>', 'provider to use')
  .option('-m, --model <model>', 'model id, or provider/model')
  .option('--plan', 'start in read-only plan mode')
  .option('--theme <name>', 'color theme (aurora, dark, ember, forest, violet, mono)')
  .option('--effort <level>', 'reasoning effort (auto, low, medium, high)', effortValue)
  .option('-c, --continue', 'resume the most recent session in this directory')
  .option('-s, --session <id>', 'resume a saved session')
  .option('-P, --print', 'print the response instead of opening the interactive UI')
  .option('-y, --yes', 'auto-approve tool actions in headless mode')
  .option('--json', 'emit newline-delimited JSON events in headless mode')
  .option('--quiet', 'suppress tool progress and summaries in headless mode')
  .option('--no-save', 'do not save the headless session')
  .showSuggestionAfterError()
  .showHelpAfterError()
  .action(async (promptParts: string[], _options, command: Command) => {
    const options = command.optsWithGlobals() as GlobalOptions;
    const cwd = await resolveCwd(options.cwd);
    const prompt = (promptParts ?? []).join(' ').trim() || undefined;
    const headless =
      Boolean(options.print) ||
      Boolean(options.json) ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY;

    if (headless) {
      const { runHeadless } = await import('./cli/headless.js');
      process.exitCode = await runHeadless({
        cwd,
        prompt,
        provider: options.provider,
        model: options.model,
        plan: options.plan,
        yes: options.yes,
        json: options.json,
        quiet: options.quiet,
        save: options.save,
        session: options.session,
        continue: options.continue,
        effort: options.effort
      });
      return;
    }

    const { runInteractive } = await import('./cli/interactive.js');
    process.exitCode = await runInteractive({
      cwd,
      provider: options.provider,
      model: options.model,
      plan: options.plan,
      theme: options.theme,
      session: options.session,
      continue: options.continue,
      effort: options.effort,
      initialPrompt: prompt
    });
  });

program.addHelpText(
  'after',
  `
${chalk.bold('Examples')}
  ${chalk.hex('#5EEAD4')('surf')}                              open the interactive UI
  ${chalk.hex('#5EEAD4')('surf "explain src/core/agent.ts"')}   open the UI and send a prompt
  ${chalk.hex('#5EEAD4')('surf run "fix the failing tests"')}   one-shot headless run
  ${chalk.hex('#5EEAD4')('surf run --json "list the files"')}   newline-delimited JSON events
  ${chalk.hex('#5EEAD4')('surf auth anthropic')}                save an API key
  ${chalk.hex('#5EEAD4')('surf models --provider openai')}      browse the model catalog
  ${chalk.hex('#5EEAD4')('surf doctor')}                        check your setup

${chalk.dim('Run `surf <command> --help` for command-specific flags.')}
`
);

program
  .command('run')
  .description('run one prompt headlessly and print the response')
  .argument('[prompt...]', 'prompt to send; reads stdin when omitted')
  .option('-p, --provider <id>', 'provider to use')
  .option('-m, --model <model>', 'model id, or provider/model')
  .option('--plan', 'read-only plan mode')
  .option('-y, --yes', 'auto-approve tool actions')
  .option('--json', 'emit newline-delimited JSON events')
  .option('--quiet', 'suppress tool progress and the final summary')
  .option('--reasoning', 'stream reasoning text (stderr, or JSON events)')
  .option('--no-save', 'do not save the session')
  .option('-c, --continue', 'resume the most recent session in this directory')
  .option('-s, --session <id>', 'resume a saved session')
  .option('--max-steps <count>', 'maximum tool steps', numberValue)
  .option('--max-tokens <count>', 'maximum output tokens', numberValue)
  .option('--temperature <value>', 'sampling temperature', numberValue)
  .option('--effort <level>', 'reasoning effort (auto, low, medium, high)', effortValue)
  .addHelpText(
    'after',
    `
${chalk.bold('Examples')}
  surf run "summarize this repository"
  surf run -m openai/gpt-5 "refactor the parser"
  cat error.log | surf run "explain this failure"
  surf run --json --yes "run the tests and fix failures"

${chalk.dim('Tool progress goes to stderr, so stdout stays clean for piping.')}
`
  )
  .action(async (promptParts: string[], _options, command: Command) => {
    const options = command.optsWithGlobals() as RunOptions;
    validateNumbers(options);
    const cwd = await resolveCwd(options.cwd);
    const { runHeadless } = await import('./cli/headless.js');
    process.exitCode = await runHeadless({
      cwd,
      prompt: (promptParts ?? []).join(' ').trim() || undefined,
      provider: options.provider,
      model: options.model,
      plan: options.plan,
      yes: options.yes,
      json: options.json,
      quiet: options.quiet,
      reasoning: options.reasoning,
      save: options.save,
      session: options.session,
      continue: options.continue,
      maxSteps: options.maxSteps,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      effort: options.effort
    });
  });

program
  .command('auth')
  .description('connect a provider or inspect saved credentials')
  .argument('[provider]', 'provider id (or "list")')
  .option('--key <key>', 'save this API key without a hidden prompt')
  .option('--remove', 'remove the saved key for a provider')
  .option('--env', 'show the environment variables a provider reads')
  .option('--list', 'list credential status')
  .option('--all', 'list every provider')
  .option('--json', 'emit JSON')
  .addHelpText(
    'after',
    `
${chalk.bold('Examples')}
  surf auth                         show credential status
  surf auth anthropic               save an Anthropic key
  surf auth openai --key sk-…       save non-interactively
  surf auth google --env            show environment variable names
  surf auth openrouter --remove     remove a saved key

${chalk.dim('Keys are stored in auth.json with mode 600. They are never printed in full.')}
`
  )
  .action(async (provider: string | undefined, _options, command: Command) => {
    const options = command.optsWithGlobals() as {
      key?: string;
      remove?: boolean;
      list?: boolean;
      all?: boolean;
      env?: boolean;
      json?: boolean;
    };
    process.exitCode = await authCommand({ provider, ...options });
  });

program
  .command('models')
  .description('browse and search the models.dev catalog')
  .argument('[query...]', 'search model or provider names')
  .option('-p, --provider <id>', 'only show models from one provider')
  .option('--all', 'include embedding, audio, image, and other non-chat models')
  .option('--limit <count>', 'number of models to show', numberValue)
  .option('--refresh', 'refresh the catalog from models.dev first')
  .option('--json', 'emit JSON')
  .addHelpText(
    'after',
    `
${chalk.bold('Examples')}
  surf models                        top recommended chat models
  surf models claude                 search the whole catalog
  surf models --provider anthropic   filter by provider
  surf models --all --limit 100      include every model type
  surf models --refresh              update from models.dev
`
  )
  .action(async (query: string[], _options, command: Command) => {
    const options = command.optsWithGlobals() as {
      provider?: string;
      all?: boolean;
      limit?: number;
      refresh?: boolean;
      json?: boolean;
    };
    if (options.limit !== undefined) validatePositive('limit', options.limit, true);
    process.exitCode = await modelsCommand({ query, ...options });
  });

program
  .command('providers')
  .description('list AI providers and their connection status')
  .argument('[query...]', 'search provider names, ids, or env vars')
  .option('--all', 'show every provider')
  .option('--connected', 'only show connected providers')
  .option('--json', 'emit JSON')
  .addHelpText(
    'after',
    `
${chalk.bold('Examples')}
  surf providers                     connected providers and popular defaults
  surf providers --all               every provider in the catalog
  surf providers --connected         only ready-to-use providers
  surf providers ollama              find local providers
`
  )
  .action(async (query: string[], _options, command: Command) => {
    const options = command.optsWithGlobals() as {
      all?: boolean;
      connected?: boolean;
      json?: boolean;
    };
    process.exitCode = await providersCommand({ query, ...options });
  });

const config = program
  .command('config')
  .description('inspect or edit SurfCode configuration')
  .addHelpText(
    'after',
    `
${chalk.bold('Examples')}
  surf config                        print the effective config
  surf config path                   print the config file path
  surf config get theme
  surf config set theme ember
  surf config set permissions.shell allow
  surf config set providers.anthropic.baseURL https://example.com/v1
  surf config edit
  surf config validate
`
  )
  .action(async () => {
    process.exitCode = await configShowCommand();
  });

config
  .command('path')
  .description('print the config file path')
  .action(async () => {
    process.exitCode = await configPathCommand();
  });

config
  .command('get')
  .description('read one config value by dot path')
  .argument('<key>', 'dot path, e.g. permissions.shell')
  .option('--json', 'emit JSON')
  .action(async (key: string, _options, command: Command) => {
    process.exitCode = await configGetCommand(key, command.optsWithGlobals());
  });

config
  .command('set')
  .description('write one config value by dot path')
  .argument('<key>', 'dot path, e.g. theme')
  .argument('<value>', 'JSON value or plain string')
  .action(async (key: string, value: string) => {
    process.exitCode = await configSetCommand(key, value);
  });

config
  .command('edit')
  .description('open the config in $VISUAL or $EDITOR')
  .action(async () => {
    process.exitCode = await configEditCommand();
  });

config
  .command('validate')
  .description('validate the config file')
  .action(async () => {
    process.exitCode = await configValidateCommand();
  });

const sessions = program
  .command('sessions')
  .description('list, inspect, resume, or delete saved sessions')
  .option('--all', 'show sessions from every working directory')
  .option('--limit <count>', 'number of sessions to show', numberValue)
  .option('--json', 'emit JSON')
  .addHelpText(
    'after',
    `
${chalk.bold('Examples')}
  surf sessions                      sessions in this directory
  surf sessions --all                every saved session
  surf sessions show ses_abc123      print a transcript
  surf sessions resume ses_abc123    continue in the interactive UI
  surf sessions rm ses_abc123        delete a session
`
  )
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals() as {
      cwd?: string;
      all?: boolean;
      limit?: number;
      json?: boolean;
    };
    if (options.limit !== undefined) validatePositive('limit', options.limit, true);
    process.exitCode = await sessionsListCommand({
      cwd: await resolveCwd(options.cwd),
      all: options.all,
      limit: options.limit,
      json: options.json
    });
  });

sessions
  .command('list')
  .description('list saved sessions')
  .option('--all', 'show sessions from every working directory')
  .option('--limit <count>', 'number of sessions to show', numberValue)
  .option('--json', 'emit JSON')
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals() as {
      cwd?: string;
      all?: boolean;
      limit?: number;
      json?: boolean;
    };
    if (options.limit !== undefined) validatePositive('limit', options.limit, true);
    process.exitCode = await sessionsListCommand({
      cwd: await resolveCwd(options.cwd),
      all: options.all,
      limit: options.limit,
      json: options.json
    });
  });

sessions
  .command('show')
  .description('print a saved session transcript')
  .argument('<id>', 'session id or unique prefix')
  .option('--json', 'print the full session JSON')
  .option('--full', 'show complete tool outputs')
  .action(async (id: string, _options, command: Command) => {
    const options = command.optsWithGlobals() as { json?: boolean; full?: boolean };
    process.exitCode = await sessionShowCommand(id, options);
  });

sessions
  .command('rm')
  .alias('delete')
  .description('delete a saved session')
  .argument('<id>', 'session id or unique prefix')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--json', 'emit JSON')
  .action(async (id: string, _options, command: Command) => {
    const options = command.optsWithGlobals() as { yes?: boolean; json?: boolean };
    process.exitCode = await sessionRemoveCommand(id, options);
  });

sessions
  .command('resume')
  .description('resume a saved session in the interactive UI')
  .argument('<id>', 'session id or unique prefix')
  .option('-p, --provider <id>', 'override the provider')
  .option('-m, --model <model>', 'override the model')
  .option('--plan', 'start in read-only plan mode')
  .option('--theme <name>', 'color theme')
  .action(async (id: string, _options, command: Command) => {
    const options = command.optsWithGlobals() as {
      cwd?: string;
      provider?: string;
      model?: string;
      plan?: boolean;
      theme?: string;
    };
    const { runInteractive } = await import('./cli/interactive.js');
    process.exitCode = await runInteractive({
      cwd: await resolveCwd(options.cwd),
      provider: options.provider,
      model: options.model,
      plan: options.plan,
      theme: options.theme,
      session: id
    });
  });

program
  .command('sync')
  .description('sync sessions with a self-hosted, BYOK-friendly endpoint')
  .argument('[action]', 'push, pull, both, status, setup, serve, enable, or disable')
  .option('--url <url>', 'sync server base URL')
  .option('--token <token>', 'sync bearer token')
  .option('--auto', 'push after every completed turn')
  .option('--port <port>', 'sync server port (default 8787)', numberValue)
  .option('--host <host>', 'sync server bind address (default 127.0.0.1)')
  .option('--data-dir <dir>', 'sync server storage directory')
  .option('--json', 'emit JSON')
  .addHelpText(
    'after',
    `
${chalk.bold('Examples')}
  surf sync setup --url https://sync.example.com --token ...  configure sync
  surf sync status                                          show sync state
  surf sync push                                            push local sessions
  surf sync pull                                            pull remote sessions
  surf sync                                                 push and pull
  surf sync serve --port 8787                               run a self-hosted store

${chalk.dim('Only sessions are uploaded. Provider API keys never leave your machine.')}
`
  )
  .action(async (action: string | undefined, _options, command: Command) => {
    const options = command.optsWithGlobals() as {
      url?: string;
      token?: string;
      auto?: boolean;
      port?: number;
      host?: string;
      dataDir?: string;
      json?: boolean;
    };
    if (options.port !== undefined) validatePositive('port', options.port, false);
    process.exitCode = await syncCommand({ action, ...options });
  });

program
  .command('doctor')
  .description('check your SurfCode installation and configuration')
  .option('--json', 'emit JSON')
  .option('--network', 'also test connectivity to models.dev')
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals() as {
      cwd?: string;
      json?: boolean;
      network?: boolean;
    };
    process.exitCode = await doctorCommand({
      cwd: await resolveCwd(options.cwd),
      json: options.json,
      network: options.network
    });
  });

program
  .command('update-models')
  .description('refresh the models.dev catalog cache')
  .option('--url <url>', 'alternate models.dev-compatible JSON endpoint')
  .option('--json', 'emit JSON')
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals() as { url?: string; json?: boolean };
    process.exitCode = await updateModelsCommand(options);
  });

program.hook('preAction', (_thisCommand, actionCommand) => {
  const options = actionCommand.optsWithGlobals() as GlobalOptions;
  if (options.home) {
    process.env.SURFCODE_HOME = resolve(expandHome(options.home));
  }
  if (options.color === false) chalk.level = 0;
});

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  handleError(error);
}

function handleError(error: unknown): void {
  if (error instanceof SurfError) {
    writeError(`${danger('error')} ${error.message}`);
    if (error.hint) writeError(muted(`  ${error.hint}`));
    process.exitCode = error.exitCode;
    return;
  }
  if (isAbortError(error)) {
    writeError(warning('aborted'));
    process.exitCode = 130;
    return;
  }
  writeError(`${danger('error')} ${errorMessage(error)}`);
  if (process.env.SURFCODE_DEBUG && error instanceof Error && error.stack) {
    writeError(muted(error.stack));
  }
  process.exitCode = 1;
}

async function resolveCwd(value?: string): Promise<string> {
  const target = resolve(expandHome(value ?? process.cwd()));
  try {
    const info = await stat(target);
    if (!info.isDirectory()) throw new SurfError(`Not a directory: ${target}`);
  } catch (error) {
    if (error instanceof SurfError) throw error;
    throw new SurfError(`Working directory not found: ${target}`);
  }
  return target;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function numberValue(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new InvalidArgumentError(`Expected a number, got "${value}".`);
  return parsed;
}

function effortValue(value: string): EffortSetting {
  const parsed = parseEffort(value);
  if (!parsed) {
    throw new InvalidArgumentError(`Expected auto, low, medium, or high; got "${value}".`);
  }
  return parsed;
}

function validateNumbers(options: RunOptions): void {
  if (options.maxSteps !== undefined) validatePositive('max-steps', options.maxSteps, false);
  if (options.maxTokens !== undefined) validatePositive('max-tokens', options.maxTokens, false);
  if (options.temperature !== undefined) {
    if (options.temperature < 0 || options.temperature > 2) {
      throw new SurfError('temperature must be between 0 and 2.');
    }
  }
}

function validatePositive(name: string, value: number, integer: boolean): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SurfError(`--${name} must be a positive number.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new SurfError(`--${name} must be a whole number.`);
  }
}
