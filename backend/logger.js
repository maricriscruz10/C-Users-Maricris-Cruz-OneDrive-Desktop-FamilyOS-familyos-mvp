// Minimal structured logger — writes to console + logs/app.log. No deps.
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'app.log');

function write(level, scope, message, meta) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta } : {}),
  });
  fs.appendFile(LOG_FILE, line + '\n', () => {});
  const consoleFn = level === 'error' ? console.error : console.log;
  consoleFn(`[${level.toUpperCase()}] ${scope}: ${message}`);
}

const logger = {
  info: (scope, message, meta) => write('info', scope, message, meta),
  warn: (scope, message, meta) => write('warn', scope, message, meta),
  error: (scope, message, meta) => write('error', scope, message, meta),
};

module.exports = { logger, LOG_FILE };
