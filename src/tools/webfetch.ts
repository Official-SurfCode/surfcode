import { convert } from 'html-to-text';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { SurfError } from '../core/errors.js';
import { clip } from '../core/workspace.js';

const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i;

export const webfetchTool: ToolDefinition = {
  name: 'webfetch',
  description:
    'Fetch a public http(s) URL and return readable text. Useful for documentation, APIs and error references. Private/local network addresses are blocked.',
  readOnly: true,
  action: 'fetch',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL.' },
      format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'Preferred output format. Default text.' }
    },
    required: ['url']
  },
  async execute(args, context): Promise<ToolResult> {
    const raw = String(args.url ?? '').trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SurfError(`Invalid URL: ${raw}`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new SurfError('Only http and https URLs are supported.');
    if (PRIVATE_HOST.test(url.hostname)) throw new SurfError('Private and local network URLs are blocked.');

    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SurfCode/0.1; +https://surfcode.dev)',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5'
      },
      redirect: 'follow',
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)])
    });
    if (!response.ok) throw new SurfError(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
    const contentType = response.headers.get('content-type') ?? '';
    const reader = response.body?.getReader();
    if (!reader) throw new SurfError('Fetch returned an empty response.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const requested = String(args.format ?? 'text');
    let body: string;
    if (contentType.includes('text/html') || /^\s*<!doctype html/i.test(rawBody)) {
      body =
        requested === 'html'
          ? rawBody
          : convert(rawBody, {
              wordwrap: false,
              selectors: [
                { selector: 'a', options: { hideEmpty: false, ignoreHref: false } },
                { selector: 'img', format: 'skip' },
                { selector: 'script', format: 'skip' },
                { selector: 'style', format: 'skip' },
                { selector: 'nav', format: 'skip' },
                { selector: 'footer', format: 'skip' }
              ]
            });
    } else if (contentType.includes('application/json')) {
      try {
        body = JSON.stringify(JSON.parse(rawBody), null, 2);
      } catch {
        body = rawBody;
      }
    } else {
      body = rawBody;
    }
    const clipped = clip(body.replace(/\n{4,}/g, '\n\n\n').trim(), 50_000);
    const title = extractTitle(rawBody) ?? url.hostname;
    return {
      output: `${url.toString()}\n\n${clipped.text}`,
      title,
      display: {
        kind: 'fetch',
        summary: `${url.hostname} · ${(bytes / 1024).toFixed(0)} KB`,
        truncated: clipped.truncated,
        lines: body.split('\n').length
      }
    };
  }
};

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return undefined;
  return match[1].replace(/\s+/g, ' ').trim().slice(0, 140);
}
