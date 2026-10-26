import { marked, type Token } from 'marked';
import { highlight, supportsLanguage, type Theme as HighlightTheme } from 'cli-highlight';
import type { Theme } from './theme.js';
import { ICONS } from './icons.js';
import { chalk, fg, fit, italic, stripAnsi, visibleWidth, wrap } from './ansi.js';

interface RenderContext {
  out: string[];
  width: number;
  indent: number;
  theme: Theme;
}

export function sanitizeTerminal(text: string): string {
  return stripAnsi(text)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '')
    .replace(/\t/g, '  ');
}

// Rendering markdown is the TUI's hottest path: while a reply streams in, the
// whole text is re-rendered on every spinner frame. Results are pure, so a
// small LRU keyed on the exact input turns repeated frames into cache hits.
const RENDER_CACHE_LIMIT = 48;
const renderCache = new Map<string, string[]>();

export function renderMarkdown(markdown: string, width: number, theme: Theme): string[] {
  const safe = sanitizeTerminal(markdown);
  if (!safe.trim()) return [];
  const key = `${theme.name}\u0000${width}\u0000${safe}`;
  const cached = renderCache.get(key);
  if (cached) {
    // Re-insert to keep the entry fresh under LRU eviction.
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cached;
  }
  const tokens = marked.lexer(safe);
  const context: RenderContext = { out: [], width: Math.max(10, width), indent: 0, theme };
  renderBlocks(tokens, context);
  trimBlank(context.out);
  const lines = context.out;
  renderCache.set(key, lines);
  if (renderCache.size > RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  return lines;
}

function renderBlocks(tokens: Token[], context: RenderContext): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'paragraph':
      case 'text': {
        const inline = renderInline((token as any).tokens ?? [{ type: 'text', raw: token.raw, text: (token as any).text }], context.theme);
        pushWrapped(context, inline);
        blank(context);
        break;
      }
      case 'heading': {
        const heading = token as any;
        const prefix = heading.depth === 1 ? '▌ ' : heading.depth === 2 ? '▎ ' : '▏ ';
        const color = heading.depth === 1 ? context.theme.accent : heading.depth === 2 ? context.theme.accent2 : context.theme.muted;
        const text = renderInline(heading.tokens, context.theme);
        const lines = wrap(chalk.bold(text), Math.max(5, context.width - visibleWidth(prefix)));
        for (const [index, line] of lines.entries()) {
          add(context, `${index === 0 ? fg(color, prefix) : ' '.repeat(visibleWidth(prefix))}${line}`);
        }
        blank(context);
        break;
      }
      case 'code': {
        renderCode(token as any, context);
        blank(context);
        break;
      }
      case 'blockquote': {
        const quote = token as any;
        const nested: RenderContext = { out: [], width: Math.max(5, context.width - 2), indent: 0, theme: context.theme };
        renderBlocks(quote.tokens ?? [], nested);
        trimBlank(nested.out);
        for (const line of nested.out) {
          add(context, `${fg(context.theme.faint, '│')} ${line}`);
        }
        blank(context);
        break;
      }
      case 'list': {
        renderList(token as any, context);
        blank(context);
        break;
      }
      case 'table': {
        renderTable(token as any, context);
        blank(context);
        break;
      }
      case 'hr': {
        add(context, fg(context.theme.faint, '─'.repeat(Math.max(5, context.width))));
        blank(context);
        break;
      }
      case 'html': {
        const text = stripHtml((token as any).text ?? '');
        if (text.trim()) {
          pushWrapped(context, text, context.theme.muted);
          blank(context);
        }
        break;
      }
      default: {
        const text = (token as any).text;
        if (typeof text === 'string' && text.trim()) {
          pushWrapped(context, text);
          blank(context);
        }
      }
    }
  }
}

