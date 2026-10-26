import type { Theme } from './theme.js';
import { ICONS } from './icons.js';
import { FREE_API_LABEL } from '../core/free.js';
import type { PermissionRequest } from '../core/types.js';
import type { ExplorerEntry, ExplorerPreview } from './explorer.js';
import { renderMarkdown, sanitizeTerminal } from './markdown.js';
import { formatDuration } from './render.js';
import {
  chalk,
  dim,
  fg,
  fit,
  gradient,
  truncate,
  visibleWidth,
  wrap
} from './ansi.js';
import { renderHelp } from './layout.js';

export interface PickerItem {
  id: string;
  label: string;
  sublabel?: string;
  right?: string;
  configured?: boolean;
  badge?: string;
  freeApi?: boolean;
  accent?: string;
}

export interface PickerOptions {
  title: string;
  subtitle?: string;
  items: PickerItem[];
  selected: number;
  width: number;
  height: number;
  theme: Theme;
  emptyText?: string;
  footer?: string;
}

export function renderPicker(options: PickerOptions): string[] {
  const { width, height, theme, items, selected } = options;
  const lines: string[] = [];
  if (height < 5 || width < 20) {
    return items.slice(0, Math.max(0, height)).map((item, index) => `${index === selected ? ICONS.selected : ' '} ${truncate(item.label, width - 4)}`);
  }
  const title = `─ ${chalk.bold(gradient(options.title.toUpperCase(), theme.gradient))} `;
  const border = fg(theme.border, '─');
  const topFill = Math.max(0, width - visibleWidth(title) - 2);
  lines.push(`${fg(theme.border, '╭')}${title}${border.repeat(topFill)}${fg(theme.border, '╮')}`);
  if (options.subtitle) {
    lines.push(`${fg(theme.border, '│')} ${fit(dim(options.subtitle), width - 4)} ${fg(theme.border, '│')}`);
    lines.push(`${fg(theme.border, '├')}${border.repeat(width - 2)}${fg(theme.border, '┤')}`);
  }
  const headerRows = options.subtitle ? 3 : 1;
  const footerRows = 1;
  const visibleRows = Math.max(1, height - headerRows - footerRows - 1);
  const start = Math.max(0, Math.min(selected - Math.floor(visibleRows / 2), Math.max(0, items.length - visibleRows)));
  const page = items.slice(start, start + visibleRows);
  const contentWidth = Math.max(5, width - 4);

  if (page.length === 0) {
    lines.push(`${fg(theme.border, '│')} ${fit(dim(options.emptyText ?? 'No matches. Try a different search.'), contentWidth)} ${fg(theme.border, '│')}`);
  }
  for (const [index, item] of page.entries()) {
    const absolute = start + index;
    const active = absolute === selected;
    const marker = active ? fg(theme.accent, ICONS.selected) : ' ';
    const dot =
      item.configured === undefined
        ? ''
        : item.configured
          ? fg(theme.success, ICONS.done)
          : fg(theme.dim, ICONS.pending);
    const freeBadge = item.freeApi ? fg(theme.success, FREE_API_LABEL) : '';
    const badge = item.badge ? fg(theme.faint, `[${item.badge}]`) : '';
    const badges = [freeBadge, badge].filter(Boolean).join(' ');
    const right = item.right ? dim(item.right) : '';
    const rightWidth = Math.min(visibleWidth(right), Math.floor(contentWidth * 0.4));
    const labelWidth = Math.max(5, contentWidth - rightWidth - (right ? 2 : 0) - (dot ? 2 : 0) - (badges ? visibleWidth(badges) + 1 : 0) - 2);
    let label = fit(item.label, labelWidth);
    if (active) label = chalk.bold(fg(theme.text, item.label.length > labelWidth ? truncate(item.label, labelWidth - 1) + '…' : item.label));
    const left = `${marker} ${dot ? `${dot} ` : ''}${label}${badges ? ` ${badges}` : ''}`;
    const row = `${fit(left, contentWidth - rightWidth - (right ? 1 : 0))}${right ? ` ${fit(right, rightWidth, 'right')}` : ''}`;
    lines.push(`${fg(active ? theme.accent : theme.border, '│')} ${fit(row, contentWidth)} ${fg(active ? theme.accent : theme.border, '│')}`);
  }
  while (lines.length < height - 1) {
    lines.push(`${fg(theme.border, '│')} ${' '.repeat(width - 4)} ${fg(theme.border, '│')}`);
  }
  const footerText = options.footer ?? `${items.length === 0 ? 0 : start + 1}–${Math.min(start + visibleRows, items.length)} of ${items.length}`;
  const footer = truncate(dim(footerText), Math.max(1, width - 6));
  lines.push(`${fg(theme.border, '╰─')} ${fit(footer, Math.max(1, width - 6))} ${fg(theme.border, '─╯')}`);
  return lines.slice(0, height);
}

