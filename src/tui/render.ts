import type { Theme } from './theme.js';
import { ICONS } from './icons.js';
import type { LiveMessage, TimelineItem, ToolView } from './types.js';
import { renderMarkdown, sanitizeTerminal } from './markdown.js';
import {
  bold,
  chalk,
  dim,
  fit,
  fg,
  gradient,
  italic,
  truncate,
  visibleWidth,
  wrap
} from './ansi.js';

export interface RenderOptions {
  showReasoning: boolean;
  verboseTools: boolean;
  spinner: string;
  /** Paint partial text while the reply is in flight. Defaults to true for callers. */
  streaming?: boolean;
  now?: number;
}

export function renderTimeline(timeline: TimelineItem[], width: number, theme: Theme, options: RenderOptions): string[] {
  const lines: string[] = [];
  for (const item of timeline) {
    if (lines.length > 0) lines.push('');
    if (item.type === 'user') lines.push(...renderUser(item, width, theme));
    else if (item.type === 'assistant') lines.push(...renderAssistant(item, width, theme, options));
    else lines.push(...renderNotice(item, width, theme));
  }
  return lines;
}

export function renderLive(live: LiveMessage, width: number, theme: Theme, options: RenderOptions): string[] {
  const now = options.now ?? Date.now();
  const elapsed = formatDuration(now - live.startedAt);
  const label = `${fg(theme.accent, ICONS.assistant)} ${chalk.bold(gradient('SURFCODE', theme.gradient))}`;
  const status =
    live.phase === 'thinking'
      ? `${fg(theme.accent2, options.spinner)} ${dim('thinking…')}`
      : live.phase === 'tool'
        ? `${fg(theme.accent2, options.spinner)} ${dim(`running ${live.activeTool ?? 'tool'}…`)}`
        : `${fg(theme.success, ICONS.done)} ${dim('streaming')}`;
  const right = dim(`${status}  ${elapsed}`);
  const lines: string[] = [`  ${fit(label, Math.max(5, width - 2 - visibleWidth(right)))}${right}`];
  const visible = options.streaming !== false;

  if (live.reasoning && visible && options.showReasoning) {
    const reasoningLines = renderMarkdown(live.reasoning, Math.max(10, width - 6), theme);
    lines.push(`  ${dim(ICONS.reasoning)} ${dim(italic('thinking'))}`);
    for (const line of reasoningLines) lines.push(`  ${dim('│')} ${dim(line)}`);
    lines.push('');
  }

  if (live.preamble && visible) {
    const contentWidth = Math.max(10, width - 4);
    for (const line of renderMarkdown(live.preamble, contentWidth, theme)) lines.push(`  ${line}`);
    if (live.tools.length > 0) lines.push('');
  }

  if (live.tools.length > 0) {
    for (const tool of live.tools) lines.push(...renderToolView(tool, width, theme, options));
  }

  if (live.content && visible) {
    if (live.tools.length > 0) lines.push('');
    const contentWidth = Math.max(10, width - 4);
    for (const line of renderMarkdown(live.content, contentWidth, theme)) lines.push(`  ${line}`);
    if (live.phase !== 'tool') lines.push(`  ${fg(theme.accent, ICONS.user)}`);
  } else if (!visible && (live.content || live.preamble || live.reasoning) && live.phase !== 'tool') {
    lines.push(`  ${dim('│')} ${dim(italic('composing reply…'))}`);
  } else if (!live.preamble && live.tools.length === 0) {
    // Never reveal reasoning text unless the user opted in with /thinking.
    const message = live.phase === 'thinking' ? 'thinking…' : 'warming up';
    lines.push(`  ${dim('│')} ${dim(italic(message))}`);
  }
  return lines;
}

function renderUser(item: TimelineItem, width: number, theme: Theme): string[] {
  const lines: string[] = [`  ${fg(theme.user, ICONS.user)} ${chalk.bold(fg(theme.user, 'you'))}`];
  const contentWidth = Math.max(10, width - 4);
  const rendered = renderMarkdown(item.content, contentWidth, theme);
  for (const line of rendered) lines.push(`  ${fg(theme.user, ICONS.user)} ${line}`);
  return lines;
}

function renderAssistant(item: TimelineItem, width: number, theme: Theme, options: RenderOptions): string[] {
  const duration = item.durationMs ? dim(formatDuration(item.durationMs)) : '';
  const label = `${fg(theme.assistant, ICONS.assistant)} ${chalk.bold(gradient('SURFCODE', theme.gradient))}`;
  const lines: string[] = [`  ${fit(label, Math.max(5, width - 2 - visibleWidth(duration)))}${duration}`];

  if (item.reasoning) {
    if (options.showReasoning) {
      lines.push(`  ${dim(ICONS.reasoning)} ${dim(italic('reasoning'))}`);
      for (const line of renderMarkdown(item.reasoning, Math.max(10, width - 6), theme)) {
        lines.push(`  ${dim('│')} ${dim(line)}`);
      }
      lines.push('');
    } else {
      lines.push(`  ${dim(ICONS.reasoning)} ${dim(`thought process hidden · /thinking to show`)}`);
    }
  }

  if (item.preamble) {
    for (const line of renderMarkdown(item.preamble, Math.max(10, width - 4), theme)) {
      lines.push(`  ${line}`);
    }
    if (item.toolViews?.length) lines.push('');
  }

  if (item.toolViews && item.toolViews.length > 0) {
    for (const tool of item.toolViews) lines.push(...renderToolView(tool, width, theme, options));
  }

  if (item.content) {
    if (item.toolViews?.length || item.reasoning) lines.push('');
    for (const line of renderMarkdown(item.content, Math.max(10, width - 4), theme)) lines.push(`  ${line}`);
  }
  return lines;
}

