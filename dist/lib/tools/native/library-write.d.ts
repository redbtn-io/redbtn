/**
 * Library Write — Native System Tool
 *
 * Writes content to a Knowledge Library programmatically.
 * Creates a document in GridFS, adds it to the library's document list,
 * and optionally chunks + indexes it in the vector store.
 *
 * Use cases:
 * - Automation graphs writing scan results, reports, or digests
 * - Programmatic ingestion from external sources
 * - Agent output archival
 */
import type { NativeToolDefinition } from '../native-registry';
declare const libraryWrite: NativeToolDefinition;
export default libraryWrite;
