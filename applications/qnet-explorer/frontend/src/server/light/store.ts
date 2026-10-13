// Where the light client keeps the checkpoints it verified, so a restart resumes at the head instead of walking up from
// the pin again (thousands of steps, and none at all once the nodes have dropped the old committee signatures). Only
// the site's own process writes it, with checkpoints it verified itself; lineage.ts binds them to the pin they were
// walked from and checks every field again when it reads them. It also keeps the GALC v2 capsule the site holds
// (galc.ts), which lineage.ts verifies again, signatures and roots, when it reads it. A local file, mode 600, under the
// site's directory: a database table would let anyone with write access to the explorer database plant a checkpoint
// the site then trusts.
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CapsuleRecord } from './galc.ts';

/** The pin a lineage was walked from: its index and MacroBlock::hash (or the digest of its anchors). */
export interface PinRef { index: number; id: string }
/** `checkpointHash`: Checkpoint::hash of the checkpoint verified, when known (a store written before it has none). */
export interface StoredCheckpoint { index: number; stateRoot: string; eligibleRaw: string; beacon: string; registryRoot: string; checkpointHash?: string }
/** `capsule`: the capsule held when the lineage was saved; absent when none was. */
export interface StoredLineage { pin: PinRef; checkpoints: StoredCheckpoint[]; capsule?: CapsuleRecord }

export interface CheckpointStore {
  /** What the store names itself in a log line. */
  readonly name: string;
  /** The stored lineage, or null when there is none or it cannot be read. */
  load(): Promise<StoredLineage | null>;
  save(lineage: StoredLineage): Promise<void>;
}

// The capsule and the checkpoint hashes are optional fields of format 1: a reader from before them passes them over.
export const STORE_FORMAT = 1;
// A file larger than this is not a store this code wrote: it is not read.
const STORE_MAX_BYTES = 64 * 1024 * 1024;
const STORE_MAX_CHECKPOINTS = 1024;

/** The default file: LIGHT_STORE_FILE, else data/light-checkpoints.json in the site's directory. */
export function defaultStorePath(): string {
  return process.env.LIGHT_STORE_FILE || join(process.cwd(), 'data', 'light-checkpoints.json');
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The stored shape read back, field types only (lineage.ts checks the values); null when it is not that shape. A capsule
 * field without a record's shape is left out, never the checkpoints with it.
 */
export function parseStoredLineage(text: string): StoredLineage | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObject(v) || v.format !== STORE_FORMAT || !isObject(v.pin) || !Array.isArray(v.checkpoints)) return null;
  const { index, id } = v.pin;
  if (!Number.isSafeInteger(index) || typeof id !== 'string') return null;
  if (v.checkpoints.length > STORE_MAX_CHECKPOINTS) return null;
  const checkpoints: StoredCheckpoint[] = [];
  for (const c of v.checkpoints) {
    if (!isObject(c) || !Number.isSafeInteger(c.index)) return null;
    const fields = [c.state_root, c.eligible_raw, c.beacon, c.registry_root];
    if (!fields.every((f) => typeof f === 'string')) return null;
    if (c.checkpoint_hash !== undefined && typeof c.checkpoint_hash !== 'string') return null;
    const checkpoint: StoredCheckpoint = { index: c.index as number, stateRoot: c.state_root as string, eligibleRaw: c.eligible_raw as string,
      beacon: c.beacon as string, registryRoot: c.registry_root as string };
    if (typeof c.checkpoint_hash === 'string') checkpoint.checkpointHash = c.checkpoint_hash;
    checkpoints.push(checkpoint);
  }
  const lineage: StoredLineage = { pin: { index: index as number, id }, checkpoints };
  const capsule = v.capsule;
  if (isObject(capsule) && isObject(capsule.capsule) && isObject(capsule.roots)) lineage.capsule = capsule as unknown as CapsuleRecord;
  return lineage;
}

export function formatStoredLineage(lineage: StoredLineage): string {
  return `${JSON.stringify({
    format: STORE_FORMAT,
    pin: lineage.pin,
    checkpoints: lineage.checkpoints.map((c) => ({ index: c.index, state_root: c.stateRoot, eligible_raw: c.eligibleRaw, beacon: c.beacon,
      registry_root: c.registryRoot, ...(c.checkpointHash === undefined ? {} : { checkpoint_hash: c.checkpointHash }) })),
    ...(lineage.capsule ? { capsule: lineage.capsule } : {}),
  }, null, 1)}\n`;
}

/**
 * Why a file is not read as this site's store, or null: a link (it would read whatever it points at), not a plain
 * file, or (where modes and owners exist) owned by another user or writable by others, who could then plant a
 * checkpoint the site trusts. The file this code writes passes: mode 600, the site's user.
 */
export function storeFileProblem(st: Pick<Stats, 'isFile' | 'isSymbolicLink' | 'mode' | 'uid'>, uid: number | null): string | null {
  if (st.isSymbolicLink()) return 'symlink';
  if (!st.isFile()) return 'not_a_file';
  if (uid === null) return null;
  if (st.uid !== uid) return 'foreign_owner';
  if ((st.mode & 0o022) !== 0) return 'writable_by_others';
  return null;
}

const processUid = (): number | null => (process.platform !== 'win32' && typeof process.getuid === 'function' ? process.getuid() : null);

/** A JSON file written whole and renamed into place, so a crash or a second writer never leaves half a file. */
export function fileCheckpointStore(path: string): CheckpointStore {
  return {
    name: path,
    async load() {
      let text: string;
      try {
        // Checked on the path (a link is refused, not followed) and again on the handle read, so a file swapped in
        // between is not read either.
        const uid = processUid();
        const before = await lstat(path);
        const problem = storeFileProblem(before, uid);
        if (problem) {
          console.warn(`[WARN][LIGHT] store_refused file=${path} why=${problem}`);
          return null;
        }
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const st = await handle.stat();
          if (storeFileProblem(st, uid) || st.ino !== before.ino || st.dev !== before.dev) {
            console.warn(`[WARN][LIGHT] store_refused file=${path} why=changed_while_read`);
            return null;
          }
          if (st.size > STORE_MAX_BYTES) return null;
          text = (await handle.readFile()).toString('utf8');
        } finally {
          await handle.close();
        }
      } catch {
        return null;
      }
      const parsed = parseStoredLineage(text);
      if (!parsed) console.warn(`[WARN][LIGHT] store_unreadable file=${path}`);
      return parsed;
    },
    async save(lineage) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tmp, formatStoredLineage(lineage), { mode: 0o600 });
        await rename(tmp, path);
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
    },
  };
}

/** A store in memory (tests, and a site without a writable directory). */
export function memoryCheckpointStore(initial: StoredLineage | null = null): CheckpointStore & { content: StoredLineage | null } {
  const store = {
    name: 'memory',
    content: initial,
    async load() { return store.content ? parseStoredLineage(formatStoredLineage(store.content)) : null; },
    async save(lineage: StoredLineage) { store.content = parseStoredLineage(formatStoredLineage(lineage)); },
  };
  return store;
}
