import { describe, expect, it } from 'vitest';

import { createConversationArchiveJobId } from '../../src/lib/conversation/conversation-publisher';

describe('ConversationPublisher archive queue', () => {
  it('does not reuse BullMQ job IDs when the archive sequence counter resets', async () => {
    const first = createConversationArchiveJobId('conv-reset', 1, 1782417223000);
    const second = createConversationArchiveJobId('conv-reset', 1, 1782417223001);

    expect(first).toBe('conv-reset_1782417223000_1');
    expect(second).toBe('conv-reset_1782417223001_1');
    expect(first).not.toBe(second);
  });
});
