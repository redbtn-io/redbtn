/**
 * STT Error Baseline and Attribution Engine (Card 6aa1d9c408971669b4a25d1f).
 *
 * Implements:
 * - Fixed spoken reference script tracking technical vocabulary.
 * - Normalized Levenshtein Word Error Rate (WER) computation.
 * - Objective attribution labelling ('retrieval' vs 'transcription').
 */
import { FailureAttribution, TranscriptionSample } from './types';

export interface SpokenPhrase {
  id: string;
  reference: string;
  criticalEntities: string[];
}

export const CANONICAL_SPOKEN_SCRIPT: SpokenPhrase[] = [
  {
    id: 'stt-01',
    reference: 'tmux list-sessions or grep ps for opus',
    criticalEntities: ['tmux', 'list-sessions', 'grep', 'ps', 'opus'],
  },
  {
    id: 'stt-02',
    reference: 'Ask your work specialist',
    criticalEntities: ['work specialist'],
  },
  {
    id: 'stt-03',
    reference: 'Check ChromaDB port 8024 on redServer',
    criticalEntities: ['chromadb', '8024', 'redserver'],
  },
  {
    id: 'stt-04',
    reference: 'WireGuard mesh CIDR 10.100.0.0/24 with port 51820',
    criticalEntities: ['wireguard', '10.100.0.0/24', '51820'],
  },
  {
    id: 'stt-05',
    reference: 'LiveKit SFU on alphaServer port 7880 and UDP 7881',
    criticalEntities: ['livekit', 'alphaserver', '7880', '7881'],
  },
  {
    id: 'stt-06',
    reference: 'Nightly Dream Consolidator runs at 03:00 ET cron 0 7 * * *',
    criticalEntities: ['dream consolidator', '03:00', '0 7 * * *'],
  },
  {
    id: 'stt-07',
    reference: 'MongoDB rs0 on 192.168.1.10 port 27017 single-node',
    criticalEntities: ['mongodb', 'rs0', '27017', 'single-node'],
  },
  {
    id: 'stt-08',
    reference: 'Become fitness app database is become on rs0',
    criticalEntities: ['become', 'database', 'rs0'],
  },
];

/**
 * Normalizes text for word error rate calculation.
 */
export function normalizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s\.\/\-\:\*]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Computes Levenshtein Word Error Rate (WER) between reference and transcribed words.
 * WER = (Substitutions + Insertions + Deletions) / ReferenceLength
 */
export function calculateWordErrorRate(refText: string, hypText: string): number {
  const ref = normalizeText(refText);
  const hyp = normalizeText(hypText);

  if (ref.length === 0) {
    return hyp.length === 0 ? 0 : 1;
  }

  const d: number[][] = [];
  for (let i = 0; i <= ref.length; i++) {
    d[i] = [i];
  }
  for (let j = 0; j <= hyp.length; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
    }
  }

  const editDistance = d[ref.length][hyp.length];
  return Math.min(1, editDistance / ref.length);
}

/**
 * Detects if critical domain entities in the reference sentence were mangled in the transcript.
 */
export function detectMangledEntities(ref: SpokenPhrase, transcribed: string): string[] {
  const normHyp = transcribed.toLowerCase();
  const mangled: string[] = [];
  for (const entity of ref.criticalEntities) {
    if (!normHyp.includes(entity.toLowerCase())) {
      mangled.push(entity);
    }
  }
  return mangled;
}

/**
 * Evaluates transcription samples against the canonical script and returns aggregate telemetry.
 */
export function evaluateTranscriptionBaseline(
  samples: Array<{ phraseId: string; transcribedText: string }>,
): {
  averageWer: number;
  errorRatePercent: number;
  evaluatedSamples: TranscriptionSample[];
} {
  const evaluated: TranscriptionSample[] = [];
  let totalWer = 0;

  for (const sample of samples) {
    const ref = CANONICAL_SPOKEN_SCRIPT.find((p) => p.id === sample.phraseId);
    if (!ref) continue;

    const wer = calculateWordErrorRate(ref.reference, sample.transcribedText);
    totalWer += wer;
    const mangled = detectMangledEntities(ref, sample.transcribedText);

    evaluated.push({
      id: sample.phraseId,
      referenceText: ref.reference,
      transcribedText: sample.transcribedText,
      wer,
      mangledEntities: mangled,
    });
  }

  const averageWer = evaluated.length > 0 ? totalWer / evaluated.length : 0;
  return {
    averageWer,
    errorRatePercent: Math.round(averageWer * 1000) / 10,
    evaluatedSamples: evaluated,
  };
}

/**
 * Attributes a recall failure strictly to either 'transcription' or 'retrieval'.
 * Never assumes retrieval without verifying transcription accuracy!
 */
export function attributeFailure(
  query: string,
  transcribedQuery: string | undefined,
  expectedKeywords: string[],
): { attribution: FailureAttribution; reason: string } {
  if (!transcribedQuery) {
    // If no transcription was involved (direct text query), failure is retrieval.
    return {
      attribution: 'retrieval',
      reason: 'Direct query: text input matched reference, memory was not recalled by engine.',
    };
  }

  const normQuery = query.toLowerCase();
  const normTranscribed = transcribedQuery.toLowerCase();

  // Check if expected keywords were corrupted in the transcribed query
  const missingKeywords = expectedKeywords.filter(
    (kw) => normQuery.includes(kw.toLowerCase()) && !normTranscribed.includes(kw.toLowerCase()),
  );

  const queryWer = calculateWordErrorRate(query, transcribedQuery);

  if (missingKeywords.length > 0 || queryWer >= 0.25) {
    return {
      attribution: 'transcription',
      reason: `STT corrupted critical entities: [${missingKeywords.join(', ')}]. Query WER: ${(
        queryWer * 100
      ).toFixed(1)}%. Engine received mangled acoustic input.`,
    };
  }

  return {
    attribution: 'retrieval',
    reason: `Transcription was accurate (WER ${(queryWer * 100).toFixed(
      1,
    )}%), but memory engine failed to retrieve fact card.`,
  };
}
