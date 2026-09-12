/**
 * Fleet Projection Parser (Card 6aa1d9d708971669b4a25d25).
 *
 * Enforces one-way, read-only projection from disk to platform.
 * Reads index files and YAML frontmatter to create lightweight pointer records.
 * NEVER writes files to any filesystem or modifies brain-sync.
 *
 * @module lib/memory/fleet-projection/parser
 */

import type {
  FleetBucket,
  FleetMemoryPointer,
  FleetProjectionReport,
  FleetTier,
  FleetTopicFileMetadata,
  OrphanFileSummary,
} from './types';

export const MAX_INDEX_LINE_CHARS = 120;

export const DORMANCY_NOTICE =
  'Every fleet-sourced memory carries a dormancy marker: the file tier is not safe as a ' +
  'statement of current state (e.g. automations described as live may be paused). ' +
  'Verify live state via operational tools before taking destructive or dependent actions.';

/**
 * Parses frontmatter from markdown content.
 * Does not read the whole file body into state.
 */
export function extractFrontmatter(content: string): FleetTopicFileMetadata {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const yaml = match[1];

  const meta: FleetTopicFileMetadata = {};

  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) meta.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');

  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  if (descMatch) meta.description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

  const typeMatch = yaml.match(/^type:\s*(\w+)/m) || yaml.match(/^\s*type:\s*(\w+)/m);
  if (typeMatch) meta.type = typeMatch[1].trim() as FleetBucket;

  const modifiedMatch = yaml.match(/modified:\s*([^\r\n]+)/);
  if (modifiedMatch) {
    meta.modified = modifiedMatch[1].trim().replace(/^['"]|['"]$/g, '');
  }

  const originMatch = yaml.match(/originSessionId:\s*([^\r\n]+)/);
  if (originMatch) {
    meta.originSessionId = originMatch[1].trim().replace(/^['"]|['"]$/g, '');
  }

  return meta;
}

export interface ParsedIndexLine {
  label: string;
  fileRef: string;
  description: string;
}

/**
 * Parses active MEMORY.md index lines:
 * e.g. "- [alcon contract](alcon_contract.md) — George writes Alcon AVS..."
 */
export function parseActiveMemoryIndex(content: string): ParsedIndexLine[] {
  const lines = content.split(/\r?\n/);
  const results: ParsedIndexLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- [')) continue;

    const match = trimmed.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.*)$/);
    if (match) {
      results.push({
        label: match[1].trim(),
        fileRef: match[2].trim(),
        description: match[3].trim(),
      });
    }
  }

  return results;
}

/**
 * Parses archive_resolved_incidents.md index lines:
 * e.g. "- `project_security_audit_2026_05_27.md` — redrouter/redGuard..."
 */
export function parseArchivedMemoryIndex(content: string): ParsedIndexLine[] {
  const lines = content.split(/\r?\n/);
  const results: ParsedIndexLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- `') && !trimmed.startsWith('- [')) continue;

    // Matches `- `file.md` — desc`
    const codeMatch = trimmed.match(/^-\s*`([^`]+)`\s*[—–-]\s*(.*)$/);
    if (codeMatch) {
      const fileRef = codeMatch[1].trim();
      const label = fileRef.replace(/\.md$/, '').replace(/_/g, ' ');
      results.push({
        label,
        fileRef,
        description: codeMatch[2].trim(),
      });
      continue;
    }

    // Matches `- [label](file.md) — desc`
    const linkMatch = trimmed.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.*)$/);
    if (linkMatch) {
      results.push({
        label: linkMatch[1].trim(),
        fileRef: linkMatch[2].trim(),
        description: linkMatch[3].trim(),
      });
    }
  }

  return results;
}

/**
 * Formats a resident index line calibrated to <= 120 chars.
 * Format: `[fleet] [bucket] label (fileRef) — description [dormant]`
 */
export function formatResidentIndexLine(
  label: string,
  fileRef: string,
  bucket: FleetBucket,
  desc: string,
  modifiedAt?: string | null,
): string {
  const dateStr = modifiedAt ? modifiedAt.slice(0, 10) : 'dormant';
  const prefix = `[fleet] [${bucket}] ${label} (${fileRef}) — `;
  const suffix = ` [${dateStr}]`;

  const availableChars = MAX_INDEX_LINE_CHARS - prefix.length - suffix.length;
  if (availableChars <= 0) {
    // Ultra-compact fallback
    const compact = `[fleet] ${label} (${fileRef}) [${dateStr}]`;
    return compact.slice(0, MAX_INDEX_LINE_CHARS);
  }

  const cleanDesc = desc.slice(0, availableChars);
  return `${prefix}${cleanDesc}${suffix}`;
}

