/**
 * SSH key-path allowlist — shared guard for native SSH tools.
 *
 * Both `ssh_shell` and `ssh_copy` historically took a caller-supplied
 * `sshKeyPath`, did a bare `sshKeyPath.replace(/^~/, os.homedir())`, and
 * `fs.readFileSync`'d the result. Because the path comes from graph input,
 * that was an arbitrary-file-read primitive on the worker host: any caller
 * could read `/etc/passwd`, another tenant's key, `/home/alpha/s`, etc.
 *
 * `readAllowlistedSshKey()` is the single choke point that replaces those
 * inline reads. It reads the key bytes ONLY when the resolved, symlink-followed
 * target is a regular file that lives inside one of the operator-configured
 * allowlisted directories. Everything else throws a clear `Error` that the
 * calling tool surfaces through its normal error path.
 *
 * Allowlist source: the `SSH_KEY_PATH_ALLOWED_DIRS` env var — a comma-separated
 * list of absolute directories (`~` expanded per entry). It is read at CALL
 * TIME (not module load) so operators can change it without a restart and tests
 * can set it per case.
 *
 * Default-deny: if the var is unset, empty, or every entry is unusable (not
 * absolute, missing, or not a directory), EVERY `sshKeyPath` read is refused.
 * The preferred way to supply a key is inline `sshKey` content sourced from
 * `_secrets` — that path never touches this guard.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Env var naming the allowlisted directories. Exported so callers/tests can reference the exact name. */
export const SSH_KEY_PATH_ALLOWLIST_ENV = 'SSH_KEY_PATH_ALLOWED_DIRS';

/**
 * Expand a leading `~` to the current user's home directory. Matches the
 * historical `str.replace(/^~/, os.homedir())` behavior so existing configured
 * paths resolve identically.
 */
function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~')) return os.homedir() + p.slice(1);
  return p;
}

/**
 * Parse `SSH_KEY_PATH_ALLOWED_DIRS` into a list of real (symlink-followed),
 * absolute directory paths. Entries that are relative, missing, or not
 * directories are dropped — a misconfigured entry never silently widens access.
 */
function loadAllowedRealDirs(): string[] {
  const raw = process.env[SSH_KEY_PATH_ALLOWLIST_ENV];
  if (!raw || !raw.trim()) return [];

  const dirs: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const expanded = expandTilde(trimmed);
    if (!path.isAbsolute(expanded)) continue; // allowlist entries must be absolute
    try {
      const real = fs.realpathSync(path.resolve(expanded));
      if (fs.statSync(real).isDirectory()) dirs.push(real);
    } catch {
      // Missing / unreadable entry — skip it (default-deny).
    }
  }
  return dirs;
}

/**
 * `true` when `realCandidate` sits inside `realDir` with path-segment
 * awareness: `/allowed-other/key` is NOT inside `/allowed`, and no `..`
 * segment may escape. Both arguments must already be realpath'd absolutes.
 */
function isContainedIn(realDir: string, realCandidate: string): boolean {
  const rel = path.relative(realDir, realCandidate);
  return (
    rel.length > 0 &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel)
  );
}

/**
 * Resolve a caller-supplied `sshKeyPath` against the operator allowlist and
 * return the key file's bytes. Throws a descriptive `Error` when the path is
 * not permitted, so no key material is read outside the allowlist.
 *
 * Rules enforced (in order):
 *  1. Default-deny when the allowlist is unset/empty/all-unusable.
 *  2. The target is realpath'd (symlinks followed) before any check, so a
 *     symlink inside an allowed directory cannot point outside it.
 *  3. The realpath'd target must be a regular file (no directories, devices,
 *     FIFOs, or sockets).
 *  4. The realpath'd target must be contained (segment-aware) in an allowed dir.
 */
export function readAllowlistedSshKey(rawPath: string): Buffer {
  const allowedDirs = loadAllowedRealDirs();
  if (allowedDirs.length === 0) {
    throw new Error(
      `sshKeyPath is disabled: no usable directories in ${SSH_KEY_PATH_ALLOWLIST_ENV}. ` +
      `Set ${SSH_KEY_PATH_ALLOWLIST_ENV} to a comma-separated list of absolute directories the ` +
      `worker may read SSH keys from, or pass the key content inline via 'sshKey' (from _secrets).`,
    );
  }

  const requested = path.resolve(expandTilde(rawPath));

  // realpath both the candidate and (already, above) each allowed dir so a
  // symlink inside an allowed directory cannot smuggle a target outside it.
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(requested);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot resolve SSH key path '${rawPath}': ${msg}`);
  }

  if (!fs.statSync(realCandidate).isFile()) {
    throw new Error(`SSH key path '${rawPath}' is not a regular file`);
  }

  const permitted = allowedDirs.some((dir) => isContainedIn(dir, realCandidate));
  if (!permitted) {
    throw new Error(
      `SSH key path '${rawPath}' resolves to '${realCandidate}', which is outside the ` +
      `directories allowed by ${SSH_KEY_PATH_ALLOWLIST_ENV}.`,
    );
  }

  return fs.readFileSync(realCandidate);
}
