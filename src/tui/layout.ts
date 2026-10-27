import type { Theme } from './theme.js';
import { ICONS } from './icons.js';
import { VERSION } from '../version.js';
import {
  bg,
  center,
  chalk,
  dim,
  fg,
  fit,
  gradient,
  shimmer,
  truncate,
  visibleWidth
} from './ansi.js';

export interface HeroInfo {
  cwd: string;
  provider?: string;
  model?: string;
  mode: 'build' | 'plan';
  configuredProviders: number;
  totalProviders: number;
  /** Bumped while the intro wordmark is animating. */
  tick?: number;
}

const LOGO = [
  '  ▀▀▀▓▄▄        ▄▄▄ ▄▄      ▀▀▀▓▄▄       ▀▀▀▓▄▄       ▀▀▀▓▄▄       ▀▀▀▓▄▄         ▀▀▀▓▄▄         ▀▀▀▓▄▄    ',
  ' ▄██▄░▀██▓▄   ▄███  ▐██▄   ▄██▄░▀██▓▄   ▄██▄░▀██▓▄   ▄██▄░▀██▓▄      ░░▀██▓▄     ▄██▄░▀██▓▄     ▄██▄░▀██▓▄ ',
  '▀ ▀░░░░░▀██▓ ▐███▌   ███▌▒▀ ▀░░░░░███▓▒▀ ▀░░░░░███▓▒▀ ▀░░░░░███▓  ▄▄█▀ ░▒███▓▄ ▒▀ ▀░░░░░███▓▄ ▒▀ ▀░░░░░███▓',
  ' ░░▐▒▒▄▄▄    █░░▌    ░░░█  ░░▐▒▒▄░ ░░▌  ░░▐▒▒ ░ ▀▀   ░░▐▒▒ ░ ▀░▌ █░░     ░░░░░▌  ░░▐▒▒ ░░░░░░▌  ░░▐▒▒ ░ ▀▀ ',
  '  ░  ▀▀░░▒▒  ▒▒█   ░▐▒▒▒▒   ░▐▓▓▐▒▌▒▀    ░▐▓▓ ▄▓▀     ░▐▓▓      ▐▒▒▌     ░▐▒▒▒▒   ░▐▓▓  ░▐▒▒▒▒   ░▐▓▓ ▄▓▀  ',
  '  ▄▓    ▀▓▓█ ▐▓▓▄ ░▒▓▓▓▓▌    █▓▀  ▀▓▓▄    ▀▓█       ▄  ▀▓▀  ▄█▓▄ ▓▓▓▄   ░▒▓▓▓▓▌ ▄  ▀▓▀   ▓▓▓▓▌ ▄  ▀▓▀  ▄▄▄ ',
  ' ▀▓█▓▄▄ ▓███  ▀███▄▓███▀   ▀███▄  ▓███    ▐█         ▀█▄▀█▄▄▓▓▒▀  ▀███▄▄▄▓███▀   ▀█▄▄▄▄▄▓███▀   ▀█▄▄▄▄▄▓███',
  '   ▀▀  ▀▀▀▀      ▀▀▀▀▀       ▀▀  ▀▀▀▀      ▀▌            ▀▀▀▀▀       ▀▀▀▀▀▀▀        ▀▀▀▀▀▀▀        ▀▀▀▀▀▀▀ '
];

const COMPACT_LOGO = [
  '   ______  _____  _____________  ___  ____',
  '  / __/ / / / _ \\/ __/ ___/ __ \\/ _ \\/ __/',
  ' _\\ \\/ /_/ / , _/ _// /__/ /_/ / // / _/',
  '/___/\\____/_/|_/_/  \\___/\\____/____/___/'
];

const LOGO_WIDTH = Math.max(...LOGO.map((line) => visibleWidth(line)));

function revealLogo(line: string, lineIndex: number, tick: number): string {
  const chars = [...line];
  const columns = Math.max(0, Math.floor((tick / 27) * (LOGO_WIDTH + 10)) - lineIndex * 2);
  return chars.map((char, index) => (index < columns ? char : ' ')).join('');
}