function renderInline(tokens: Token[], theme: Theme): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text': {
          const nested = (token as any).tokens;
          if (Array.isArray(nested) && nested.length > 0) return renderInline(nested, theme);
          return (token as any).text ?? '';
        }
        case 'strong':
          return chalk.bold(fg(theme.text, renderInline((token as any).tokens, theme)));
        case 'em':
          return italic(renderInline((token as any).tokens, theme));
        case 'del':
          return chalk.strikethrough(fg(theme.dim, renderInline((token as any).tokens, theme)));
        case 'codespan': {
          const code = sanitizeTerminal((token as any).text ?? '');
          return chalk.hex(theme.code).bgHex(theme.codeBorder)(` ${code} `);
        }
        case 'link': {
          const text = renderInline((token as any).tokens, theme);
          const href = safeHref((token as any).href ?? '');
          const label = chalk.underline(fg(theme.accent2, text));
          if (!href) return label;
          return `${terminalLink(label, href)}${(token as any).autolink ? '' : fg(theme.faint, ` ‹${shortenUrl(href)}›`)}`;
        }
        case 'image': {
          const alt = stripAnsi((token as any).text ?? '');
          return fg(theme.faint, `${ICONS.image} ${alt || 'image'}`);
        }
        case 'br':
          return '\n';
        case 'escape':
          return (token as any).text ?? '';
        case 'html':
          return stripHtml((token as any).text ?? '');
        case 'checkbox':
          return (token as any).checked ? fg(theme.success, '☑') : fg(theme.dim, '☐');
        default:
          return (token as any).text ?? '';
      }
    })
    .join('');
}

function renderCode(token: any, context: RenderContext): void {
  const lang = normalizeLanguage(token.lang);
  const raw = sanitizeTerminal(token.text ?? '').replace(/\n$/, '');
  if (!raw) return;
  const innerWidth = Math.max(8, context.width - 4);
  const label = lang ? ` ${lang} ` : ' code ';
  const topFill = Math.max(0, context.width - 4 - visibleWidth(label));
  add(context, `${fg(context.theme.codeBorder, '╭─')}${fg(context.theme.code, label)}${fg(context.theme.codeBorder, `${'─'.repeat(topFill)}╮`)}`);

  const highlighted = highlightCode(raw, lang, context.theme);
  const codeLines = highlighted.split('\n');
  let rendered = 0;
  for (const line of codeLines) {
    if (rendered >= 40) break;
    const wrapped = line.length === 0 ? [''] : wrap(line, innerWidth);
    for (const segment of wrapped) {
      if (rendered >= 40) break;
      add(
        context,
        `${fg(context.theme.codeBorder, '│')} ${fit(segment, innerWidth)} ${fg(context.theme.codeBorder, '│')}`
      );
      rendered += 1;
    }
  }
  if (codeLines.length > rendered) {
    add(context, `${fg(context.theme.codeBorder, '│')} ${fg(context.theme.dim, `… ${codeLines.length - rendered} more lines`.padEnd(innerWidth))} ${fg(context.theme.codeBorder, '│')}`);
  }
  add(context, fg(context.theme.codeBorder, `╰${'─'.repeat(Math.max(2, context.width - 2))}╯`));
}

function renderList(token: any, context: RenderContext): void {
  const start = typeof token.start === 'number' ? token.start : 1;
  for (const [index, item] of (token.items ?? []).entries()) {
    let marker: string;
    if (item.task) marker = item.checked ? fg(context.theme.success, '☑') : fg(context.theme.dim, '☐');
    else if (token.ordered) marker = fg(context.theme.accent2, `${start + index}.`);
    else marker = fg(context.theme.accent, '•');
    const markerWidth = visibleWidth(marker) + 1;
    const nested: RenderContext = {
      out: [],
      width: Math.max(8, context.width - markerWidth),
      indent: 0,
      theme: context.theme
    };
    renderBlocks(item.tokens ?? [], nested);
    trimBlank(nested.out);
    if (nested.out.length === 0) continue;
    for (const [lineIndex, line] of nested.out.entries()) {
      if (lineIndex === 0) add(context, `${marker} ${line}`);
      else add(context, `${' '.repeat(markerWidth)}${line}`);
    }
  }
}

function renderTable(token: any, context: RenderContext): void {
  const header = token.header ?? [];
  const rows = token.rows ?? [];
  const columns = header.length;
  if (columns === 0) return;
  const available = Math.max(12, context.width);
  const cellWidth = Math.max(5, Math.floor((available - (columns + 1)) / columns) - 2);
  const border = (left: string, middle: string, right: string) =>
    fg(
      context.theme.faint,
      `${left}${Array.from({ length: columns }, () => '─'.repeat(cellWidth + 2)).join(middle)}${right}`
    );
  add(context, border('┌', '┬', '┐'));
  const headerCells = header.map((cell: any) =>
    fit(chalk.bold(fg(context.theme.text, renderInline(cell.tokens, context.theme))), cellWidth)
  );
  add(context, `${fg(context.theme.faint, '│')} ${headerCells.join(` ${fg(context.theme.faint, '│')} `)} ${fg(context.theme.faint, '│')}`);
  add(context, border('├', '┼', '┤'));
  for (const row of rows) {
    const cells = header.map((_: any, index: number) => {
      const cell = row[index];
      return fit(renderInline(cell?.tokens ?? [], context.theme), cellWidth);
    });
    add(context, `${fg(context.theme.faint, '│')} ${cells.join(` ${fg(context.theme.faint, '│')} `)} ${fg(context.theme.faint, '│')}`);
  }
  add(context, border('└', '┴', '┘'));
}