/**
 * Pure projection builder from in-memory inputs (testable without disk I/O).
 */
export function buildFleetProjection(inputs: {
  memoryMdContent: string;
  archiveMdContent: string;
  topicFiles: Array<{
    filename: string;
    content: string;
    sizeBytes: number;
  }>;
}): FleetProjectionReport {
  const activeEntries = parseActiveMemoryIndex(inputs.memoryMdContent);
  const archivedEntries = parseArchivedMemoryIndex(inputs.archiveMdContent);

  const activeRefs = new Map<string, ParsedIndexLine>();
  for (const e of activeEntries) activeRefs.set(e.fileRef, e);

  const archivedRefs = new Map<string, ParsedIndexLine>();
  for (const e of archivedEntries) archivedRefs.set(e.fileRef, e);

  const pointers: FleetMemoryPointer[] = [];
  const orphanFiles: OrphanFileSummary[] = [];

  const bucketCounts = {
    reference: 0,
    project: 0,
    feedback: 0,
    other: 0,
  };

  const residentIndexLines: string[] = [];

  for (const file of inputs.topicFiles) {
    const filename = file.filename;
    // Skip index files themselves
    if (filename === 'MEMORY.md' || filename.startsWith('archive_') || filename.startsWith('.')) {
      continue;
    }

    const meta = extractFrontmatter(file.content);
    const isActive = activeRefs.has(filename);
    const isArchived = archivedRefs.has(filename);
    const isOrphan = !isActive && !isArchived;

    if (isOrphan) {
      orphanFiles.push({
        fileRef: filename,
        sizeBytes: file.sizeBytes,
        modifiedAt: meta.modified || null,
      });
    }

    // Resolve bucket vocabulary: reference, project, feedback
    let bucket: FleetBucket = 'reference';
    const declaredType = (meta.type || '').toLowerCase();
    if (declaredType === 'project' || filename.startsWith('project_')) {
      bucket = 'project';
    } else if (declaredType === 'feedback' || filename.startsWith('feedback_')) {
      bucket = 'feedback';
    } else if (declaredType === 'reference' || filename.startsWith('reference_')) {
      bucket = 'reference';
    } else {
      bucket = 'reference';
    }

    bucketCounts[bucket]++;

    const tier: FleetTier = isArchived ? 'archived' : 'active';
    const activeEntry = activeRefs.get(filename);
    const archivedEntry = archivedRefs.get(filename);

    const label = activeEntry?.label || archivedEntry?.label || meta.name || filename.replace(/\.md$/, '').replace(/_/g, ' ');
    const rawDesc = activeEntry?.description || archivedEntry?.description || meta.description || 'Fleet memory pointer';
    const modifiedAt = meta.modified || null;

    const dormancyMarker = `[fleet-pointer | dormant: file tier may not reflect live state; modified ${modifiedAt || 'unknown'}]`;

    const indexLine = formatResidentIndexLine(label, filename, bucket, rawDesc, modifiedAt);

    // Only active (non-archived, non-orphan) entries populate the resident Tier-1 index
    if (isActive && !isArchived) {
      residentIndexLines.push(indexLine);
    }

    pointers.push({
      id: `fleet:${filename.replace(/\.md$/, '')}`,
      label,
      fileRef: filename,
      bucket,
      tier,
      description: rawDesc.slice(0, 120),
      dormancyMarker,
      modifiedAt,
      originSessionId: meta.originSessionId || null,
      isOrphan,
      residentIndexLine: indexLine,
      scope: 'fleet',
    });
  }

  return {
    timestamp: new Date().toISOString(),
    totalFilesScanned: inputs.topicFiles.length,
    activeIndexedCount: activeEntries.length,
    archivedIndexedCount: archivedEntries.length,
    orphanCount: orphanFiles.length,
    orphanFiles,
    bucketDistribution: bucketCounts,
    pointers,
    dormancyNotice: DORMANCY_NOTICE,
    residentIndexLines,
  };
}
