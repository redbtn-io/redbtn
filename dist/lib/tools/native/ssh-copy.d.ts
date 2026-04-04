/**
 * SSH Copy — Native System Tool
 *
 * Copies files to a remote machine via SSH/SFTP. Supports three content sources:
 *
 * 1. **Knowledge Library** — `libraryId` (+ optional `documentId`, `since`)
 *    Reads files directly from GridFS (no HTTP, no auth tokens needed).
 *    Can sync an entire library or a single document.
 *
 * 2. **Source URL** — `sourceUrl`
 *    Fetches content from any URL and writes it to the remote path.
 *
 * 3. **Inline content** — `content` (+ optional `contentBase64`)
 *    Writes raw string or base64-decoded content directly.
 *
 * Uses ssh2 SFTP for efficient binary-safe file transfer.
 */
import type { NativeToolDefinition } from '../native-registry';
declare const sshCopy: NativeToolDefinition;
export default sshCopy;
