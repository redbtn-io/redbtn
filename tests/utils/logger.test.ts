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
    logger.info('info');
    logger.debug('debug');
    expect(infoSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});