export function renderHero(info: HeroInfo, width: number, theme: Theme, maxHeight = 20): string[] {
  const compact = width < LOGO_WIDTH + 2 || maxHeight < 18;
  if (compact) return renderCompactHero(info, width, theme, maxHeight);
  const lines: string[] = [];
  lines.push('');
  for (let index = 0; index < LOGO.length; index += 1) {
    const source = info.tick === undefined ? LOGO[index]! : revealLogo(LOGO[index]!, index, info.tick);
    const colored = info.tick === undefined ? gradient(source, theme.gradient) : shimmer(source, theme.gradient, info.tick);
    lines.push(center(colored, width));
  }
  lines.push('');
  lines.push(center(chalk.bold(fg(theme.text, 'terminal-native AI engineering')), width));
  lines.push(center(dim('ride the code.') + ' ' + gradient(ICONS.assistant, theme.gradient), width));
  lines.push('');
  if (info.provider && info.model) {
    const label = `${fg(theme.success, ICONS.done)} ${fg(theme.accent, info.provider)}${dim('/')}${fg(theme.text, truncate(info.model, Math.max(10, width - 30)))}`;
    lines.push(center(label, width));
    lines.push(center(`${dim(shortenHome(info.cwd))}  ${dim(ICONS.bullet)}  ${dim(`${info.mode} mode`)}`, width));
  } else if (info.configuredProviders > 0) {
    lines.push(center(`${fg(theme.warning, ICONS.active)} ${fg(theme.text, 'providers connected, no model selected')}`, width));
    lines.push(center(dim('/model to choose a model'), width));
  } else {
    lines.push(center(`${fg(theme.warning, ICONS.pending)} ${fg(theme.text, 'no provider connected')}`, width));
    lines.push(
      center(`${dim('/connect to add a key')} ${dim(ICONS.bullet)} ${dim(`${info.totalProviders} providers in the catalog`)}`, width)
    );
  }
  lines.push('');
  const hints =
    width >= 78
      ? `/commands   @files   !shell   shift+tab ${info.mode === 'plan' ? 'build' : 'plan'} mode   ?keys`
      : '/commands   @files   !shell   ?keys';
  lines.push(center(dim(hints), width));
  lines.push(center(dim(`v${VERSION}`), width));
  return lines;
}

function renderCompactHero(info: HeroInfo, width: number, theme: Theme, maxHeight: number): string[] {
  const tiny = width < 54 || maxHeight < 9;
  const lines = tiny ? ['', center(gradient('≋ SURFCODE', theme.gradient), width)] : ['', ...COMPACT_LOGO.map((line) => center(gradient(line, theme.gradient), width))];
  lines.push(center(dim('ride the code.'), width));
  if (info.provider && info.model) {
    lines.push(center(`${fg(theme.success, ICONS.done)} ${fg(theme.text, truncate(`${info.provider}/${info.model}`, Math.max(10, width - 4)))}`, width));
  } else {
    lines.push(center(`${fg(theme.warning, ICONS.pending)} ${dim('no provider · /connect')}`, width));
  }
  lines.push('');
  lines.push(center(dim('/commands   @files   ?keys'), width));
  return lines;
}

export interface InputOptions {
  value: string;
  cursor: number;
  placeholder: string;
  title?: string;
  hint?: string;
  theme: Theme;
  focused: boolean;
  secret?: boolean;
  maxRows?: number;
  /** `minimal` is the main chat prompt: rounded, borderless chrome, no title or hint. */
  variant?: 'box' | 'minimal';
}

export interface InputRender {
  lines: string[];
  contentRows: number;
}

