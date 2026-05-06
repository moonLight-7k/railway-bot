import { createLogger, format, transports } from 'winston';
import { inspect } from 'util';

const { combine, timestamp, printf, colorize, errors } = format;

// Custom format to sanitize stack traces and sensitive data
const sanitizeFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  let log = `${timestamp} [${level}]: ${message}`;

  // Sanitize stack traces to avoid leaking internal paths
  if (stack) {
    stack = stack.replace(/\\/g, '/'); // Normalize paths
    stack = stack.replace(/(file:\/\/|\/home\/\w+\/)/g, ''); // Remove home dir paths
    log += `\n${stack}`;
  }

  // Sanitize meta fields
  if (Object.keys(meta).length) {
    const sanitizedMeta = JSON.stringify(meta, (key, value) => {
      // Redact sensitive fields
      if (['token', 'apiKey', 'secret', 'password', 'webhookSecret'].includes(key)) {
        return '****';
      }
      return value;
    });
    log += ` ${sanitizedMeta}`;
  }

  return log;
});

// Create logger instance
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }), // Include stack traces
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    sanitizeFormat
  ),
  transports: [
    new transports.Console({
      format: combine(colorize(), sanitizeFormat),
    }),
    new transports.File({
      filename: 'railwaybot.log',
      maxsize: 10_000_000, // 10MB
      maxFiles: 5,
    }),
  ],
  exitOnError: false, // Do not crash on logging errors
});

// Helper to log errors with context
const logError = (error: Error, context?: Record<string, unknown>) => {
  logger.error(error.message, { error, ...context });
};

// Helper to log and truncate messages for Discord (preserving existing behavior)
const formatErrorForDiscord = (error: Error, maxLength = 1900) => {
  let message = error.stack || error.message;
  if (message.length > maxLength) {
    message = message.substring(0, maxLength) + '... (truncated)';
  }
  return message;
};

// Helper to redact sensitive fields in objects
const redactSensitive = (obj: Record<string, unknown>) => {
  const sensitiveKeys = ['token', 'apiKey', 'secret', 'password', 'webhookSecret'];
  const result = { ...obj };
  for (const key of sensitiveKeys) {
    if (key in result) {
      result[key] = '****';
    }
  }
  return result;
};

// Export logger and helpers
export { logger, logError, formatErrorForDiscord, redactSensitive };