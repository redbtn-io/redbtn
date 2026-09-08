import { describe, it, expect } from 'vitest';
import { parseHtml, stripResourceHints, createParseWindow } from '../../src/lib/nodes/scrape/parser';

const PAGE = `<!doctype html><html><head>
<title>Honey lasts</title>
<link rel="preload" href="/fonts/a.woff2" as="fetch" crossorigin>
<link rel="modulepreload" href="./chunks/app.js">
<link rel="prefetch" href="/next-page">
<link rel="preconnect" href="https://cdn.example.com">
<link rel="stylesheet" href="/site.css">
<meta name="description" content="Why honey never spoils">
</head><body><article><p>Archaeologists found edible honey in Egyptian tombs.</p></article></body></html>`;

/** Resolve on the next unhandled rejection, or after `ms` with null. */
function unhandledWithin(ms: number): Promise<unknown | null> {
  return new Promise((resolve) => {
    const onRej = (reason: unknown) => { cleanup(); resolve(reason); };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, ms);
    const cleanup = () => { clearTimeout(timer); process.off('unhandledRejection', onRej); };
    process.on('unhandledRejection', onRej);
  });
}

describe('scrape parser: read-only happy-dom window', () => {
  it('strips resource-hint links but keeps other tags', () => {
    const out = stripResourceHints(PAGE);
    expect(out).not.toMatch(/rel="preload"/);
    expect(out).not.toMatch(/rel="modulepreload"/);
    expect(out).not.toMatch(/rel="prefetch"/);
    expect(out).not.toMatch(/rel="preconnect"/);
    expect(out).toMatch(/rel="stylesheet"/);
    expect(out).toMatch(/<title>Honey lasts<\/title>/);
  });

  it('parses a page with relative preload links without an unhandled rejection', async () => {
    const pending = unhandledWithin(600);
    const parsed = parseHtml(PAGE, 'https://www.example.com/science/honey/');
    expect(parsed.title).toBe('Honey lasts');
    expect(JSON.stringify(parsed)).toContain('Egyptian tombs');
    expect(await pending).toBeNull();
  });

  it('parses the same page with NO base url without an unhandled rejection', async () => {
    const pending = unhandledWithin(600);
    const parsed = parseHtml(PAGE);
    expect(parsed.title).toBe('Honey lasts');
    expect(await pending).toBeNull();
  });

  it('createParseWindow ignores non-http base urls and disables file loading', () => {
    const w = createParseWindow('javascript:alert(1)');
    expect(w.happyDOM.settings.disableJavaScriptFileLoading).toBe(true);
    expect(w.happyDOM.settings.disableCSSFileLoading).toBe(true);
    expect(w.happyDOM.settings.disableJavaScriptEvaluation).toBe(true);
    const w2 = createParseWindow('https://www.example.com/a/b');
    expect(w2.location.href).toBe('https://www.example.com/a/b');
  });
});
