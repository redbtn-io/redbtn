/**
 * Color tag utilities for log messages
 * 
 * Frontends can parse these tags and apply colors
 * Servers can strip them for plain text output
 */

export const ColorTags = {
  // Basic colors
  red: (text: string) => `<red>${text}</red>`,
  green: (text: string) => `<green>${text}</green>`,
  yellow: (text: string) => `<yellow>${text}</yellow>`,
  blue: (text: string) => `<blue>${text}</blue>`,
  magenta: (text: string) => `<magenta>${text}</magenta>`,
  cyan: (text: string) => `<cyan>${text}</cyan>`,
  white: (text: string) => `<white>${text}</white>`,
  gray: (text: string) => `<gray>${text}</gray>`,
  
  // Styles
  bold: (text: string) => `<bold>${text}</bold>`,
  dim: (text: string) => `<dim>${text}</dim>`,
  italic: (text: string) => `<italic>${text}</italic>`,
  underline: (text: string) => `<underline>${text}</underline>`,
  
  // Semantic colors
  error: (text: string) => `<red>${text}</red>`,
  success: (text: string) => `<green>${text}</green>`,
  warning: (text: string) => `<yellow>${text}</yellow>`,
  info: (text: string) => `<cyan>${text}</cyan>`,
  debug: (text: string) => `<dim>${text}</dim>`,
} as const;

/**
 * Strip all color tags from text
 */
export function stripColorTags(text: string): string {
  return text.replace(/<\/?[a-z]+>/gi, '');
}

/**
 * Parse color tags into ANSI codes for terminal output
 */
export function parseColorTagsToAnsi(text: string): string {
  const ansiCodes: Record<string, string> = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    italic: '\x1b[3m',
    underline: '\x1b[4m',
  };
  
  const reset = '\x1b[0m';
  
  let result = text;
  
  // Replace opening tags
  for (const [tag, code] of Object.entries(ansiCodes)) {
    result = result.replace(new RegExp(`<${tag}>`, 'gi'), code);
  }
  
  // Replace closing tags
  result = result.replace(/<\/[a-z]+>/gi, reset);
  
  return result;
}

/**
 * Parse color tags to HTML/CSS
 */
export function parseColorTagsToHtml(text: string): string {
  const htmlColors: Record<string, string> = {
    red: 'color: #ef4444',
    green: 'color: #10b981',
    yellow: 'color: #f59e0b',
    blue: 'color: #3b82f6',
    magenta: 'color: #a855f7',
    cyan: 'color: #06b6d4',
    white: 'color: #ffffff',
    gray: 'color: #6b7280',
    bold: 'font-weight: bold',
    dim: 'opacity: 0.6',
    italic: 'font-style: italic',
    underline: 'text-decoration: underline',
  };
  
  let result = text;
  
  // Replace opening tags with spans
  for (const [tag, style] of Object.entries(htmlColors)) {
    result = result.replace(
      new RegExp(`<${tag}>`, 'gi'),
      `<span style="${style}">`
    );
  }
  
  // Replace closing tags
  result = result.replace(/<\/[a-z]+>/gi, '</span>');
  
  return result;
}
