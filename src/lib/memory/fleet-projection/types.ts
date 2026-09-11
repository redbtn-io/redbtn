/**
 * Types for the Fleet Projection System (Card 6aa1d9d708971669b4a25d25).
 *
 * One-way disk-to-platform projection producing scope: 'fleet' pointer memories
 * carrying path, type, and modification dates — never copied bodies.
 *
 * @module lib/memory/fleet-projection/types
 */

export type FleetBucket = 'reference' | 'project' | 'feedback';

export type FleetTier = 'active' | 'archived';

export interface FleetTopicFileMetadata {
  name?: string;
  description?: string;
  type?: FleetBucket | string;
  modified?: string | null;
  originSessionId?: string | null;
}

export interface FleetMemoryPointer {
  /** Unique deterministic identifier, e.g. fleet:reference_home_assistant */
  id: string;
  /** Human-readable title or label */
  label: string;
  /** Relative filename in memory/ directory, e.g. reference_home_assistant.md */
  fileRef: string;
  /** High-level bucket vocabulary (reference, project, feedback) */
  bucket: FleetBucket;
  /** Active (in MEMORY.md) vs Archived (in archive_resolved_incidents.md) */
  tier: FleetTier;
  /** Calibrated short description, <= 120 chars */
  description: string;
  /** Explicit dormancy marker warning that file tier may not reflect live state */
  dormancyMarker: string;
  /** ISO 8601 modification timestamp if available */
  modifiedAt: string | null;
  /** Originating session ID if recorded in YAML frontmatter */
  originSessionId: string | null;
  /** Whether the file is an orphan (missing from both primary and archive indexes) */
  isOrphan: boolean;
  /** Single resident index line formatted for Tier-1 resident context, <= 120 chars */
  residentIndexLine: string;
  /** Memory scope: strictly 'fleet' */
  scope: 'fleet';
}

export interface OrphanFileSummary {
  fileRef: string;
  sizeBytes: number;
  modifiedAt: string | null;
}

export interface FleetProjectionReport {
  timestamp: string;
  /** Total .md topic files scanned in memory/ */
  totalFilesScanned: number;
  /** Files indexed in active MEMORY.md */
  activeIndexedCount: number;
  /** Files indexed in archive_resolved_incidents.md */
  archivedIndexedCount: number;
  /** Orphan files reachable from neither index */
  orphanCount: number;
  orphanFiles: OrphanFileSummary[];
  /** Breakdown by bucket */
  bucketDistribution: {
    reference: number;
    project: number;
    feedback: number;
    other: number;
  };
  /** Generated pointer memories (zero file bodies copied) */
  pointers: FleetMemoryPointer[];
  /** Dormancy warning statement */
  dormancyNotice: string;
  /** Calibrated resident index lines (max 120 chars each) */
  residentIndexLines: string[];
}