export interface ThemePickerOptions {
  themes: Theme[];
  selected: number;
  width: number;
  height: number;
  active: Theme;
}

export function renderThemePicker(options: ThemePickerOptions): string[] {
  const items: PickerItem[] = options.themes.map((theme) => ({
    id: theme.name,
    label: theme.label,
    sublabel: theme.description,
    right: `${theme.gradient.map((color) => fg(color, '■')).join('')} ${theme.description}`,
    configured: theme.name === options.active.name,
    badge: theme.name === options.active.name ? 'active' : undefined
  }));
  return renderPicker({
    title: 'themes',
    subtitle: 'Pick a palette. The whole terminal is the canvas.',
    items,
    selected: options.selected,
    width: options.width,
    height: options.height,
    theme: options.active,
    footer: 'ctrl+t cycles themes anywhere'
  });
}

export interface ExplorerViewOptions {
  cwd: string;
  entries: ExplorerEntry[];
  selected: number;
  expanded: string[];
  preview?: ExplorerPreview;
  previewError?: string;
  loading?: boolean;
  width: number;
  height: number;
  theme: Theme;
  /** The dock has keyboard focus; its border and hints brighten. */
  focused?: boolean;
}

/**
 * Docked two-pane file explorer. The tree is lazy (only expanded folders are
 * loaded); the lower pane previews the highlighted file. It is always rendered
 * beside the chat, not as a modal overlay.
 */