export function renderInput(options: InputOptions, width: number): InputRender {
  const { value, cursor, placeholder, theme, focused } = options;
  const minimal = options.variant === 'minimal';
  const title = minimal ? undefined : options.title;
  const hint = minimal ? undefined : options.hint;
  const borderColor = focused ? theme.accent2 : theme.border;
  const top = title
    ? `${fg(borderColor, '╭─')} ${fg(focused ? theme.accent : theme.dim, title)} ${fg(borderColor, '─'.repeat(Math.max(0, width - visibleWidth(title) - 6)))}${fg(borderColor, '─╮')}`
    : `${fg(borderColor, '╭')}${fg(borderColor, '─'.repeat(Math.max(1, width - 2)))}${fg(borderColor, '╮')}`;
  const lines: string[] = [top];

  const safeValue = value.replace(/\t/g, '  ');
  const clampedCursor = Math.max(0, Math.min(cursor, safeValue.length));
  const beforeCursor = safeValue.slice(0, clampedCursor);
  const cursorRow = (beforeCursor.match(/\n/g) ?? []).length;
  const lastNewline = beforeCursor.lastIndexOf('\n');
  const cursorCol = clampedCursor - lastNewline - 1;
  const logicalRows = safeValue.split('\n');
  const maxRows = Math.max(1, options.maxRows ?? 5);
  const start = Math.max(0, Math.min(cursorRow - maxRows + 1, logicalRows.length - 1));
  const end = Math.min(logicalRows.length, start + maxRows);
  const contentWidth = Math.max(4, width - 6);

  if (safeValue === '' && placeholder) {
    const cursorGlyph = focused ? chalk.inverse(fg(theme.accent, ' ')) : '';
    const visible = truncate(placeholder, Math.max(1, contentWidth - (focused ? 1 : 0)));
    const content = `${cursorGlyph}${dim(visible)}`;
    lines.push(`${fg(borderColor, '│')} ${fg(theme.accent, ICONS.prompt)} ${fit(content, contentWidth)} ${fg(borderColor, '│')}`);
  } else {
    for (let row = start; row < end; row += 1) {
      const logical = logicalRows[row] ?? '';
      let shown = options.secret ? '•'.repeat([...logical].length) : logical;
      let localCursor = row === cursorRow ? (options.secret ? [...logical.slice(0, cursorCol)].length : cursorCol) : -1;
      let windowed = shown;
      if (localCursor >= contentWidth - 1) {
        const chars = [...shown];
        const shift = Math.max(0, localCursor - contentWidth + 2);
        windowed = `…${chars.slice(shift).join('')}`;
        localCursor = localCursor - shift + 1;
      }
      windowed = fit(windowed, contentWidth);
      if (focused && localCursor >= 0) {
        const chars = [...windowed];
        const at = Math.min(localCursor, Math.max(0, contentWidth - 1));
        const char = chars[at] && chars[at] !== ' ' ? chars[at]! : ' ';
        chars[at] = chalk.inverse(fg(theme.accent, char));
        windowed = chars.join('');
      }
      if (windowed === '') windowed = ' '.repeat(contentWidth);
      const prefix = row === 0 ? `${fg(borderColor, '│')} ${fg(theme.accent, ICONS.prompt)} ` : `${fg(borderColor, '│')}   `;
      lines.push(`${prefix}${fit(windowed, contentWidth)} ${fg(borderColor, '│')}`);
    }
  }

  const hintText = hint ? truncate(hint, Math.max(5, width - 6)) : '';
  const bottom = hint
    ? `${fg(borderColor, '╰─')} ${dim(hintText)} ${fg(borderColor, '─'.repeat(Math.max(0, width - visibleWidth(hintText) - 6)))}${fg(borderColor, '─╯')}`
    : `${fg(borderColor, '╰')}${fg(borderColor, '─'.repeat(Math.max(1, width - 2)))}${fg(borderColor, '╯')}`;
  lines.push(bottom);
  return { lines, contentRows: Math.max(1, end - start) };
}

export type ComposerState = StatusInfo['state'];

export interface ComposerOptions {
  value: string;
  cursor: number;
  placeholder: string;
  theme: Theme;
  focused: boolean;
  mode: 'build' | 'plan';
  model?: string;
  /** Current agent state; drives the activity line above the panel. */
  state?: ComposerState;
  secret?: boolean;
  maxRows?: number;
}

export interface ComposerRender {
  lines: string[];
  contentRows: number;
  /** Number of lines occupied by the bordered panel itself. */
  inputRows: number;
}

