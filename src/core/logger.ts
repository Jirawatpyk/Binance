import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';

export interface LoggerConfig {
  level: string;
  logsDir: string;
  rotateDays: number;
}

export function createLogger(config: LoggerConfig): winston.Logger {
  const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  );

  const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf((info) => {
      const { timestamp, level, message, ...meta } = info;
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${String(timestamp)} [${level}] ${String(message)}${metaStr}`;
    })
  );

  return winston.createLogger({
    level: config.level,
    format: fileFormat,
    transports: [
      new winston.transports.Console({ format: consoleFormat }),
      new winston.transports.DailyRotateFile({
        filename: path.join(config.logsDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: `${config.rotateDays}d`,
      }),
      new winston.transports.DailyRotateFile({
        filename: path.join(config.logsDir, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxFiles: `${config.rotateDays}d`,
      }),
    ],
  });
}
