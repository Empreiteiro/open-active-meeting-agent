// meetily (github.com/Zackriya-Solutions/meetily) records the meeting on the
// person's own machine — microphone + system audio — and transcribes it
// locally. Its SQLite is read here (read-only): the meeting, its timed
// transcript (mic = the person, system = everyone else) and the notes taken
// during it. The audio file sits in the meeting's folder (audio.mp4).

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Segment } from '../types.js';

type Row = Record<string, unknown>;

interface SqliteDb { prepare(sql: string): { all(...p: unknown[]): Row[]; get(...p: unknown[]): Row | undefined }; close(): void }

async function openDb(file: string): Promise<SqliteDb> {
  if (!existsSync(file)) throw new Error(`meetily database not found at ${file} (set OMA_MEETILY_DB)`);
  // node:sqlite is built in from Node 22.13; loaded lazily so nothing else needs it.
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true }) as unknown as SqliteDb;
}

function hasColumn(db: SqliteDb, table: string, col: string): boolean {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
}

export interface MeetilyMeeting {
  id: string;
  title: string;
  created_at: string;
  folder_path: string | null;
  segments: number;
}

export async function listMeetilyMeetings(limit = 20, dbFile = config.meetilyDb): Promise<MeetilyMeeting[]> {
  const db = await openDb(dbFile);
  try {
    const folder = hasColumn(db, 'meetings', 'folder_path') ? 'm.folder_path' : 'NULL';
    return db.prepare(
      `SELECT m.id, m.title, m.created_at, ${folder} AS folder_path, COUNT(t.id) AS segments
         FROM meetings m LEFT JOIN transcripts t ON t.meeting_id = m.id
        GROUP BY m.id ORDER BY m.created_at DESC LIMIT ?`,
    ).all(limit).map((r) => ({
      id: String(r.id), title: String(r.title ?? ''), created_at: String(r.created_at ?? ''),
      folder_path: r.folder_path ? String(r.folder_path) : null, segments: Number(r.segments ?? 0),
    }));
  } finally {
    db.close();
  }
}

export interface MeetilyExport {
  meeting: MeetilyMeeting;
  segments: Segment[];
  notes: string | null;
  audio: string | null;
}

/** The meeting's transcript on the recording's timeline. Older rows without
 *  audio times fall back to their wall-clock timestamp, relative to the first. */
export async function readMeetilyMeeting(id: string, dbFile = config.meetilyDb): Promise<MeetilyExport> {
  const db = await openDb(dbFile);
  try {
    const folder = hasColumn(db, 'meetings', 'folder_path') ? 'folder_path' : 'NULL AS folder_path';
    const m = db.prepare(`SELECT id, title, created_at, ${folder} FROM meetings WHERE id = ?`).get(id);
    if (!m) throw new Error(`meetily meeting not found: ${id}`);
    const timed = hasColumn(db, 'transcripts', 'audio_start_time');
    const spk = hasColumn(db, 'transcripts', 'speaker');
    const rows = db.prepare(
      `SELECT transcript, timestamp, ${timed ? 'audio_start_time, audio_end_time, duration' : 'NULL AS audio_start_time, NULL AS audio_end_time, NULL AS duration'},
              ${spk ? 'speaker' : 'NULL AS speaker'}
         FROM transcripts WHERE meeting_id = ? ORDER BY ${timed ? 'COALESCE(audio_start_time, 0),' : ''} timestamp`,
    ).all(id);
    const firstWall = rows.map((r) => Date.parse(String(r.timestamp ?? ''))).find((t) => Number.isFinite(t)) ?? null;
    const me = process.env.OMA_MEETILY_ME_NAME || 'Me';
    const others = process.env.OMA_MEETILY_OTHERS_NAME || 'Others';
    const segments: Segment[] = rows.map((r) => {
      const wall = Date.parse(String(r.timestamp ?? ''));
      const start = r.audio_start_time != null ? Number(r.audio_start_time)
        : firstWall != null && Number.isFinite(wall) ? (wall - firstWall) / 1000 : 0;
      const end = r.audio_end_time != null ? Number(r.audio_end_time)
        : r.duration != null ? start + Number(r.duration) : start;
      const speaker = r.speaker === 'mic' ? me : r.speaker === 'system' ? others : 'Unknown';
      return { start, end, speaker, text: String(r.transcript ?? '').trim() };
    }).filter((s) => s.text);
    let notes: string | null = null;
    try {
      const n = db.prepare('SELECT notes_markdown FROM meeting_notes WHERE meeting_id = ?').get(id);
      notes = n?.notes_markdown ? String(n.notes_markdown) : null;
    } catch {}
    const meeting: MeetilyMeeting = {
      id: String(m.id), title: String(m.title ?? ''), created_at: String(m.created_at ?? ''),
      folder_path: m.folder_path ? String(m.folder_path) : null, segments: segments.length,
    };
    return { meeting, segments, notes, audio: findAudio(meeting.folder_path) };
  } finally {
    db.close();
  }
}

function findAudio(folder: string | null): string | null {
  if (!folder || !existsSync(folder)) return null;
  const direct = path.join(folder, 'audio.mp4');
  if (existsSync(direct)) return direct;
  const any = readdirSync(folder).find((f) => /\.(mp4|m4a|wav|mp3|webm)$/i.test(f));
  return any ? path.join(folder, any) : null;
}
