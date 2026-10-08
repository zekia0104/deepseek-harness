/**
 * Directory walking and snapshots.
 *
 * A snapshot is a `Map(path -> sha256)` over the files under a root, where
 * `path` is relative and forward-slash separated. It is cheap to diff two
 * snapshots because a changed file is a changed hash, with no content
 * comparison on the diff path.
 *
 * Walking has to be conservative in exactly one direction: it may skip more
 * than strictly necessary, but it must never follow a path outside the root or
 * a symlink. Reading the wrong files is worse than storing one checkpoint less.
 */

import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { matchGlob } from "./glob.js";
import { hashContent } from "./store.js";

/** Directories that are never worth checkpointing. */
export const DEFAULT_IGNORE_DIRS = new Set([
  ".git", ".hg", ".svn",
  "node_modules", "__pycache__",
  ".venv", "venv", "env",
  ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".guardrail", ".tmp",
  "dist", "build", "coverage",
]);

/** Files that are never worth checkpointing. */
export const DEFAULT_IGNORE_NAMES = [".DS_Store", "Thumbs.db", "*.pyc"];

/** Files larger than this are not captured; they are almost always generated. */
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * @typedef {Object} WalkOptions
 * @property {Set<string>} [ignoreDirs]
 * @property {string[]} [ignoreNames]
 * @property {string[]} [ignore] - glob patterns against the relative path.
 * @property {number} [maxBytes]
 */

/**
 * Walk the regular files under `root`, returning `{path, full, size}` entries.
 * Symlinks are skipped (never followed), and every path is confirmed to still
 * resolve inside the root.
 * @param {string} root
 * @param {WalkOptions} [options]
 * @returns {Promise<Array<{path: string, full: string, size: number}>>}
 */
export async function walkFiles(root, options = {}) {
  const {
    ignoreDirs = DEFAULT_IGNORE_DIRS,
    ignoreNames = DEFAULT_IGNORE_NAMES,
    ignore = [],
    maxBytes = DEFAULT_MAX_FILE_BYTES,
  } = options;

  const base = resolve(root);
  const out = [];

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // An unreadable directory must not fail the whole walk. One permission
      // denial anywhere in a workspace would otherwise mean no checkpoint is
      // ever captured, which is worse than capturing most of one.
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const rel = relative(base, full).split(sep).join("/");

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        if (ignore.some((pattern) => matchGlob(rel, pattern))) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      if (ignoreNames.includes(entry.name)) continue;
      if (ignore.some((pattern) => matchGlob(rel, pattern))) continue;

      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.size > maxBytes) continue;

      // mtimeMs is carried out so a caller can skip re-reading a file that has
      // not changed since the last checkpoint. Hashing a workspace that holds a
      // vendored toolchain on every tool call is the difference between instant
      // and unusable.
      out.push({ path: rel, full, size: info.size, mtimeMs: Math.round(info.mtimeMs) });
    }
  }

  await walk(base);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Hash every file under `root` into a `Map(path -> hash)`.
 * @param {string} root
 * @param {WalkOptions} [options]
 * @returns {Promise<Map<string, string>>}
 */
export async function snapshot(root, options = {}) {
  const manifest = new Map();
  for (const file of await walkFiles(root, options)) {
    const content = await readFile(file.full);
    manifest.set(file.path, hashContent(content));
  }
  return manifest;
}

/**
 * The difference between two snapshots.
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 */
export function diffSnapshots(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) added.push(path);
    else if (before.get(path) !== hash) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) removed.push(path);
  }
  return { added, removed, changed };
}

/**
 * Resolve a workspace-relative path and confirm it stays inside the root.
 * Returns null when it does not, which is the guard the whole rollback path
 * relies on: a tampered manifest must not be able to write anywhere arbitrary.
 * @param {string} root
 * @param {string} relativePath
 * @returns {Promise<string | null>}
 */
export async function resolveInside(root, relativePath) {
  const target = resolve(root, relativePath);
  const base = resolve(root);
  if (target === base || !target.startsWith(base + sep)) return null;
  try {
    const real = await realpath(base);
    if (!target.startsWith(real + sep)) return null;
  } catch {
    // The root may not exist yet; the lexical check above still applies.
  }
  return target;
}