/** Human-readable agent state for the compact line above the composer. */
export function composerActivity(state: ComposerState = 'ready'): string {
  switch (state) {
    case 'permission':
      return 'Waiting for approval…';
    case 'stopping':
      return 'Stopping…';
    case 'sync':
      return 'Syncing…';
    case 'thinking':
      return 'Thinking…';
    case 'streaming':
      return 'Writing…';
    case 'tool':
      return 'Working…';
    case 'error':
      return 'Something went wrong';
    default:
      return 'Ready';
  }
}

/**
 * Codex-style chat composer: an activity line, a mode/model line, then a
 * roomy filled input panel. The version stays visible in the header so it can
 * be checked without opening help.
 */
export function renderComposer(options: ComposerOptions, width: number): ComposerRender {
  const { theme, mode } = options;
  const state = options.state ?? 'ready';
  const version = `v${VERSION}`;
  const lines: string[] = [];

  const activityColor = state === 'ready' ? theme.dim : state === 'error' ? theme.error : theme.text;
  const activity = `${fg(theme.accent, '~')} ${fg(activityColor, composerActivity(state))}`;
  const versionWidth = visibleWidth(version);
  if (width <= versionWidth) {
    lines.push(fit(dim(version), width));
  } else {
    const activityWidth = width - versionWidth - 1;
    lines.push(`${fit(activity, activityWidth)} ${dim(version)}`);
  }

  const modeLabel = mode === 'plan' ? 'Plan' : 'Build';
  const modeColor = mode === 'plan' ? theme.warning : theme.accent2;
  const modelLabel = options.model
    ? `${dim(ICONS.bullet)} ${fg(theme.text, truncate(options.model, Math.max(8, width - 14)))}`
    : `${dim(ICONS.bullet)} ${dim('no model selected')}`;
  const modeLine = `${fg(modeColor, `${ICONS.selected} ${modeLabel}`)} ${modelLabel}`;
  lines.push(fit(modeLine, width));

  const input = renderInput(
    {
      value: options.value,
      cursor: options.cursor,
      placeholder: options.placeholder,
      theme,
      focused: options.focused,
      secret: options.secret,
      maxRows: options.maxRows ?? 6,
      variant: 'minimal'
    },
    width
  );

  const borderColor = options.focused ? theme.accent2 : theme.border;
  const panelLines = input.lines.slice(0, -1);
  const bottom = input.lines[input.lines.length - 1] ?? '';
  // One breathing row under the text, even for a single-line prompt.
  panelLines.push(`${fg(borderColor, '│')}${' '.repeat(Math.max(0, width - 2))}${fg(borderColor, '│')}`);
  panelLines.push(bottom);

  const paint = (line: string): string => {
    const padded = fit(line, width);
    return theme.panel ? bg(theme.panel, padded) : padded;
  };

  return {
    lines: [...lines, ...panelLines.map(paint)],
    contentRows: input.contentRows,
    inputRows: panelLines.length
  };
}

export interface StatusInfo {
  theme: Theme;
  width: number;
  hint: string;
  contextUsed: number;
  contextWindow: number;
  cost: number;
  state: 'ready' | 'thinking' | 'streaming' | 'tool' | 'permission' | 'stopping' | 'sync' | 'error';
  spinner: string;
  scrollOffset?: number;
  mode: 'build' | 'plan';
  effort?: string;
  provider?: string;
  model?: string;
  /** Full computer access is enabled. */
  fullAccess?: boolean;
  /** Number of configured worker models. */
  agentWorkers?: number;
  /** Live token painting is enabled. */
  streaming?: boolean;
  /** Low-frequency tick for the animated brand mark. */
  tick?: number;
}

const BRAND_PALETTE = ['#22D3EE', '#60A5FA', '#818CF8', '#C084FC', '#F472B6', '#FBBF24', '#34D399'];
const BRAND_WAVES = [
  ['▁', '▃'],
  ['▂', '▅'],
  ['▃', '▇'],
  ['▄', '▆'],
  ['▅', '▄'],
  ['▆', '▂'],
  ['▇', '▁'],
  ['▄', '▃']
] as const;
const BRAND_TEXT = 'SURFCODE';
/** Visible width of renderBrand(): two equalizer cells, a space, then the wordmark. */
export const BRAND_WIDTH = BRAND_TEXT.length + 3;
export const BRAND_FRAME_MS = 110;