function pushWrapped(context: RenderContext, text: string, color?: string): void {
  const styled = color ? fg(color, text) : text;
  for (const line of wrap(styled, Math.max(5, context.width))) {
    add(context, line);
  }
}

function add(context: RenderContext, text: string): void {
  context.out.push(`${' '.repeat(context.indent)}${text}`);
}

function blank(context: RenderContext): void {
  if (context.out.length > 0 && context.out[context.out.length - 1] !== '') context.out.push('');
}

function trimBlank(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
}

function highlightCode(code: string, lang: string | undefined, theme: Theme): string {
  if (!lang || !supportsLanguage(lang)) return code;
  try {
    return highlight(code, { language: lang, ignoreIllegals: true, theme: highlightTheme(theme) });
  } catch {
    return code;
  }
}

function highlightTheme(theme: Theme): HighlightTheme {
  return {
    keyword: (text) => chalk.hex(theme.accent3).bold(text),
    built_in: (text) => chalk.hex(theme.accent)(text),
    type: (text) => chalk.hex(theme.accent)(text),
    literal: (text) => chalk.hex(theme.accent3)(text),
    number: (text) => chalk.hex(theme.accent3)(text),
    regexp: (text) => chalk.hex(theme.warning)(text),
    string: (text) => chalk.hex(theme.success)(text),
    subst: (text) => chalk.hex(theme.text)(text),
    symbol: (text) => chalk.hex(theme.accent2)(text),
    class: (text) => chalk.hex(theme.accent).bold(text),
    function: (text) => chalk.hex(theme.accent2)(text),
    title: (text) => chalk.hex(theme.accent).bold(text),
    params: (text) => chalk.hex(theme.text)(text),
    comment: (text) => chalk.hex(theme.dim).italic(text),
    doctag: (text) => chalk.hex(theme.dim)(text),
    meta: (text) => chalk.hex(theme.muted)(text),
    'meta-keyword': (text) => chalk.hex(theme.accent3)(text),
    'meta-string': (text) => chalk.hex(theme.success)(text),
    section: (text) => chalk.hex(theme.accent2).bold(text),
    tag: (text) => chalk.hex(theme.accent2)(text),
    name: (text) => chalk.hex(theme.accent)(text),
    attr: (text) => chalk.hex(theme.code)(text),
    attribute: (text) => chalk.hex(theme.code)(text),
    variable: (text) => chalk.hex(theme.text)(text),
    bullet: (text) => chalk.hex(theme.accent3)(text),
    code: (text) => chalk.hex(theme.code)(text),
    emphasis: (text) => chalk.italic(text),
    strong: (text) => chalk.bold(text),
    formula: (text) => chalk.hex(theme.code)(text),
    link: (text) => chalk.underline(fg(theme.accent2, text)),
    quote: (text) => chalk.hex(theme.muted).italic(text),
    'selector-tag': (text) => chalk.hex(theme.accent2)(text),
    'selector-id': (text) => chalk.hex(theme.accent)(text),
    'selector-class': (text) => chalk.hex(theme.accent2)(text),
    'selector-attr': (text) => chalk.hex(theme.code)(text),
    'selector-pseudo': (text) => chalk.hex(theme.accent3)(text),
    'template-variable': (text) => chalk.hex(theme.code)(text),
    addition: (text) => chalk.hex(theme.success)(text),
    deletion: (text) => chalk.hex(theme.error)(text),
    default: (text) => text
  };
}

function normalizeLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const normalized = lang.trim().split(/\s+/)[0]?.toLowerCase();
  const aliases: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    yml: 'yaml',
    md: 'markdown',
    jsonc: 'json'
  };
  return normalized ? aliases[normalized] ?? normalized : undefined;
}

function safeHref(href: string): string {
  const clean = href.replace(/[\u0000-\u001f\u007f]/g, '');
  if (!/^https?:\/\//i.test(clean)) return '';
  return clean;
}

function terminalLink(text: string, href: string): string {
  return `\u001b]8;;${href}\u001b\\${text}\u001b]8;;\u001b\\`;
}

function shortenUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 48);
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
