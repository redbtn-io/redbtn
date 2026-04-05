/**
 * @deprecated IntegratedToolPublisher was removed in v0.0.51-alpha.
 *
 * This class bridged the legacy MessageQueue.publishToolEvent() with the
 * old respond() execution path. It was only referenced in commented-out
 * code in search/index.ts, command/index.ts, scrape/index.ts, and
 * functions/respond.ts -- never active in production.
 *
 * Tool events are now published via RunPublisher (see src/lib/run/run-publisher.ts).
 */