export function brandTick(now = Date.now()): number {
  return Math.floor(now / BRAND_FRAME_MS);
}

/**
 * A tiny rainbow loop for the bottom-right corner. It deliberately ignores the
 * theme gradient so the mark stays colorful even in mono mode.
 */
export function renderBrand(_theme: Theme, tick = 0): string {
  const index = Math.abs(tick) % BRAND_WAVES.length;
  const wave = BRAND_WAVES[index] ?? ['▁', '▃'];
  const color = BRAND_PALETTE[index % BRAND_PALETTE.length] ?? '#22D3EE';
  const color2 = BRAND_PALETTE[(index + 3) % BRAND_PALETTE.length] ?? '#C084FC';
  return `${fg(color, wave[0])}${fg(color2, wave[1])} ${shimmer(BRAND_TEXT, BRAND_PALETTE, tick)}`;
}

export function renderStatus(info: StatusInfo): string {
  if (info.width <= 0) return '';
  const stateColor =
    info.state === 'error'
      ? info.theme.error
      : info.state === 'permission' || info.state === 'stopping'
        ? info.theme.warning
        : info.state === 'ready'
          ? info.theme.success
          : info.theme.accent2;
  const stateIcon =
    info.state === 'ready'
      ? ICONS.done
      : info.state === 'permission'
        ? ICONS.warning
        : info.state === 'stopping'
          ? ICONS.stop
          : info.state === 'sync'
            ? ICONS.sync
            : info.state === 'error'
              ? ICONS.error
              : info.spinner;
  const stateLabel =
    info.state === 'ready'
      ? 'ready'
      : info.state === 'permission'
        ? 'approval needed'
        : info.state === 'stopping'
          ? 'stopping'
          : info.state === 'sync'
            ? 'syncing'
            : info.state === 'thinking'
              ? 'thinking'
              : info.state === 'streaming'
                ? 'streaming'
                : info.state === 'tool'
                  ? 'tool'
                  : 'error';

  const ratio = info.contextWindow > 0 ? info.contextUsed / info.contextWindow : 0;
  const contextColor = ratio > 0.9 ? info.theme.error : ratio > 0.7 ? info.theme.warning : info.theme.dim;
  const context = `${fg(contextColor, `${ICONS.context} ${formatTokens(info.contextUsed)}/${formatTokens(info.contextWindow)}`)}`;
  const costText = info.cost > 0 ? ` ${dim(ICONS.bullet)} ${dim(`$${info.cost < 0.01 ? info.cost.toFixed(4) : info.cost.toFixed(2)}`)}` : '';
  const scroll = info.scrollOffset && info.scrollOffset > 0 ? `${fg(info.theme.warning, `↑${info.scrollOffset}`)} ` : '';
  const mode = info.mode === 'plan' ? fg(info.theme.warning, 'plan') : dim('build');
  const effort = info.effort ? fg(info.theme.accent2, info.effort) : '';
  const model =
    info.model && info.width >= 120
      ? `${info.provider ? `${dim(info.provider)}${dim('/')}` : ''}${fg(info.theme.text, truncate(info.model, 24))}`
      : '';
  const access = info.fullAccess ? fg(info.theme.error, 'full access') : '';
  const agents = info.agentWorkers
    ? fg(info.theme.accent3, `agent ${info.agentWorkers}`)
    : '';
  const meta =
    info.width >= 72
      ? [
          mode,
          ...(effort ? [effort] : []),
          ...(model ? [model] : []),
          ...(access ? [access] : []),
          ...(agents ? [agents] : [])
        ].join(` ${dim(ICONS.bullet)} `)
      : '';
  const state = fg(stateColor, `${stateIcon} ${stateLabel}`);
  const rightCore =
    info.width < 48
      ? `${scroll}${state}`
      : `${scroll}${meta ? `${meta} ${dim(ICONS.bullet)} ` : ''}${context}${costText} ${dim(ICONS.bullet)} ${state}`;
  const brand = renderBrand(info.theme, info.tick);
  const brandWidth = visibleWidth(brand);
  if (info.width <= brandWidth + 1) return fit(brand, info.width, 'right');

  // Keep the brand pinned to the far right even when the rest of the status
  // line has to be clipped on narrow terminals.
  const rightCap = Math.max(
    brandWidth,
    Math.min(visibleWidth(rightCore) + brandWidth + 1, Math.floor(info.width * 0.62))
  );
  const coreWidth = Math.max(0, rightCap - brandWidth - 1);
  const core = coreWidth > 0 ? fit(rightCore, coreWidth, 'right') : '';
  const right = core ? `${core} ${brand}` : brand;
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(1, info.width - rightWidth - 1);
  return `${fit(dim(info.hint), leftWidth)} ${right}`;
}

