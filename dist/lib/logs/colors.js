"use strict";
/**
 * Color tag utilities for log messages
 *
 * Frontends can parse these tags and apply colors
 * Servers can strip them for plain text output
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ColorTags = void 0;
exports.stripColorTags = stripColorTags;
exports.parseColorTagsToAnsi = parseColorTagsToAnsi;
exports.parseColorTagsToHtml = parseColorTagsToHtml;
exports.ColorTags = {
    // Basic colors
    red: (text) => `<red>${text}</red>`,
    green: (text) => `<green>${text}</green>`,
    yellow: (text) => `<yellow>${text}</yellow>`,
    blue: (text) => `<blue>${text}</blue>`,
    magenta: (text) => `<magenta>${text}</magenta>`,
    cyan: (text) => `<cyan>${text}</cyan>`,
    white: (text) => `<white>${text}</white>`,
    gray: (text) => `<gray>${text}</gray>`,
    // Styles
    bold: (text) => `<bold>${text}</bold>`,
    dim: (text) => `<dim>${text}</dim>`,
    italic: (text) => `<italic>${text}</italic>`,
    underline: (text) => `<underline>${text}</underline>`,
    // Semantic colors
    error: (text) => `<red>${text}</red>`,
    success: (text) => `<green>${text}</green>`,
    warning: (text) => `<yellow>${text}</yellow>`,
    info: (text) => `<cyan>${text}</cyan>`,
    debug: (text) => `<dim>${text}</dim>`,
};
/**
 * Strip all color tags from text
 */
function stripColorTags(text) {
    return text.replace(/<\/?[a-z]+>/gi, '');
}
/**
 * Parse color tags into ANSI codes for terminal output
 */
function parseColorTagsToAnsi(text) {
    const ansiCodes = {
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
function parseColorTagsToHtml(text) {
    const htmlColors = {
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
        result = result.replace(new RegExp(`<${tag}>`, 'gi'), `<span style="${style}">`);
    }
    // Replace closing tags
    result = result.replace(/<\/[a-z]+>/gi, '</span>');
    return result;
}