export function renderExplorer(options: ExplorerViewOptions): string[] {
  const { width, height, theme, entries, selected } = options;
  if (width < 24 || height < 4) {
    return entries
      .slice(0, Math.max(0, height))
      .map((entry, index) => `${index === selected ? ICONS.selected : ' '} ${truncate(entry.path, width - 3)}`);
  }

  const innerWidth = width - 2;
  const borderColor = options.focused ? theme.accent2 : theme.border;
  const showPreview = Boolean(options.preview || options.previewError) && height >= 12;
  const previewRows = showPreview ? Math.max(3, Math.min(18, Math.floor((height - 4) * 0.42))) : 0;
  const treeRows = Math.max(1, height - 3 - (showPreview ? previewRows + 1 : 0));
  const lines: string[] = [];

  const title = `─ ${chalk.bold(gradient('EXPLORER', theme.gradient))} ${dim(truncate(options.cwd, Math.max(8, width - 22)))} `;
  lines.push(`${fg(borderColor, '╭')}${title}${fg(borderColor, '─').repeat(Math.max(0, width - visibleWidth(title) - 2))}${fg(borderColor, '╮')}`);

  const row = (content: string): string => {
    const padded = fit(content, innerWidth);
    return `${fg(borderColor, '│')}${padded}${fg(borderColor, '│')}`;
  };

  if (options.loading && entries.length === 0) {
    lines.push(row(` ${fg(theme.accent2, ICONS.active)} ${dim('reading workspace…')}`));
  } else if (entries.length === 0) {
    lines.push(row(` ${dim('empty directory')}`));
  } else {
    const start = Math.max(0, Math.min(selected - Math.floor(treeRows / 2), Math.max(0, entries.length - treeRows)));
    for (let index = start; index < Math.min(entries.length, start + treeRows); index += 1) {
      const entry = entries[index]!;
      const active = index === selected;
      const open = entry.kind === 'directory' && options.expanded.includes(entry.path);
      const icon = entry.kind === 'directory' ? (open ? '▾' : '▸') : '·';
      const marker = active ? fg(theme.accent, ICONS.selected) : ' ';
      const indent = '  '.repeat(entry.depth);
      const name = `${entry.name}${entry.kind === 'directory' ? '/' : ''}`;
      const color = active ? theme.text : entry.kind === 'directory' ? theme.accent2 : theme.muted;
      const label = `${indent}${fg(entry.kind === 'directory' ? theme.accent3 : theme.faint, icon)} ${fg(color, name)}`;
      lines.push(row(` ${marker} ${truncate(label, innerWidth - 3)}`));
    }
  }
  while (lines.length < 1 + treeRows) lines.push(row(''));

  if (showPreview) {
    const previewTitle = options.preview?.path ?? 'preview';
    const suffix = options.preview?.truncated ? dim(' · truncated') : '';
    const header = `─ ${chalk.bold(fg(theme.accent, 'preview'))} ${dim(truncate(previewTitle, Math.max(8, width - 24)))}${suffix} `;
    lines.push(
      `${fg(borderColor, '├')}${header}${fg(borderColor, '─').repeat(Math.max(0, width - visibleWidth(header) - 2))}${fg(borderColor, '┤')}`
    );
    if (options.previewError) {
      lines.push(row(` ${fg(theme.error, ICONS.error)} ${fg(theme.error, truncate(options.previewError, innerWidth - 5))}`));
    } else if (options.preview?.binary) {
      lines.push(row(` ${dim('binary file · not previewed')}`));
    } else if (!options.preview || options.preview.lines.length === 0) {
      lines.push(row(` ${dim('(empty file)')}`));
    } else {
      const gutter = String(options.preview.lines.length).length;
      for (let index = 0; index < previewRows; index += 1) {
        const line = options.preview.lines[index];
        if (line === undefined) {
          lines.push(row(''));
          continue;
        }
        const number = dim(String(index + 1).padStart(gutter));
        lines.push(row(` ${number} ${sanitizeTerminal(line)}`));
      }
    }
    // Reserve the final two rows for the hint and the bottom border.
    while (lines.length < height - 2) lines.push(row(''));
  }

  const hint = options.loading
    ? options.focused
      ? 'reading… · esc prompt'
      : 'reading workspace…'
    : options.focused
      ? '↑↓ · enter/a attach · [ ] resize · esc prompt'
      : 'ctrl+o focus · ctrl+←→ resize';
  lines.push(row(` ${options.focused ? fg(theme.accent2, hint) : dim(hint)}`));
  lines.push(`${fg(borderColor, '╰')}${fg(borderColor, '─').repeat(Math.max(1, width - 2))}${fg(borderColor, '╯')}`);
  return lines.slice(0, height);
}

export interface GithubInfoOptions {
  configured: boolean;
  source?: string;
  masked?: string;
  width: number;
  height: number;
  theme: Theme;
}

export function renderGithubInfo(options: GithubInfoOptions): string[] {
  const { width, height, theme } = options;
  const content: string[] = [];
  if (options.configured) {
    content.push(
      `${fg(theme.success, ICONS.done)} ${fg(theme.text, 'GitHub token saved')} ${dim(`· ${options.source ?? 'auth.json'}${options.masked ? ` · ${options.masked}` : ''}`)}`
    );
  } else {
    content.push(`${fg(theme.warning, ICONS.pending)} ${fg(theme.text, 'No GitHub token yet')}`);
  }
  content.push('');
  content.push(`${dim('Create a token')} ${fg(theme.accent2, 'github.com/settings/tokens')}`);
  content.push(`${dim('Classic scope')} ${fg(theme.text, 'repo')}`);
  content.push(`${dim('Fine-grained')} ${fg(theme.text, 'Contents')} ${dim('read/write ·')} ${fg(theme.text, 'Administration')} ${dim('read/write for repo creation')}`);
  content.push('');
  content.push(dim('The token is stored in auth.json with mode 600.'));
  content.push(dim('GITHUB_TOKEN or GH_TOKEN also works. It is never shown in full,'));
  content.push(dim('written to config, added to a remote URL, or printed in command lines.'));
  content.push('');
  content.push(`${fg(theme.faint, 'Try:')} ${dim('“create a private repo for this project and upload everything”')}`);
  const boxWidth = Math.min(width - 2, 82);
  const lines = box('github', content, boxWidth, theme.accent, theme);
  const horizontal = Math.max(0, Math.floor((width - boxWidth) / 2));
  const topPad = height > lines.length ? Math.min(2, Math.floor((height - lines.length) / 2)) : 0;
  return [
    ...Array.from({ length: topPad }, () => ''),
    ...lines
      .slice(0, Math.max(1, height - topPad))
      .map((line) => `${' '.repeat(horizontal)}${line}`)
  ];
}

