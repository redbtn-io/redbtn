import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLogger } from '../../src/lib/utils/logger';

function setEnv(
  logLevel?: string,
  nodeEnv?: string,
) {
  if (logLevel !== undefined) {
    process.env.LOG_LEVEL = logLevel;
  } else {
    delete process.env.LOG_LEVEL;
  }

  if (nodeEnv !== undefined) {
    process.env.NODE_ENV = nodeEnv;
  }
}

describe('logger level parsing', () => {
  afterEach(() => {
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
    vi.restoreAllMocks();
  });

  test('treats whitespace + lowercase as valid symbolic levels', () => {
    setEnv('  warn ');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('Logger');
    logger.info('info');
    logger.warn('warn');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test('accepts numeric LOG_LEVEL aliases', () => {
    setEnv('2');
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('Logger');
    logger.info('info');
    logger.debug('debug');
    expect(infoSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  test('reverts to default when LOG_LEVEL is invalid', () => {
    setEnv('not-a-level', 'production');
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('Logger');
    logger.error('error');
    logger.info('info');
    logger.debug('debug');
    // Invalid value falls back to INFO in production: error + info emit,
    // debug is suppressed. errorSpy asserts on console.error, which only
    // logger.error() writes — so we must actually call it.
    expect(errorSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  test('empty LOG_LEVEL falls through to default instead of ERROR', () => {
    // Regression: an empty LOG_LEVEL (e.g. `LOG_LEVEL=` in .env/compose)
    // trims to '' and used to resolve to LogLevel.ERROR via Number('')===0,
    // silencing warn/info/debug/trace engine-wide. It must default to INFO
    // in production instead.
    setEnv('', 'production');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('Logger');
    logger.warn('warn');
    logger.info('info');
    expect(warnSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  test('whitespace-only LOG_LEVEL falls through to default instead of ERROR', () => {
    // Same regression via a whitespace-only value, which also trims to ''.
    setEnv('   ', 'development');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('Logger');
    logger.warn('warn');
    logger.info('info');
    logger.debug('debug');
    // Development default is DEBUG: warn, info, and debug all emit.
    expect(warnSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });
});
