import { describe, it, expect } from 'vitest';
import { geminiTtsPrompt, GEMINI_TTS_READ_ALOUD_PREFIX } from '../../src/lib/tools/native/synthesize-speech';

describe('synthesize_speech: Gemini TTS transcript prompt', () => {
  it('prefixes the transcript with the read-aloud instruction', () => {
    const out = geminiTtsPrompt('Hey Red, count to eight.');
    expect(out.startsWith(GEMINI_TTS_READ_ALOUD_PREFIX)).toBe(true);
    expect(out.endsWith('Hey Red, count to eight.')).toBe(true);
  });
  it('does not double the prefix', () => {
    const once = geminiTtsPrompt('ok');
    expect(geminiTtsPrompt(once)).toBe(once);
  });
  it('tolerates empty and non-string input', () => {
    expect(geminiTtsPrompt('')).toBe(GEMINI_TTS_READ_ALOUD_PREFIX);
    expect(geminiTtsPrompt(undefined as unknown as string)).toBe(GEMINI_TTS_READ_ALOUD_PREFIX);
  });
});
