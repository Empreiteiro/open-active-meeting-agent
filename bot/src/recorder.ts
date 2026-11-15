import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Records the meeting from the PulseAudio sink "MeetingSink" (entrypoint.sh;
 * Chromium plays into it) + optionally the video of the Xvfb display.
 *
 * Audio always comes out mono 16 kHz (Whisper's format) → the pipeline skips
 * extract_audio. With RECORD_VIDEO it also records <id>.mp4 (x11grab + audio)
 * and derives the .m4a from the mp4 at the end (handback sends both).
 */
export class Recorder {
  private proc: ChildProcess | null = null;
  private startedAt = 0;
  readonly audioPath: string;
  readonly videoPath: string | null;

  constructor() {
    this.audioPath = path.join(config.tempDir, 'audio.m4a');
    this.videoPath = config.recordVideo
      ? path.join(config.tempDir, 'recording.mp4')
      : null;
  }

  /** Compat: handback uses outputPath as the audio for the pipeline. */
  get outputPath(): string {
    return this.audioPath;
  }

  elapsed(): number {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  /** When (epoch ms) the recording started: the clock of the speaker
   *  timeline. The segmenter converts segment times to it. */
  get startedAtMs(): number {
    return this.startedAt;
  }

  async start(): Promise<void> {
    await mkdir(config.tempDir, { recursive: true });
    // Anti-"choppy audio": PulseAudio capture underruns when the VM (shared
    // CPU) is saturated (Chromium rendering the call + encoding). Without a
    // buffer, ffmpeg DROPS samples → the audio comes out shorter than the clock
    // and sounds sped up/cut. Mitigations on the audio input:
    //  - large thread_queue_size: absorbs scheduling spikes without dropping.
    //  - use_wallclock_as_timestamps: timestamps from the real clock (not from
    //    the sample count), so a gap becomes time instead of vanishing.
    //  - aresample=async=1: fills gaps with silence, keeping the DURATION
    //    equal to the clock (instead of speeding up). A gap becomes silence.
    const PULSE_IN = [
      '-thread_queue_size', '4096',
      '-use_wallclock_as_timestamps', '1',
      '-f', 'pulse', '-i', 'MeetingSink.monitor',
    ];
    const args =
      config.recordVideo && this.videoPath
        ? [
            '-y',
            '-thread_queue_size', '4096',
            '-f', 'x11grab', '-framerate', '15',
            '-video_size', '1280x720', '-i', process.env.DISPLAY ?? ':99',
            ...PULSE_IN,
            '-af', 'aresample=async=1',
            '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k',
            this.videoPath,
          ]
        : [
            '-y',
            ...PULSE_IN,
            '-af', 'aresample=async=1',
            '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k',
            this.audioPath,
          ];
    // PULSE_LATENCY_MSEC enlarges the PulseAudio client buffer → fewer
    // underruns when the CPU stalls (higher latency doesn't matter for recording).
    this.proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PULSE_LATENCY_MSEC: process.env.PULSE_LATENCY_MSEC ?? '1000' },
    });
    this.startedAt = Date.now();
    let tail = '';
    this.proc.stderr?.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
    this.proc.on('exit', (code) => {
      if (code && code !== 255) log.error({ code, tail }, 'ffmpeg exited with an error');
    });
    log.info({ video: config.recordVideo }, 'recording started');
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    await new Promise<void>((resolve) => {
      p.once('exit', () => resolve());
      p.kill('SIGTERM'); // lets ffmpeg write the mp4/m4a moov atom properly
      setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); resolve(); }, 8_000);
    });
    // Video mode: extract mono 16k audio from the mp4 to feed the pipeline.
    if (config.recordVideo && this.videoPath) {
      await new Promise<void>((resolve) => {
        const x = spawn('ffmpeg', [
          '-y', '-i', this.videoPath!, '-vn',
          '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k',
          this.audioPath,
        ], { stdio: 'ignore' });
        x.on('exit', () => resolve());
        x.on('error', () => resolve());
        setTimeout(resolve, 30_000);
      });
    }
    log.info('recording stopped');
  }
}
