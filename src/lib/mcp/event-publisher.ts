/**
 * @deprecated McpEventPublisher was removed in v0.0.51-alpha.
 *
 * This class published tool events to Redis pub/sub using the legacy
 * `tool:event:{messageId}` key pattern. It was never instantiated in
 * production code — only defined and re-exported.
 *
 * Tool events are now published via RunPublisher (see src/lib/run/run-publisher.ts).
 * The `tool:event:*` Redis key pattern is no longer written to.
 */