function renderNotice(item: TimelineItem, width: number, theme: Theme): string[] {
  const color =
    item.level === 'error'
      ? theme.error
      : item.level === 'warning'
        ? theme.warning
        : item.level === 'success'
          ? theme.success
          : theme.dim;
  const icon =
    item.level === 'error'
      ? ICONS.error
      : item.level === 'warning'
        ? ICONS.warning
        : item.level === 'success'
          ? ICONS.success
          : ICONS.info;
  const lines = wrap(item.content, Math.max(10, width - 5));
  return lines.map((line, index) => `  ${index === 0 ? fg(color, icon) : ' '} ${fg(color, line)}`);
}

export function renderToolView(view: ToolView, width: number, theme: Theme, options: RenderOptions): string[] {
  const icon = view.pending
    ? fg(theme.accent2, options.spinner)
    : view.result?.isError
      ? fg(theme.error, ICONS.error)
      : fg(theme.success, ICONS.success);
  const name = fg(theme.accent2, view.call.name);
  const title = truncate(sanitizeTerminal(toolTitle(view)), Math.max(8, width - 25));
  const summary = view.pending
    ? dim('running')
    : fg(
        view.result?.isError ? theme.error : theme.dim,
        [view.result?.display?.summary, view.durationMs ? formatDuration(view.durationMs) : undefined]
          .filter(Boolean)
          .join(' · ')
      );
  const left = `${icon} ${name}  ${fg(theme.text, title)}`;
  const available = Math.max(10, width - 2);
  const summaryWidth = Math.min(visibleWidth(summary), Math.floor(available * 0.45));
  const clippedSummary = summaryWidth > 0 ? fit(summary, summaryWidth, 'right') : '';
  const leftWidth = Math.max(5, available - summaryWidth - (summaryWidth > 0 ? 1 : 0));
  const lines = [`  ${fit(left, leftWidth)}${clippedSummary ? ` ${clippedSummary}` : ''}`];

  if (view.result) lines.push(...renderToolDetails(view, width, theme, options));
  return lines;
}

function renderToolDetails(view: ToolView, width: number, theme: Theme, options: RenderOptions): string[] {
  const result = view.result!;
  const prefix = `  ${fg(theme.faint, '│')} `;
  const detailWidth = Math.max(8, width - 4);
  const output = sanitizeTerminal(result.output);
  const details: string[] = [];

  if (result.display?.todos) {
    const todos = result.display.todos;
    const marks = {
      pending: fg(theme.dim, ICONS.pending),
      in_progress: fg(theme.warning, ICONS.active),
      completed: fg(theme.success, ICONS.done)
    };
    for (const todo of todos.slice(0, options.verboseTools ? 30 : 8)) {
      details.push(`${marks[todo.status]} ${todo.status === 'completed' ? dim(todo.content) : todo.content}`);
    }
    return details.map((line) => `${prefix}${truncate(line, detailWidth)}`);
  }

  if (result.display?.diff) {
    const limit = options.verboseTools ? 80 : 14;
    const diffLines = result.display.diff.split('\n');
    for (const line of diffLines.slice(0, limit)) {
      let rendered = line;
      if (line.startsWith('@@')) rendered = fg(theme.accent2, line);
      else if (line.startsWith('+')) rendered = fg(theme.success, line);
      else if (line.startsWith('-')) rendered = fg(theme.error, line);
      else rendered = fg(theme.dim, line);
      details.push(truncate(rendered, detailWidth));
    }
    if (diffLines.length > limit) details.push(dim(`… ${diffLines.length - limit} more diff lines`));
    return details.map((line, index) => `${prefix}${index === details.length - 1 && !line.startsWith('\u001b') ? dim(line) : line}`);
  }

  if (result.isError || view.call.name === 'bash') {
    const lines = output.split('\n');
    const cleaned = view.call.name === 'bash' ? lines.slice(2) : lines;
    const limit = options.verboseTools ? 24 : 5;
    for (const line of cleaned.slice(0, limit)) {
      details.push(fg(result.isError ? theme.error : theme.muted, line));
    }
    if (cleaned.length > limit) details.push(dim(`… ${cleaned.length - limit} more lines`));
  }

  if (details.length === 0 && result.display?.truncated) {
    details.push(dim('output truncated'));
  }
  return details.map((line) => `${prefix}${truncate(line, detailWidth)}`);
}

export function toolTitle(view: ToolView): string {
  const args = view.call.arguments;
  switch (view.call.name) {
    case 'bash':
      return String(args.command ?? '');
    case 'read':
    case 'write':
    case 'edit':
    case 'ls':
      return String(args.path ?? '.');
    case 'glob':
      return String(args.pattern ?? '');
    case 'grep':
      return `${String(args.pattern ?? '')}${args.path ? ` in ${String(args.path)}` : ''}`;
    case 'webfetch':
      return String(args.url ?? '');
    case 'todo_write':
      return 'update plan';
    default:
      return String(args.path ?? args.pattern ?? args.command ?? '');
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
