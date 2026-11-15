import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'open-meeting-agent-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