export function renderPermission(request: PermissionRequest, width: number, height: number, theme: Theme): string[] {
  const boxWidth = Math.min(width - 2, 78);
  const riskColor = request.risk === 'high' ? theme.error : request.risk === 'medium' ? theme.warning : theme.dim;
  const risk = `${request.risk === 'high' ? 'high risk' : request.risk === 'medium' ? 'medium risk' : 'low risk'}`;
  const detailLines = request.detail ? wrap(request.detail, boxWidth - 6) : [];
  const maxDetail = Math.max(1, height - 9);
  const content: string[] = [];
  content.push(
    `${fg(theme.warning, ICONS.warning)} ${chalk.bold(fg(theme.text, request.title))}  ${fg(riskColor, `${ICONS.bullet} ${risk}`)}`
  );
  if (detailLines.length > 0) {
    content.push('');
    for (const line of detailLines.slice(0, maxDetail)) {
      content.push(`${fg(theme.faint, '│')} ${fg(request.risk === 'high' ? theme.error : theme.text, line)}`);
    }
    if (detailLines.length > maxDetail) content.push(dim(`… ${detailLines.length - maxDetail} more lines`));
  }
  content.push('');
  content.push(`${dim('action')}  ${fg(theme.accent2, request.action)}    ${dim('rule')}  ${truncate(request.rule ?? 'once', Math.max(10, boxWidth - 28))}`);
  content.push('');
  content.push(
    `${chalk.bold(fg(theme.success, '[y]'))} allow once   ${chalk.bold(fg(theme.accent, '[a]'))} always   ${chalk.bold(fg(theme.error, '[n]'))} deny`
  );
  const lines = box('approval needed', content, boxWidth, theme.warning, theme);
  const topPad = height > lines.length ? Math.min(2, Math.floor((height - lines.length) / 2)) : 0;
  const horizontal = Math.max(0, Math.floor((width - boxWidth) / 2));
  const padded = Array.from({ length: topPad }, () => '');
  for (const line of lines) padded.push(`${' '.repeat(horizontal)}${line}`);
  return padded;
}

export function renderConnectInfo(
  providerName: string,
  envName: string | undefined,
  modelCount: number,
  width: number,
  height: number,
  theme: Theme
): string[] {
  const content = [
    `${fg(theme.success, ICONS.done)} ${fg(theme.text, providerName)}`,
    '',
    `${dim('API key')} ${envName ? fg(theme.accent2, envName) : fg(theme.dim, 'not required for local providers')}`,
    `${dim('Catalog')} ${modelCount} models`,
    '',
    dim('The key is stored locally with mode 600 in'),
    dim('~/.config/surfcode/auth.json. Environment keys work too.'),
    '',
    `${fg(theme.faint, 'Tip:')} ${dim('keys are never written to sessions or logs.')}`
  ];
  const boxWidth = Math.min(width - 2, 74);
  const lines = box(`connect ${providerName.toLowerCase()}`, content, boxWidth, theme.accent, theme);
  const horizontal = Math.max(0, Math.floor((width - boxWidth) / 2));
  const topPad = height > lines.length ? Math.min(2, Math.floor((height - lines.length) / 2)) : 0;
  return [
    ...Array.from({ length: topPad }, () => ''),
    ...lines
      .slice(0, Math.max(1, height - topPad))
      .map((line) => `${' '.repeat(horizontal)}${line}`)
  ];
}

