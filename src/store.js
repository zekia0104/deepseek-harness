/**
 * A content-addressed blob store.
 *
 * Every blob is stored under `blobs/<first-two>/<rest>` keyed by its SHA-256.
 * Two consequences follow, and both are load-bearing for the rest of the
 * project:
 *
 * 1. Identical content is stored exactly once, however many checkpoints and
 *    however many paths reference it. An agent that edits a file, reverts it,
 *    and edits it again costs the storage of the two versions that existed,
 *    not of every intermediate copy.
 * 2. A path can be restored by copying one blob, with no manifest walk. That is
 *    what makes rollback "instant" rather than "replay a log of edits".
 */

import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** @param {string | Buffer} content */
export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

export class BlobStore {
  /** @param {string} root - directory that will hold the blobs. */
  constructor(root) {
    this.root = root;
  }

  /** @param {string} hash */
  _path(hash) {
    return join(this.root, hash.slice(0, 2), hash.slice(2));
  }

  /**
   * Store content and return its hash. A no-op when the hash already exists,
   * so callers never need to deduplicate themselves.
   * @param {string | Buffer} content
   * @returns {Promise<string>}
   */
  async put(content) {
    const hash = hashContent(content);
    const target = this._path(hash);
    try {
      await access(target);
    } catch {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return hash;
  }

  /** @param {string} hash */
  async has(hash) {
    try {
      await access(this._path(hash));
      return true;
    } catch {
      return false;
    }
  }

  /** @param {string} hash */
  async read(hash) {
    return readFile(this._path(hash));
  }
}
