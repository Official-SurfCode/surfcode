declare module 'html-to-text' {
  export interface HtmlToTextSelector {
    selector: string;
    format?: string;
    options?: Record<string, unknown>;
  }

  export interface HtmlToTextOptions {
    wordwrap?: number | false;
    selectors?: HtmlToTextSelector[];
    [key: string]: unknown;
  }

  export function convert(html: string, options?: HtmlToTextOptions): string;
}
