/**
 * Color tag utilities for log messages
 *
 * Frontends can parse these tags and apply colors
 * Servers can strip them for plain text output
 */
export declare const ColorTags: {
    readonly red: (text: string) => string;
    readonly green: (text: string) => string;
    readonly yellow: (text: string) => string;
    readonly blue: (text: string) => string;
    readonly magenta: (text: string) => string;
    readonly cyan: (text: string) => string;
    readonly white: (text: string) => string;
    readonly gray: (text: string) => string;
    readonly bold: (text: string) => string;
    readonly dim: (text: string) => string;
    readonly italic: (text: string) => string;
    readonly underline: (text: string) => string;
    readonly error: (text: string) => string;
    readonly success: (text: string) => string;
    readonly warning: (text: string) => string;
    readonly info: (text: string) => string;
    readonly debug: (text: string) => string;
};
/**
 * Strip all color tags from text
 */
export declare function stripColorTags(text: string): string;
/**
 * Parse color tags into ANSI codes for terminal output
 */
export declare function parseColorTagsToAnsi(text: string): string;
/**
 * Parse color tags to HTML/CSS
 */
export declare function parseColorTagsToHtml(text: string): string;