export function renderHelp(width: number, theme: Theme): string[] {
  const lines: string[] = [];
  lines.push(`  ${chalk.bold(gradient('Commands', theme.gradient))}`);
  lines.push('');
  const commands: Array<[string, string]> = [
    ['/model', 'switch model'],
    ['/connect', 'add a provider key'],
    ['/provider', 'browse providers'],
    ['/theme', 'change theme'],
    ['/explorer', 'focus explorer dock'],
    ['/options', 'settings and toggles'],
    ['/sessions', 'resume a session'],
    ['/sync', 'sync sessions (BYOK)'],
    ['/stop', 'stop generating'],
    ['/compact', 'summarize context'],
    ['/btw', 'ask a side question'],
    ['/github', 'connect and publish'],
    ['/plan', 'read-only planning'],
    ['/build', 'switch to build mode'],
    ['/effort', 'set reasoning effort'],
    ['/thinking', 'toggle reasoning'],
    ['/stream', 'toggle token painting'],
    ['/access', 'full computer access'],
    ['/agent', 'parallel worker models'],
    ['/verbose', 'toggle tool output'],
    ['/clear', 'clear screen'],
    ['/new', 'new session'],
    ['/context', 'context usage'],
    ['/cost', 'session cost'],
    ['/export', 'export transcript'],
    ['/help', 'this screen'],
    ['/quit', 'exit']
  ];
  const colWidth = Math.max(26, Math.floor((width - 6) / 2));
  for (let index = 0; index < commands.length; index += 2) {
    const left = commands[index]!;
    const right = commands[index + 1];
    const leftText = `  ${fg(theme.accent, left[0].padEnd(11))} ${dim(left[1])}`;
    const rightText = right ? `  ${fg(theme.accent, right[0].padEnd(11))} ${dim(right[1])}` : '';
    lines.push(`${fit(leftText, colWidth)}${rightText}`);
  }
  lines.push('');
  lines.push(`  ${chalk.bold(gradient('Keys', theme.gradient))}`);
  lines.push('');
  const keys: Array<[string, string]> = [
    ['enter', 'send'],
    ['ctrl+j', 'newline'],
    ['esc', 'stop / leave explorer'],
    ['ctrl+c', 'interrupt / exit'],
    ['pgup/pgdn', 'scroll'],
    ['shift+tab', 'plan / build'],
    ['ctrl+t', 'cycle theme'],
    ['ctrl+o', 'focus explorer'],
    ['ctrl+←/→', 'resize explorer'],
    ['[ ]', 'resize when focused'],
    ['ctrl+v', 'paste clipboard'],
    ['!', 'shell mode']
  ];
  for (let index = 0; index < keys.length; index += 2) {
    const left = keys[index]!;
    const right = keys[index + 1];
    const leftText = `  ${fg(theme.accent2, left[0].padEnd(11))} ${dim(left[1])}`;
    const rightText = right ? `  ${fg(theme.accent2, right[0].padEnd(11))} ${dim(right[1])}` : '';
    lines.push(`${fit(leftText, colWidth)}${rightText}`);
  }
  lines.push('');
  lines.push(`  ${dim('Tip: drop a SURFCODE.md or AGENTS.md in a project for persistent instructions.')}`);
  return lines;
}

export function shortenHome(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}
