import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { matchGlob } from "../src/glob.js";
import { BlobStore, hashContent } from "../src/store.js";
import { snapshot, diffSnapshots, walkFiles } from "../src/snapshot.js";
import { evaluate, decide, DEFAULT_RULES } from "../src/rules.js";
import { CheckpointStore } from "../src/checkpoints.js";

// A scratch root that is writable under the DSH file sandbox: the checkout is
// inside the workspace, and the system temp directory is a 0o700 mkdtemp that
// the sandbox refuses. `.tmp/` is gitignored.
const SCRATCH = join(fileURLToPath(new URL("..", import.meta.url)), ".tmp");

async function makeWorkspace() {
  const root = join(SCRATCH, `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function write(root, rel, content) {
  const target = join(root, rel);
  await mkdir(join(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  await writeFile(target, content);
}

test("glob: * stays within a segment, ** crosses", () => {
  assert.ok(matchGlob("a/b.txt", "a/*.txt"));
  assert.ok(!matchGlob("a/x/b.txt", "a/*.txt"));
  assert.ok(matchGlob("a/x/b.txt", "a/**"));
  assert.ok(matchGlob("a/b.txt", "**/*.txt"));
  assert.ok(matchGlob("b.txt", "**/*.txt"));
  assert.ok(!matchGlob("b.md", "**/*.txt"));
});

test("glob: ? matches one character", () => {
  assert.ok(matchGlob("a.txt", "a.t?t"));
  assert.ok(!matchGlob("a.txt", "a.?"));
});

test("glob: brace alternation", () => {
  assert.ok(matchGlob("deploy/id_rsa.pem", "**/*.{pem,key,p12,pfx}"));
  assert.ok(matchGlob("a.key", "**/*.{pem,key}"));
  assert.ok(!matchGlob("a.txt", "**/*.{pem,key}"));
});

test("store: identical content is stored once", async () => {
  const root = await makeWorkspace();
  const store = new BlobStore(join(root, "blobs"));
  const h1 = await store.put("hello");
  const h2 = await store.put("hello");
  assert.equal(h1, h2);
  assert.equal((await store.read(h1)).toString(), "hello");
  const count = (await walkFiles(join(root, "blobs"))).length;
  assert.equal(count, 1);
});

test("store: hash is the sha256 of the content", () => {
  const expected = createHash("sha256").update("x").digest("hex");
  assert.equal(hashContent("x"), expected);
});

test("snapshot: ignores vendor and cache directories", async () => {
  const root = await makeWorkspace();
  await write(root, "src/a.txt", "a");
  await write(root, "node_modules/x/index.js", "x");
  await write(root, ".git/config", "git");
  await write(root, ".guardrail/checkpoints.json", "{}");
  const files = await walkFiles(root);
  assert.deepEqual(files.map((f) => f.path), ["src/a.txt"]);
});

test("snapshot: honors ignore patterns and size limits", async () => {
  const root = await makeWorkspace();
  await write(root, "keep.txt", "a");
  await write(root, "generated/out.txt", "b");
  await write(root, "big.bin", "0".repeat(64));
  const files = await walkFiles(root, { ignore: ["generated/**"], maxBytes: 8 });
  assert.deepEqual(files.map((f) => f.path), ["keep.txt"]);
});

test("snapshot: never follows a symlink", async () => {
  const root = await makeWorkspace();
  await write(root, "real.txt", "real");
  const { symlink } = await import("node:fs/promises");
  try {
    await symlink(join(root, "real.txt"), join(root, "link.txt"));
  } catch {
    return; // symlinks are not permitted here; nothing to assert
  }
  const files = await walkFiles(root);
  assert.deepEqual(files.map((f) => f.path), ["real.txt"]);
});

test("diffSnapshots: added, removed and changed", () => {
  const before = new Map([["a", "1"], ["b", "1"], ["c", "1"]]);
  const after = new Map([["b", "2"], ["c", "1"], ["d", "1"]]);
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.added, ["d"]);
  assert.deepEqual(diff.removed, ["a"]);
  assert.deepEqual(diff.changed, ["b"]);
});

test("rules: outside-workspace blocks by default", () => {
  const matched = evaluate(DEFAULT_RULES, { path: "x", operation: "write", outsideWorkspace: true });
  assert.equal(matched[0].id, "outside-workspace");
  assert.equal(matched[0].severity, "block");
});

test("rules: rm -rf is blocked", () => {
  const ctx = { path: "", operation: "execute", command: "rm -rf /tmp/x" };
  const matched = evaluate(DEFAULT_RULES, ctx);
  assert.equal(matched[0].id, "rm-recursive");
});

test("rules: deny on a private key is only a warning", () => {
  const decision = decide(DEFAULT_RULES, { path: "deploy/id_rsa.pem", operation: "write" });
  assert.equal(decision.severity, "warn");
  assert.equal(decision.matched[0].id, "denylist-credentials");
});

test("rules: a harmless write matches nothing", () => {
  const decision = decide(DEFAULT_RULES, { path: "src/app.py", operation: "write" });
  assert.equal(decision.severity, null);
});

test("checkpoints: capture, modify, rollback restores byte-for-byte", async () => {
  const root = await makeWorkspace();
  await write(root, "src/app.py", "version 1\n");
  await write(root, "src/notes.md", "hello\n");

  const store = new CheckpointStore(root);
  const first = await store.capture({ turn: 1, reason: "baseline" });
  assert.equal(first.noop, false);

  await write(root, "src/app.py", "version 2\n"); // changed
  await write(root, "src/extra.txt", "new\n"); // added
  const { unlink } = await import("node:fs/promises");
  await unlink(join(root, "src/notes.md")); // removed

  const second = await store.capture({ turn: 2 });
  assert.equal(second.noop, false);
  assert.deepEqual(second.changes.changed, ["src/app.py"]);
  assert.deepEqual(second.changes.added, ["src/extra.txt"]);
  assert.deepEqual(second.changes.removed, ["src/notes.md"]);

  // Rollback to the first checkpoint: everything back to "version 1".
  const result = await store.rollback(first.id);
  assert.deepEqual(result.restored.sort(), ["src/app.py", "src/notes.md"]);
  assert.deepEqual(result.removed, ["src/extra.txt"]);
  assert.equal(await readFile(join(root, "src/app.py"), "utf8"), "version 1\n");
  assert.equal(await readFile(join(root, "src/notes.md"), "utf8"), "hello\n");
});

test("checkpoints: capturing without changes is a no-op", async () => {
  const root = await makeWorkspace();
  await write(root, "a.txt", "a");
  const store = new CheckpointStore(root);
  const first = await store.capture({});
  const second = await store.capture({});
  assert.equal(second.noop, true);
  assert.equal(second.id, first.id);
  assert.equal((await store.list()).length, 1);
});

test("checkpoints: unchanged content across checkpoints is stored once", async () => {
  const root = await makeWorkspace();
  await write(root, "stable.txt", "stable");
  const store = new CheckpointStore(root);
  await store.capture({});
  await write(root, "new.txt", "new");
  await store.capture({});
  const blobs = await walkFiles(join(root, ".guardrail", "blobs"));
  assert.equal(blobs.length, 2); // "stable" and "new", no duplicate of "stable"
});

test("checkpoints: diff reports live differences", async () => {
  const root = await makeWorkspace();
  await write(root, "a.txt", "a");
  const store = new CheckpointStore(root);
  const cp = await store.capture({});
  await write(root, "a.txt", "changed");
  const diff = await store.diff(cp.id);
  assert.deepEqual(diff.changed, ["a.txt"]);
});

test("checkpoints: rollback refuses a path that escapes the root", async () => {
  const root = await makeWorkspace();
  await write(root, "a.txt", "a");
  const store = new CheckpointStore(root);
  await store.capture({});
  const index = await store.loadIndex();
  index[0].files["../escape.txt"] = "deadbeef".padEnd(64, "0");
  await store.saveIndex(index);
  await assert.rejects(() => store.rollback(index[0].id), /outside the workspace/);
});
