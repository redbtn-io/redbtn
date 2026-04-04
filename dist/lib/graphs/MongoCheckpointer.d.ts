/**
 * MongoDB Checkpointer for LangGraph
 *
 * Persists graph state to MongoDB after every node completes.
 * On crash/retry, the graph resumes from the last completed checkpoint.
 *
 * Collection: graphcheckpoints
 * TTL: 7 days (auto-cleanup via MongoDB TTL index)
 *
 * Key design decisions:
 * - Uses the existing Mongoose connection (no new connection)
 * - thread_id = runId (each run has its own isolated checkpoint thread)
 * - Serializes checkpoint data using the langgraph-checkpoint JsonPlusSerializer
 * - Stores pending writes separately for full resume fidelity
 */
declare const BaseCheckpointSaver: any;
export declare class MongoCheckpointer extends BaseCheckpointSaver {
    constructor(serde?: any);
    getTuple(config: any): Promise<any>;
    list(config: any, options?: any): AsyncGenerator<any>;
    put(config: any, checkpoint: any, metadata: any, _newVersions?: any): Promise<any>;
    putWrites(config: any, writes: any[], taskId: string): Promise<void>;
    deleteThread(threadId: string): Promise<void>;
}
export declare function createMongoCheckpointer(): MongoCheckpointer;
export {};
