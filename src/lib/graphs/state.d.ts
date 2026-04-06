/**
 * 1. Define the State using Annotation
 * This is the shared memory object that flows between nodes.
 */
export declare const RedGraphState: import("@langchain/langgraph").AnnotationRoot<{
    neuronRegistry: import("@langchain/langgraph").BinaryOperatorAggregate<any, any>;
    mcpClient: import("@langchain/langgraph").BinaryOperatorAggregate<any, any>;
    memory: import("@langchain/langgraph").BinaryOperatorAggregate<any, any>;
    logger: import("@langchain/langgraph").BinaryOperatorAggregate<any, any>;
    runPublisher: import("@langchain/langgraph").BinaryOperatorAggregate<any, any>;
    graphPublisher: import("@langchain/langgraph").BinaryOperatorAggregate<any, any>;
    messageId: import("@langchain/langgraph").BinaryOperatorAggregate<string | undefined, string | undefined>;
    graphName: import("@langchain/langgraph").BinaryOperatorAggregate<string | undefined, string | undefined>;
    graphId: import("@langchain/langgraph").BinaryOperatorAggregate<string | undefined, string | undefined>;
    data: import("@langchain/langgraph").BinaryOperatorAggregate<Record<string, any>, Record<string, any>>;
    mcpRegistry: import("@langchain/langgraph").BinaryOperatorAggregate<any, any>;
    nodeCounter: import("@langchain/langgraph").BinaryOperatorAggregate<number, number>;
    _graphRegistry: import("@langchain/langgraph").BinaryOperatorAggregate<any, any>;
    _subgraphDepth: import("@langchain/langgraph").BinaryOperatorAggregate<number, number>;
}>;
export type RedGraphStateType = typeof RedGraphState.State;
