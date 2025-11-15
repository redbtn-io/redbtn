import { InvokeOptions, Red } from '../..';

interface ContextNodeState {
  redInstance: Red;
  options?: InvokeOptions;
  messageId?: string;
  nodeNumber?: number;
  contextMessages?: any[];
  contextSummary?: string;
  contextLoaded?: boolean;
}

export const contextNode = async (state: ContextNodeState) => {
  const redInstance = state.redInstance;
  const options = state.options || {};
  const conversationId = options.conversationId;
  const generationId = options.generationId;
  const messageId = state.messageId;
  const currentNodeNumber = state.nodeNumber || 1;
  const nextNodeNumber = currentNodeNumber + 1;

  // If context already loaded (or no conversation), skip work but advance node number
  if (state.contextLoaded || !conversationId) {
    return {
      contextLoaded: true,
      nodeNumber: nextNodeNumber
    };
  }

  let contextMessages: any[] = [];
  let contextSummary = '';

  await redInstance.logger.log({
    level: 'info',
    category: 'context',
    message: `<cyan>🧱 Loading conversation context</cyan>`,
    conversationId,
    generationId,
  });

  try {
    const contextResult = await redInstance.callMcpTool(
      'get_context_history',
      {
        conversationId,
        maxTokens: 30000,
        includeSummary: true,
        summaryType: 'trailing',
        format: 'llm'
      },
      {
        conversationId,
        generationId,
        messageId
      }
    );

    if (!contextResult.isError && contextResult.content?.[0]?.text) {
      const contextData = JSON.parse(contextResult.content[0].text);
      const rawMessages = contextData.messages || [];

      const seenContent = new Set<string>();
      contextMessages = rawMessages.filter((msg: any) => {
        const key = `${msg.role}:${msg.content}`;
        if (seenContent.has(key)) {
          return false;
        }
        seenContent.add(key);
        return true;
      });

      const removed = rawMessages.length - contextMessages.length;
      if (removed > 0) {
        await redInstance.logger.log({
          level: 'debug',
          category: 'context',
          message: `<yellow>⚠ Removed ${removed} duplicate context messages</yellow>`,
          conversationId,
          generationId,
        });
      }
    }
  } catch (error) {
    console.warn('[ContextNode] Failed to load context history:', error);
  }

  try {
    const summaryResult = await redInstance.callMcpTool(
      'get_summary',
      {
        conversationId,
        summaryType: 'executive'
      },
      {
        conversationId,
        generationId,
        messageId
      }
    );

    if (!summaryResult.isError && summaryResult.content?.[0]?.text) {
      const summaryData = JSON.parse(summaryResult.content[0].text);
      if (summaryData.summary) {
        contextSummary = summaryData.summary;
      }
    }
  } catch (error) {
    console.warn('[ContextNode] Failed to load executive summary:', error);
  }

  return {
    contextMessages,
    contextSummary,
    contextLoaded: true,
    nodeNumber: nextNodeNumber
  };
};
