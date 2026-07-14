import fs from 'node:fs';

export function createLogger(logFilePath) {
  const stream = fs.createWriteStream(logFilePath, { flags: 'a' });

  function log(level, message, extra = null) {
    const line = {
      ts: new Date().toISOString(),
      level,
      message,
      extra
    };
    stream.write(`${JSON.stringify(line)}\n`);

    const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
    const printer = level === 'error' ? console.error : console.log;
    printer(`[${level.toUpperCase()}] ${message}${suffix}`);
  }

  return {
    info(message, extra) {
      log('info', message, extra);
    },
    warn(message, extra) {
      log('warn', message, extra);
    },
    error(message, extra) {
      log('error', message, extra);
    },
    close() {
      stream.end();
    }
  };
}
