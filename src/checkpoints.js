/**
 * The checkpoint store: capture, list, diff and rollback over `.guardrail/`.
 *
 * "Intelligent" is four concrete behaviours, not a slogan:
 *
 * 1. content-addressed deduplication -- identical bytes are stored once;
 * 2. change-only capture -- a blob is written only when it is new, and only
 *    when it differs from the previous checkpoint's value at that path;
 * 3. scope awareness -- vendor, build and cache directories are never walked;
 * 4. coalescing -- a capture that changes nothing produces no new checkpoint.
 *
 * Rollback restores a checkpoint's files and removes files that appeared after
 * it, so the workspace returns to the captured state rather than merely
 * overwriting some of it.
 */

import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BlobStore, hashContent } from "./store.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  diffSnapshots,
  resolveInside,
  snapshot,
  walkFiles,
} from "./snapshot.js";

export class CheckpointStore {
  /**
   * @param {string} root - the workspace being tracked.
   * @param {string} [directory] - where the checkpoint data lives, relative to root.
   * @param {{ ignore?: string[], maxBytes?: number }} [options]
   *   `ignore` is glob patterns against the workspace-relative path. A workspace
   *   containing a vendored toolchain -- a portable git, a downloaded SDK -- will
   *   otherwise have every one of its binaries copied into the store by the first
   *   capture.
   */
  constructor(root, directory = ".guardrail", options = {}) {
    this.root = root;
    this.directory = join(root, directory);
    this.indexPath = join(this.directory, "checkpoints.json");
    this.blobs = new BlobStore(join(this.directory, "blobs"));
    this.ignore = options.ignore ?? [];
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /** @returns {Promise<Array<Object>>} */
  async loadIndex() {
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** @param {Array<Object>} index */
  async saveIndex(index) {
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf8");
  }

  /**
   * Capture the current state as a checkpoint.
   * @param {{ turn?: string | number | null, reason?: string }} [meta]
   * @returns {Promise<{ id: string, noop: boolean, changes: object, stored: number }>}
   */
  async capture(meta = {}) {
    const index = await this.loadIndex();
    const previous = index[index.length - 1];
    const previousFiles = previous?.files ?? {};

    const files = await walkFiles(this.root, {
      ignore: this.ignore,
      maxBytes: this.maxBytes,
    });
    const previousStats = previous?.stats ?? {};
    const manifest = {};
    const stats = {};
    let stored = 0;
    let reused = 0;

    for (const file of files) {
      const stamp = `${file.mtimeMs}:${file.size}`;
      stats[file.path] = stamp;
      const priorHash = previousFiles[file.path];

      // Fast path: this path has the same size and mtime as it did at the last
      // checkpoint, so its content cannot have changed and re-reading it would
      // buy nothing. Without this, every capture re-reads the entire workspace.
      if (priorHash !== undefined && previousStats[file.path] === stamp) {
        manifest[file.path] = priorHash;
        reused += 1;
        continue;
      }

      const content = await readFile(file.full);
      const hash = hashContent(content);
      manifest[file.path] = hash;

      // Only write blobs that are genuinely new: unchanged from the previous
      // checkpoint, or already present in the store.
      if (priorHash === hash) continue;
      if (await this.blobs.has(hash)) continue;
      await this.blobs.put(content);
      stored += 1;
    }

    const changes = diffSnapshots(
      new Map(Object.entries(previousFiles)),
      new Map(Object.entries(manifest)),
    );

    const changed = changes.added.length + changes.removed.length + changes.changed.length;
    if (previous && changed === 0) {
      return { id: previous.id, noop: true, changes, stored: 0, reused };
    }

    const checkpoint = {
      id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      turn: meta.turn ?? null,
      reason: meta.reason ?? "",
      files: manifest,
      // Size and mtime per path, so the next capture can skip re-reading
      // anything that has not changed. Kept beside `files` rather than inside
      // it so a manifest stays a plain path-to-hash map.
      stats,
    };
    index.push(checkpoint);
    await this.saveIndex(index);
    return { id: checkpoint.id, noop: false, changes, stored, reused };
  }

  /** @returns {Promise<Array<Object>>} */
  async list() {
    const index = await this.loadIndex();
    return index.map((checkpoint) => ({
      id: checkpoint.id,
      createdAt: checkpoint.createdAt,
      turn: checkpoint.turn,
      reason: checkpoint.reason,
      files: Object.keys(checkpoint.files ?? {}).length,
    }));
  }

  /**
   * Diff a checkpoint against the live workspace.
   * @param {string} id
   */
  async diff(id) {
    const index = await this.loadIndex();
    const checkpoint = index.find((entry) => entry.id === id);
    if (!checkpoint) throw new Error(`unknown checkpoint: ${id}`);
    // Scoped exactly like the capture. Without the same ignore list every
    // ignored path reports as "added", which is both a wrong diff and the
    // precondition for a rollback that deletes them.
    const live = await snapshot(this.root, {
      ignore: this.ignore,
      maxBytes: this.maxBytes,
    });
    return diffSnapshots(new Map(Object.entries(checkpoint.files)), live);
  }

  /**
   * Restore the workspace to a checkpoint's state.
   *
   * Paths come from the manifest, which is produced by walkFiles and therefore
   * always a relative path under the root; resolveInside is re-checked anyway,
   * because a tampered index on disk is exactly the input a guard should not
   * trust.
   *
   * @param {string} id
   * @param {{ removeAdded?: boolean }} [options]
   * @returns {Promise<{ restored: string[], removed: string[] }>}
   */
  async rollback(id, options = {}) {
    const removeAdded = options.removeAdded ?? true;
    const index = await this.loadIndex();
    const checkpoint = index.find((entry) => entry.id === id);
    if (!checkpoint) throw new Error(`unknown checkpoint: ${id}`);

    const restored = [];
    for (const [path, hash] of Object.entries(checkpoint.files)) {
      const target = await resolveInside(this.root, path);
      if (target === null) throw new Error(`refusing to restore outside the workspace: ${path}`);
      const content = await this.blobs.read(hash);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      restored.push(path);
    }

    const removed = [];
    if (removeAdded) {
      // Scoped exactly like the capture. Walking the whole tree here would treat
      // every ignored path as "appeared after the checkpoint" and delete it --
      // which, for a workspace holding a vendored toolchain, means deleting the
      // toolchain.
      const live = await walkFiles(this.root, {
        ignore: this.ignore,
        maxBytes: this.maxBytes,
      });
      for (const file of live) {
        if (checkpoint.files[file.path] !== undefined) continue;
        await unlink(file.full);
        removed.push(file.path);
      }
    }

    return { restored, removed };
  }
}