export function renderHelpOverlay(width: number, height: number, theme: Theme): string[] {
  const lines = renderHelp(width, theme);
  return lines.slice(0, Math.max(1, height));
}

export interface BtwView {
  question: string;
  answer: string;
  done: boolean;
  error?: string;
  startedAt: number;
  now?: number;
}

/**
 * Ephemeral side-question panel. The question and answer never enter the
 * session; closing the panel discards both.
 */
export function renderBtwOverlay(
  view: BtwView,
  width: number,
  height: number,
  theme: Theme,
  spinner: string
): string[] {
  const boxWidth = Math.max(20, Math.min(width - 2, 92));
  const content: string[] = [];
  content.push(`${fg(theme.accent2, '?')} ${chalk.bold(fg(theme.text, sanitizeTerminal(view.question)))}`);
  content.push('');

  if (view.error) {
    content.push(`${fg(theme.error, ICONS.error)} ${fg(theme.error, sanitizeTerminal(view.error))}`);
  } else if (view.answer) {
    content.push(...renderMarkdown(view.answer, Math.max(10, boxWidth - 4), theme));
    if (!view.done) content.push(dim('…'));
  } else {
    content.push(`${fg(theme.accent2, spinner)} ${dim(view.done ? 'no answer' : 'thinking…')}`);
  }

  content.push('');
  const elapsed = formatDuration(Math.max(0, (view.now ?? Date.now()) - view.startedAt));
  content.push(
    dim(`ephemeral · not saved to the session · ${elapsed} · ${view.done ? 'esc close' : 'esc cancel'}`)
  );

  const lines = box('btw', content, boxWidth, theme.accent2, theme);
  const horizontal = Math.max(0, Math.floor((width - boxWidth) / 2));
  return lines
    .slice(0, Math.max(1, height))
    .map((line) => `${' '.repeat(horizontal)}${line}`);
}

export function renderSuggestions(
  items: Array<{ label: string; description?: string }>,
  selected: number,
  width: number,
  theme: Theme
): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [];
  for (const [index, item] of items.entries()) {
    const active = index === selected;
    const marker = active ? fg(theme.accent, ICONS.selected) : ' ';
    const label = active ? chalk.bold(fg(theme.text, item.label)) : fg(theme.accent, item.label);
    const desc = item.description ? dim(item.description) : '';
    const labelWidth = Math.min(24, Math.max(12, width - 10));
    lines.push(` ${marker} ${fit(label, labelWidth)} ${truncate(desc, Math.max(5, width - labelWidth - 5))}`);
  }
  return lines;
}

export function renderSystemInfo(
  title: string,
  rows: Array<[string, string]>,
  width: number,
  height: number,
  theme: Theme
): string[] {
  const content = rows.map(([key, value]) => `${dim(key.padEnd(12))} ${fg(theme.text, value)}`);
  const boxWidth = Math.min(width - 2, 78);
  const lines = box(title, content, boxWidth, theme.accent2, theme);
  return lines.slice(0, Math.max(1, height));
}

function box(title: string, content: string[], width: number, color: string, theme: Theme): string[] {
  const border = fg(theme.border, '─');
  const topLabel = `─ ${fg(color, title)} `;
  const topFill = Math.max(0, width - visibleWidth(topLabel) - 2);
  const lines = [`${fg(theme.border, '╭')}${topLabel}${border.repeat(topFill)}${fg(theme.border, '╮')}`];
  for (const line of content) {
    const wrapped = wrap(line, width - 4);
    for (const segment of wrapped) {
      lines.push(`${fg(theme.border, '│')} ${fit(segment, width - 4)} ${fg(theme.border, '│')}`);
    }
  }
  lines.push(`${fg(theme.border, '╰')}${border.repeat(Math.max(1, width - 2))}${fg(theme.border, '╯')}`);
  return lines;
}
