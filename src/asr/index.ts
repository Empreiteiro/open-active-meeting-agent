// Transcription of a recording into timed segments. Local first (whisper.cpp,
// the same engine meetily uses), or any OpenAI-compatible transcription API
// (OpenAI, Groq, a local faster-whisper server…).

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { probe, run, toWav16k } from '../media/ffmpeg.js';
import type { Segment } from '../types.js';

export class AsrError extends Error {}

/** Pieces sent to an API: 10 min of 16 kHz mono WAV ≈ 19 MB (under the usual 25 MB cap). */
const API_CHUNK_SEC = 600;

export async function transcribe(input: string, workDir: string, language: string | null): Promise<Segment[]> {
  if (config.asr === 'whisper-cpp') return whisperCpp(input, workDir, language);
  if (config.asr === 'openai') return openaiCompatible(input, workDir, language);
  throw new AsrError('No transcription configured. Set OMA_WHISPER_MODEL (whisper.cpp, local) or OMA_ASR_API_KEY / OPENAI_API_KEY (OpenAI-compatible API). meetily imports need none: they bring their own transcript.');
}

async function whisperCpp(input: string, workDir: string, language: string | null): Promise<Segment[]> {
  if (!config.whisperModel || !existsSync(config.whisperModel)) {
    throw new AsrError(`whisper.cpp model not found: ${config.whisperModel ?? '(OMA_WHISPER_MODEL unset)'}`);
  }
  const wav = await toWav16k(input, path.join(workDir, 'asr.wav'));
  const base = path.join(workDir, 'asr');
  try {
    await run(config.whisperBin, ['-m', config.whisperModel, '-f', wav, '-l', language || 'auto', '-oj', '-of', base, '-np'], 'whisper.cpp', 3 * 60 * 60_000);
    const j = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as {
      transcription?: Array<{ offsets?: { from: number; to: number }; text?: string }>;
    };
    return (j.transcription ?? [])
      .map((s) => ({ start: (s.offsets?.from ?? 0) / 1000, end: (s.offsets?.to ?? 0) / 1000, speaker: 'Unknown', text: (s.text ?? '').trim() }))
      .filter((s) => s.text);
  } finally {
    rmSync(wav, { force: true });
    rmSync(`${base}.json`, { force: true });
  }
}

async function openaiCompatible(input: string, workDir: string, language: string | null): Promise<Segment[]> {
  if (!config.asrApiKey && config.asrBaseUrl.includes('api.openai.com')) throw new AsrError('OMA_ASR_API_KEY or OPENAI_API_KEY is required.');
  const { duration } = await probe(input);
  const out: Segment[] = [];
  for (let from = 0; from < Math.max(duration, 1); from += API_CHUNK_SEC) {
    const len = Math.min(API_CHUNK_SEC, Math.max(duration - from, 1));
    const wav = await toWav16k(input, path.join(workDir, `asr-${from}.wav`), from, len);
    try {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), path.basename(wav));
      form.append('model', config.asrModel);
      form.append('response_format', 'verbose_json');
      form.append('temperature', '0');
      if (language) form.append('language', language.slice(0, 2));
      const r = await fetch(`${config.asrBaseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: config.asrApiKey ? { authorization: `Bearer ${config.asrApiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const body = await r.text();
      if (!r.ok) throw new AsrError(`transcription API: HTTP ${r.status} ${body.slice(0, 300)}`);
      const j = JSON.parse(body) as { text?: string; segments?: Array<{ start: number; end: number; text: string }> };
      if (j.segments?.length) {
        for (const s of j.segments) {
          const text = s.text.trim();
          if (text) out.push({ start: s.start + from, end: s.end + from, speaker: 'Unknown', text });
        }
      } else if (j.text?.trim()) {
        // Models without segments: the piece as one segment.
        out.push({ start: from, end: from + len, speaker: 'Unknown', text: j.text.trim() });
      }
    } finally {
      rmSync(wav, { force: true });
    }
  }
  return out;
}
