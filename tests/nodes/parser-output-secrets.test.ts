/**
 * Parser output secret references.
 *
 * A parser node's `parserConfig.outputs[]` carries the endpoints and headers it
 * POSTs to, and a node document is readable by anyone who can call `get_node` —
 * so a credential written there is a credential published. These cover the
 * reference form that replaces it (`{{secret:NAME}}`, resolved from the run's
 * own `_secrets`), the fail-closed behaviour when a name does not resolve, and
 * the same form reaching a parser TOOL step's nested `headers` object.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ParserExecutor } from '../../src/lib/nodes/universal/executors/parserExecutor';

const AUDIO_RESPONSE = {
  candidates: [{ content: { parts: [{ inlineData: { data: 'BASE64AUDIO' } }] } }],
};

function ttsOutput() {
  return {
    id: 'gemini-voice',
    type: 'tts_http' as const,
    condition: { voiceChannel: true },
    ttsEndpoint: 'https://tts.example/v1/{{secret:TTS_MODEL_PATH}}:generate',
    ttsHeaders: { 'Content-Type': 'application/json', 'x-goog-api-key': '{{secret:GOOGLE_API_KEY}}' },
    deliveryEndpoint: 'https://run.example/api/invoke/send-voice',
    deliveryHeaders: { 'Content-Type': 'application/json', 'x-api-key': '{{secret:REDRUN_SEND_VOICE_KEY}}' },
    deliveryBody: { audioData: '{{audio}}', guildId: '{{context.guildId}}', token: '{{secret:REDRUN_SEND_VOICE_KEY}}' },
  };
}

function makeParser(secrets: Record<string, string> | null) {
  const parser = new ParserExecutor(
    { steps: [] } as any,
    { inputField: 'chunk', outputField: 'parsedContent', bufferMode: 'chunk', outputs: [ttsOutput()] } as any,
  );
  parser.setContext({ voiceChannel: true, guildId: 'g-1', _secrets: secrets });
  return parser;
}

describe('ParserExecutor tts_http output — secret references', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => AUDIO_RESPONSE,
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('substitutes {{secret:NAME}} in ttsEndpoint, ttsHeaders, deliveryHeaders and deliveryBody', async () => {
    const parser = makeParser({
      TTS_MODEL_PATH: 'models/gemini-tts',
      GOOGLE_API_KEY: 'AIza-resolved-google',
      REDRUN_SEND_VOICE_KEY: 'redrun-resolved-key',
    });

    await parser.feedText('Hello there. ');

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [ttsUrl, ttsInit] = fetchMock.mock.calls[0]!;
    expect(ttsUrl).toBe('https://tts.example/v1/models/gemini-tts:generate');
    expect((ttsInit as any).headers['x-goog-api-key']).toBe('AIza-resolved-google');

    const [deliveryUrl, deliveryInit] = fetchMock.mock.calls[1]!;
    expect(deliveryUrl).toBe('https://run.example/api/invoke/send-voice');
    expect((deliveryInit as any).headers['x-api-key']).toBe('redrun-resolved-key');

    const body = JSON.parse((deliveryInit as any).body);
    expect(body.audioData).toBe('BASE64AUDIO');
    expect(body.guildId).toBe('g-1');
    expect(body.token).toBe('redrun-resolved-key');
  });

  it('leaves {{audio}} and {{context.*}} rendering untouched', async () => {
    const parser = makeParser({
      TTS_MODEL_PATH: 'models/gemini-tts',
      GOOGLE_API_KEY: 'k1',
      REDRUN_SEND_VOICE_KEY: 'k2',
    });

    await parser.feedText('Hello there. ');

    const body = JSON.parse((fetchMock.mock.calls[1]![1] as any).body);
    expect(body.audioData).toBe('BASE64AUDIO');
    expect(body.guildId).toBe('g-1');
  });

  it('fails closed when a referenced secret did not resolve — no request, no literal placeholder', async () => {
    const parser = makeParser({ TTS_MODEL_PATH: 'models/gemini-tts', REDRUN_SEND_VOICE_KEY: 'k2' });

    await parser.feedText('Hello there. ');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('GOOGLE_API_KEY');
  });

  it('fails closed before the text buffer is consumed, so nothing is silently dropped', async () => {
    const parser = makeParser(null);

    await parser.feedText('Hello there. ');

    expect(fetchMock).not.toHaveBeenCalled();
    expect((parser as any)._parserState._textBuffer).toBe('Hello there. ');
  });

  it('sends a config with no secret references unchanged', async () => {
    const parser = new ParserExecutor(
      { steps: [] } as any,
      {
        inputField: 'chunk',
        outputField: 'parsedContent',
        bufferMode: 'chunk',
        outputs: [{ ...ttsOutput(), ttsEndpoint: 'https://tts.example/v1/plain:generate', ttsHeaders: { 'x-goog-api-key': 'literal' }, deliveryHeaders: { 'x-api-key': 'literal2' }, deliveryBody: { audioData: '{{audio}}' } }],
      } as any,
    );
    parser.setContext({ voiceChannel: true });

    await parser.feedText('Hello there. ');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]![1] as any).headers['x-goog-api-key']).toBe('literal');
    expect((fetchMock.mock.calls[1]![1] as any).headers['x-api-key']).toBe('literal2');
  });
});

describe('ParserExecutor tool steps — secret references', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders {{state._secrets.NAME}} inside a nested headers object', async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const parser = new ParserExecutor(
      {
        steps: [
          {
            type: 'tool',
            config: {
              toolName: 'fetch_url',
              outputField: 'sendVoice',
              parameters: {
                url: 'https://run.example/api/invoke/send-voice',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': '{{state._secrets.REDRUN_SEND_VOICE_KEY}}' },
              },
            },
          },
        ],
      } as any,
      { inputField: 'chunk', outputField: 'parsedContent', bufferMode: 'chunk' } as any,
      executeTool,
    );
    parser.setContext({ _secrets: { REDRUN_SEND_VOICE_KEY: 'redrun-resolved-key' } });

    await parser.processChunk('some text');

    expect(executeTool).toHaveBeenCalledTimes(1);
    const params = executeTool.mock.calls[0]![1] as any;
    expect(params.headers['x-api-key']).toBe('redrun-resolved-key');
    expect(params.headers['Content-Type']).toBe('application/json');
  });

  it('keeps a resolved secret out of the parser tool-step log line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const executeTool = vi.fn(async () => ({ ok: true }));
    const parser = new ParserExecutor(
      {
        steps: [
          {
            type: 'tool',
            config: {
              toolName: 'fetch_url',
              outputField: 'sendVoice',
              parameters: { headers: { 'x-api-key': '{{state._secrets.REDRUN_SEND_VOICE_KEY}}' } },
            },
          },
        ],
      } as any,
      { inputField: 'chunk', outputField: 'parsedContent', bufferMode: 'chunk' } as any,
      executeTool,
    );
    parser.setContext({ _secrets: { REDRUN_SEND_VOICE_KEY: 'redrun-resolved-key' } });

    await parser.processChunk('some text');

    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain('redrun-resolved-key');
    expect(logged).toContain('{{secret:REDRUN_SEND_VOICE_KEY}}');
  });

  it('does not expose the secret map through {{context.*}}', async () => {
    const parser = new ParserExecutor({ steps: [] } as any, {} as any);
    parser.setContext({ channelId: 'c-1', _secrets: { REDRUN_SEND_VOICE_KEY: 'redrun-resolved-key' } });
    expect((parser as any)._parserState._context).toEqual({ channelId: 'c-1' });
  });
});
