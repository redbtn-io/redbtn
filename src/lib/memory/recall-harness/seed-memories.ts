/**
 * 20 Seeded Memories for the redMem RAG Recall Harness.
 *
 * Covers all 7 domains: personal, work, health, home, financial, projects, reference.
 * Includes active facts, historically superseded facts, and expired/scheduled entries.
 */
import { MemoryFact } from './types';

export const SEEDED_MEMORIES: MemoryFact[] = [
  {
    id: 'mem-01',
    domain: 'personal',
    title: 'Identity & Contacts',
    content: 'George Abreu is the founder and owner of redbtn (redbtn-io). Primary email: george@redbtn.io, personal: george8794@gmail.com.',
    observedAt: '2026-06-02T12:00:00.000Z',
    status: 'active',
    tags: ['identity', 'owner', 'email', 'contact'],
  },
  {
    id: 'mem-02',
    domain: 'work',
    title: 'WireGuard Mesh Architecture',
    content: 'Fleet WireGuard mesh CIDR is 10.100.0.0/24 with 11 nodes. Main nodes use UDP port 51820; Pis use 51821. Peer config in wg0.conf.',
    observedAt: '2026-06-02T12:00:00.000Z',
    status: 'active',
    tags: ['network', 'wireguard', 'vpn', 'mesh'],
  },
  {
    id: 'mem-03',
    domain: 'work',
    title: 'alphaServer Infrastructure',
    content: 'alphaServer (.10 / 10.100.0.10) hosts single-node MongoDB rs0 on port 27017, MinIO S3 on 9000, and edge router redrouter-proxy.',
    observedAt: '2026-06-02T12:00:00.000Z',
    status: 'active',
    tags: ['infra', 'alphaserver', 'mongodb', 'minio', 'router'],
  },
  {
    id: 'mem-04',
    domain: 'work',
    title: 'redServer Production Storage',
    content: 'redServer (.3 / 10.100.0.3) hosts standalone Redis Master on port 6379 (0 replicas) and production ChromaDB on port 8024.',
    observedAt: '2026-09-06T18:00:00.000Z',
    status: 'active',
    tags: ['infra', 'redserver', 'redis', 'chromadb'],
  },
  {
    id: 'mem-05',
    domain: 'work',
    title: 'alphaSystem Primary Compute',
    content: 'alphaSystem (.11 / 10.100.0.1) is the primary compute box (16c / 23GB RAM / 1TB SSD, Ubuntu 24.04). SSH connects on port 2222.',
    observedAt: '2026-06-02T12:00:00.000Z',
    status: 'active',
    tags: ['infra', 'alphasystem', 'compute', 'ssh'],
  },
  {
    id: 'mem-06',
    domain: 'financial',
    title: 'Nightly Database Backups & Infrastructure Budget',
    content: 'Nightly MongoDB backup runs via cron on alphaServer at 03:30 UTC (~/bin/mongo-nightly-backup.sh), rsyncing dumps to redServer. Monthly cloud infrastructure hosting budget is capped at $25.00/month.',
    observedAt: '2026-06-02T12:00:00.000Z',
    status: 'active',
    tags: ['backup', 'cron', 'mongodb', 'rsync', 'financial', 'budget', 'hosting'],
  },
  {
    id: 'mem-07',
    domain: 'work',
    title: 'Nightly Dream Consolidator',
    content: 'Nightly Dream Consolidator runs at 03:00 ET (07:00 UTC) via cron 0 7 * * *, gated on 24 hours and >=5 turn-bearing sessions.',
    observedAt: '2026-09-10T04:00:00.000Z',
    status: 'active',
    tags: ['dream', 'memory', 'cron', 'consolidation'],
  },
  {
    id: 'mem-08',
    domain: 'work',
    title: 'RedRun Application Deployment',
    content: 'RedRun web apps deploy across workers .3, .5, .7, and .8 on Traefik proxy network with entrypoints web (:80) and websecure (:443).',
    observedAt: '2026-06-02T12:00:00.000Z',
    status: 'active',
    tags: ['redrun', 'deploy', 'traefik', 'ports'],
  },
  {
    id: 'mem-09',
    domain: 'health',
    title: 'Strength Training Program',
    content: "George's current fitness program is 4 hypertrophy strength workouts per week with a minimum 160g daily protein target.",
    observedAt: '2026-08-20T10:00:00.000Z',
    status: 'active',
    tags: ['fitness', 'workout', 'protein', 'nutrition'],
  },
  {
    id: 'mem-10',
    domain: 'health',
    title: 'Sleep Target & Schedule',
    content: "George's sleep goal is 8 hours per night, with evening digital wind-down starting at 22:30.",
    observedAt: '2026-08-25T21:00:00.000Z',
    status: 'active',
    tags: ['health', 'sleep', 'routine'],
  },
  {
    id: 'mem-11',
    domain: 'work',
    title: 'Voice Stream Runtime sW2uaL6y0Ngn',
    content: 'Voice Stream runtime sW2uaL6y0Ngn uses LiveKit SFU on alphaServer (ports 7880, UDP 7881) and connects to Gemini Live API.',
    observedAt: '2026-09-08T15:00:00.000Z',
    status: 'active',
    tags: ['voice', 'stream', 'livekit', 'gemini'],
  },
  {
    id: 'mem-12',
    domain: 'projects',
    title: 'Private NPM Package Registry',
    content: 'Private package registry is hosted at registry.redbtn.io (Verdaccio) on port 4873, hosting @redbtn/* packages with ci-runner auth.',
    observedAt: '2026-06-02T12:00:00.000Z',
    status: 'active',
    tags: ['npm', 'registry', 'verdaccio', 'packages'],
  },
  {
    id: 'mem-13',
    domain: 'projects',
    title: 'Become Fitness PWA',
    content: 'Become fitness coaching webapp is hosted at become.redbtn.io and utilizes MongoDB database become and Auth0/redauth session.',
    observedAt: '2026-08-27T14:00:00.000Z',
    status: 'active',
    tags: ['become', 'pwa', 'fitness', 'mongodb'],
  },
  {
    id: 'mem-14',
    domain: 'personal',
    title: 'Denver Travel Flight Itinerary',
    content: 'Flight to Denver is booked for September 14, 2026 at 19:00 EDT (flight AC842), returning September 21, 2026 at 14:30 EDT.',
    observedAt: '2026-09-01T16:00:00.000Z',
    status: 'active',
    validUntil: '2026-09-22T00:00:00.000Z',
    tags: ['travel', 'flight', 'denver', 'itinerary'],
  },
  {
    id: 'mem-15',
    domain: 'reference',
    title: 'Standing Directive',
    content: 'Current Standing Directive: Red button is the only intended site navigation by design. Fix issues proactively; skip verbose play-by-play.',
    observedAt: '2026-06-02T12:00:00.000Z',
    status: 'active',
    tags: ['directive', 'navigation', 'rules'],
  },
  {
    id: 'mem-16',
    domain: 'work',
    title: 'Legacy Redis on alphaServer (Superseded)',
    content: 'Historical: Redis previously ran on alphaServer .10; migrated to redServer .3 on 2026-09-06. The .10 container is stopped/retired.',
    observedAt: '2026-09-06T17:00:00.000Z',
    status: 'superseded',
    supersededBy: 'mem-04',
    tags: ['redis', 'migration', 'superseded'],
  },
  {
    id: 'mem-17',
    domain: 'work',
    title: 'Legacy MongoDB Replica Set (Superseded)',
    content: 'Historical: MongoDB rs0 was previously a 3-member replica set; reduced to single-node on 2026-05-13 following WiredTigerHS bloat.',
    observedAt: '2026-05-13T12:00:00.000Z',
    status: 'superseded',
    supersededBy: 'mem-03',
    tags: ['mongodb', 'replica', 'superseded'],
  },
  {
    id: 'mem-18',
    domain: 'home',
    title: 'HVAC Air Filter Replacement (Expired)',
    content: 'Chore: replace HVAC air filters in server room was scheduled for 2026-09-05. Now past due / expired, awaiting dream pruning.',
    observedAt: '2026-08-30T10:00:00.000Z',
    status: 'expired',
    validUntil: '2026-09-05T23:59:59.000Z',
    tags: ['chore', 'hvac', 'expired', 'scheduled'],
  },
  {
    id: 'mem-19',
    domain: 'reference',
    title: 'immich Service Status',
    content: 'immich service on alphaServer .10 was intentionally disabled on 2026-05-19 with docker volumes preserved; do not restart without asking.',
    observedAt: '2026-05-19T12:00:00.000Z',
    status: 'active',
    tags: ['immich', 'disabled', 'service', 'volumes'],
  },
  {
    id: 'mem-20',
    domain: 'reference',
    title: 'Specialist Proposer Security & RedBoard Scope',
    content: 'Specialist capability profile strictly denies write access to Red_Memory and red-memory*; specialists propose only into Red_Memory_Inbox. Red is an active member of 9 of 15 registered RedBoard boards.',
    observedAt: '2026-09-10T02:00:00.000Z',
    status: 'active',
    tags: ['specialist', 'inbox', 'permissions', 'redboard', 'boards', 'scope'],
  },
];

/**
 * Builds the compact resident index string representing Red_Memory/index.
 * Adheres strictly to caps: <=64 lines, <=120 chars per line, <=6,000 characters.
 */
export function buildResidentIndex(memories: MemoryFact[] = SEEDED_MEMORIES): string {
  const lines: string[] = ['# redMem Resident Index [Curated Live Facts]'];
  for (const m of memories) {
    if (m.status === 'active') {
      const summary = `${m.domain.toUpperCase()}: ${m.title} - ${m.content}`;
      const line = summary.length > 120 ? summary.slice(0, 117) + '...' : summary;
      lines.push(line);
    } else if (m.status === 'superseded') {
      const line = `HISTORICAL: ${m.title} (superseded)`;
      lines.push(line.slice(0, 120));
    } else if (m.status === 'expired') {
      const line = `EXPIRED: ${m.title} (passed ${m.validUntil?.slice(0, 10)})`;
      lines.push(line.slice(0, 120));
    }
  }
  return lines.join('\n');
}
