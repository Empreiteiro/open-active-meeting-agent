// Bot settings, all from the environment the runner gives the container.
// The bot never talks to a server: everything goes through OUT_DIR (a volume).

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} is required`);
  return v;
}

export const config = {
  joinUrl: req('JOIN_URL'),
  provider: req('PROVIDER') as 'google_meet' | 'microsoft_teams',
  displayName: process.env.BOT_DISPLAY_NAME ?? 'Meeting Agent',

  /** The volume shared with the host: status, control and the recording. */
  outDir: process.env.OUT_DIR ?? '/out',
  /** Where ffmpeg writes while recording (moved to outDir at the end). */
  tempDir: process.env.TEMP_DIR ?? '/tmp/meeting-agent',

  // A logged-in Playwright storageState (optional). Without it the bot joins
  // as a guest and someone in the meeting admits it.
  authPath: process.env.BOT_AUTH_PATH ?? '',
  // Fallback login when Google rejects the saved session (no 2FA accounts only).
  googleEmail: process.env.BOT_GOOGLE_EMAIL ?? '',
  googlePassword: process.env.BOT_GOOGLE_PASSWORD ?? '',

  /** The agent records the screen by default: the plan uses what was shown. */
  recordVideo: process.env.RECORD_VIDEO !== '0',
  locale: process.env.BOT_LOCALE ?? 'en-US',
  timezone: process.env.BOT_TIMEZONE ?? 'UTC',

  // Lifecycle limits
  /** Waiting to be admitted (lobby), from the click on "join". */
  joinTimeoutMs: Number(process.env.JOIN_TIMEOUT_MS ?? 300_000),
  /** Alone in the meeting for this long → leave. */
  aloneGraceMs: Number(process.env.ALONE_GRACE_MS ?? 120_000),
  maxMeetingMs: Number(process.env.MAX_MEETING_MINUTES ?? 120) * 60_000,
  /** The call "ended" this soon without the bot ever seeing anyone → it was never admitted. */
  earlyExitMs: Number(process.env.EARLY_EXIT_MS ?? 60_000),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 800),
  /** Cap when the participant count can't be read (the meeting's DOM changed). */
  scheduledEndMs: parseIsoMs(process.env.SCHEDULED_END),
  scheduledStartMs: parseIsoMs(process.env.SCHEDULED_START),
} as const;

function parseIsoMs(raw?: string): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export type BotConfig = typeof config;
