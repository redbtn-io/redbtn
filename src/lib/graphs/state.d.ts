/**
 * 1. Define the State using Annotation
 * This is the shared memory object that flows between nodes.
 *
 * IMPORTANT: Infrastructure objects (RunPublisher, NeuronRegistry, McpClient,
 * Memory, ConnectionManager, GraphRegistry, etc.) are deliberately NOT declared
 * as channels. They live in `runControlRegistry` (lib/run/RunControlRegistry.ts)
 * keyed by `state.runId`. Step executors read them via the `getX(state)`
 * helpers in `lib/run/contextLookup.ts`. See the state.js docstring for the
 * full bug rationale.
 */
export declare const RedGraphState: import("@langchain/langgraph").AnnotationRoot<{
    messageId: import("@langchain/langgraph").BinaryOperatorAggregate<string | undefined, string | undefined>;
    graphName: import("@langchain/langgraph").BinaryOperatorAggregate<string | undefined, string | undefined>;
    graphId: import("@langchain/langgraph").BinaryOperatorAggregate<string | undefined, string | undefined>;
    data: import("@langchain/langgraph").BinaryOperatorAggregate<Record<string, any>, Record<string, any>>;
    nodeCounter: import("@langchain/langgraph").BinaryOperatorAggregate<number, number>;
    _subgraphDepth: import("@langchain/langgraph").BinaryOperatorAggregate<number, number>;
}>;
export type RedGraphStateType = typeof RedGraphState.State;
