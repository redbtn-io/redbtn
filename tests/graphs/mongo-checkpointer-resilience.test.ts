import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import mongoose from 'mongoose';

const mocks = vi.hoisted(() => ({
  checkpointUpdate: vi.fn(),
  writeUpdate: vi.fn(),
}));

const config = {
  configurable: {
    conversation_id: 'conversation-1',
    thread_id: 'thread-1',
    checkpoint_ns: '',
    checkpoint_id: 'parent-checkpoint',
  },
};

const checkpoint = {
  id: 'checkpoint-2',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
  pending_sends: [],
};

function serde() {
  return {
    dumpsTyped: vi.fn(async (value: unknown) => ['json', Buffer.from(String(value))]),
  };
}

async function loadCheckpointer(maxBytes: number) {
  process.env.CHECKPOINT_MAX_BYTES = String(maxBytes);
  vi.resetModules();
  return import('../../src/lib/graphs/MongoCheckpointer');
}

describe('MongoCheckpointer persistence resilience', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkpointUpdate.mockResolvedValue({});
    mocks.writeUpdate.mockResolvedValue({});
    (mongoose.models as any).GraphCheckpoint = {
      findOneAndUpdate: (...args: unknown[]) => mocks.checkpointUpdate(...args),
    };
    (mongoose.models as any).GraphCheckpointWrite = {
      findOneAndUpdate: (...args: unknown[]) => mocks.writeUpdate(...args),
    };
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    delete (mongoose.models as any).GraphCheckpoint;
    delete (mongoose.models as any).GraphCheckpointWrite;
    delete process.env.CHECKPOINT_MAX_BYTES;
  });

  test('returns checkpoint config without persisting a checkpoint over the configured ceiling', async () => {
    const { MongoCheckpointer } = await loadCheckpointer(10);
    const saver = new MongoCheckpointer(serde());

    await expect(saver.put(config, checkpoint, 'metadata')).resolves.toEqual({
      configurable: {
        conversation_id: 'conversation-1',
        thread_id: 'thread-1',
        checkpoint_ns: '',
        checkpoint_id: 'checkpoint-2',
      },
    });

    expect(mocks.checkpointUpdate).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds 10 bytes'));
  });

  test('skips only oversized pending writes and persists unaffected writes', async () => {
    const { MongoCheckpointer } = await loadCheckpointer(10);
    const saver = new MongoCheckpointer(serde());

    await expect(saver.putWrites(config, [
      ['oversized', 'this value is too large'],
      ['small', 'ok'],
    ], 'task-1')).resolves.toBeUndefined();

    expect(mocks.writeUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.writeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', idx: 1 }),
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ channel: 'small' }) }),
      { upsert: true },
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('putWrites(oversized) skipped'));
  });

  test('contains checkpoint and individual pending-write database failures', async () => {
    mocks.checkpointUpdate.mockRejectedValueOnce(new Error('checkpoint database unavailable'));
    mocks.writeUpdate.mockImplementation(async (_query: unknown, update: any) => {
      if (update.$setOnInsert.channel === 'broken') throw new Error('write database unavailable');
      return {};
    });
    const { MongoCheckpointer } = await loadCheckpointer(1000);
    const saver = new MongoCheckpointer(serde());

    await expect(saver.put(config, checkpoint, 'metadata')).resolves.toEqual({
      configurable: expect.objectContaining({ checkpoint_id: 'checkpoint-2' }),
    });
    await expect(saver.putWrites(config, [
      ['broken', 'first'],
      ['healthy', 'second'],
    ], 'task-2')).resolves.toBeUndefined();

    expect(mocks.writeUpdate).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('put error (non-fatal, checkpoint skipped):'),
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('putWrites(broken) error (non-fatal, write skipped):'),
      expect.any(Error),
    );
  });
});
