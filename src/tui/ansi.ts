import chalk from 'chalk';
import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';

export { chalk, stripAnsi, stringWidth };

export function fg(color: string, text: string): string {
  return chalk.hex(color)(text);
}

/**
 * Paint a full-width background without disturbing nested foreground colors.
 * Inline code and syntax highlighting may reset the background mid-line, so
 * the frame color is re-applied after every reset.
 */
export function bg(color: string, text: string): string {
  if (chalk.level === 0) return text;
  const [red, green, blue] = hexToRgb(color);
  const open = `\x1b[48;2;${red};${green};${blue}m`;
  const close = '\x1b[49m';
  const painted = `${open}${text}${close}`.replace(
    /\x1b\[(?:0|49)m/g,
    (match) => `${match}${open}`
  );
  return painted.endsWith(open) ? painted.slice(0, -open.length) : painted;
}

export function bold(text: string): string {
  return chalk.bold(text);
}

export function dim(text: string): string {
  return chalk.dim(text);
}

export function italic(text: string): string {
  return chalk.italic(text);
}

export function underline(text: string): string {
  return chalk.underline(text);
}

export function inverse(text: string): string {
  return chalk.inverse(text);
}

export function gradient(text: string, colors: string[]): string {
  const chars = [...text];
  if (chars.length === 0) return '';
  if (colors.length === 1) return fg(colors[0]!, text);
  const stops = colors.map(hexToRgb);
  return chars
    .map((char, index) => {
      const position = chars.length === 1 ? 0 : index / (chars.length - 1);
      const scaled = position * (stops.length - 1);
      const segment = Math.min(Math.floor(scaled), stops.length - 2);
      const local = scaled - segment;
      const rgb = mix(stops[segment]!, stops[segment + 1]!, local);
      return chalk.rgb(rgb[0], rgb[1], rgb[2])(char);
    })
    .join('');
}

/** A moving blue highlight, used by the animated wordmark. */
export function shimmer(text: string, colors: string[], phase: number): string {
  const chars = [...text];
  if (chars.length === 0) return '';
  if (colors.length === 0) return text;
  const stops = colors.map(hexToRgb);
  const span = Math.max(1, chars.length - 1);
  const center = ((phase * 2.4) % (chars.length + 32)) - 16;
  const glow: [number, number, number] = [186, 230, 253];

  return chars
    .map((char, index) => {
      if (char === ' ') return char;
      const position = index / span;
      const scaled = position * (stops.length - 1);
      const segment = Math.min(Math.floor(scaled), stops.length - 2);
      const local = scaled - segment;
      let rgb = mix(stops[segment]!, stops[segment + 1]!, local);
      const distance = Math.abs(index - center);
      if (distance < 13) {
        rgb = mix(rgb, glow, (1 - distance / 13) * 0.62);
      }
      return chalk.rgb(rgb[0], rgb[1], rgb[2])(char);
    })
    .join('');
}

export function visibleWidth(text: string): number {
  return stringWidth(stripAnsi(text));
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  return cliTruncate(text, width, { position: 'end', space: false });
}

export function fit(text: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const clipped = truncate(text, width);
  const remaining = Math.max(0, width - visibleWidth(clipped));
  if (align === 'right') return `${' '.repeat(remaining)}${clipped}`;
  if (align === 'center') {
    const left = Math.floor(remaining / 2);
    return `${' '.repeat(left)}${clipped}${' '.repeat(remaining - left)}`;
  }
  return `${clipped}${' '.repeat(remaining)}`;
}

export function center(text: string, width: number): string {
  const length = visibleWidth(text);
  if (length >= width) return truncate(text, width);
  const left = Math.floor((width - length) / 2);
  return `${' '.repeat(left)}${text}`;
}

export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [''];
  const wrapped = wrapAnsi(text, width, { hard: true, trim: false, wordWrap: true });
  return wrapped.split('\n');
}

export function repeat(char: string, width: number): string {
  if (width <= 0) return '';
  return char.repeat(Math.ceil(width / Math.max(visibleWidth(char), 1))).slice(0, width);
}

export function line(left: string, width: number, right = '╮'): string {
  return `${left}${'─'.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`;
}

export function rule(width: number, color: string): string {
  return fg(color, '─'.repeat(Math.max(0, width)));
}

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => `${char}${char}`)
          .join('')
      : normalized.padEnd(6, '0').slice(0, 6);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16)
  ];
}

function mix(a: [number, number, number], b: [number, number, number], amount: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount)
  ];
}
