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

test("checkpoints: ignore patterns keep a vendored toolchain out of the store", async () => {
  // Without this, a workspace holding a portable git copied 112 MB of
  // binaries into the store across three checkpoints on the machine this was
  // built on.
  const root = await makeWorkspace();
  await write(root, "src/app.js", "const a = 1;\n");
  await write(root, ".tooling/git/bin/git.exe", "BINARY".repeat(1000));
  await write(root, "notes.log", "noise\n");

  const store = new CheckpointStore(root, ".guardrail", {
    ignore: [".tooling/**", "**/*.log"],
  });
  await store.capture({});

  const index = await store.loadIndex();
  const tracked = Object.keys(index[0].files);
  assert.deepEqual(tracked, ["src/app.js"]);
  const blobs = await walkFiles(join(root, ".guardrail", "blobs"));
  assert.equal(blobs.length, 1);
});

test("checkpoints: an unchanged file is not re-read", async () => {
  const root = await makeWorkspace();
  await write(root, "stable.txt", "stable");
  await write(root, "mutable.txt", "one\n");

  const store = new CheckpointStore(root);
  await store.capture({});

  // Change one file. The other has the same size and mtime, so the second
  // capture must reuse its recorded hash instead of reading it again.
  await write(root, "mutable.txt", "two\n");
  const second = await store.capture({});

  assert.equal(second.reused, 1, "expected one file reused from the previous checkpoint");
  assert.equal(second.changes.changed.includes("mutable.txt"), true);
  assert.equal(second.changes.changed.includes("stable.txt"), false);

  // The fast path must not corrupt the manifest: a rollback still restores both.
  const index = await store.loadIndex();
  await write(root, "stable.txt", "wrecked");
  await store.rollback(index[index.length - 1].id);
  assert.equal(await readFile(join(root, "stable.txt"), "utf8"), "stable");
});

test("checkpoints: a changed file is re-read even when its size is unchanged", async () => {
  // mtime and size are a heuristic, so the case they cannot distinguish --
  // same length, different content -- must still be caught.
  const root = await makeWorkspace();
  await write(root, "a.txt", "AAAA");
  const store = new CheckpointStore(root);
  await store.capture({});
  await write(root, "a.txt", "BBBB");
  const second = await store.capture({});
  assert.deepEqual(second.changes.changed, ["a.txt"]);
});

test("rollback never deletes an ignored path", async () => {
  // The bug this guards against is data loss, not a wrong report. Rollback
  // walked the whole tree and treated every ignored path as "appeared after the
  // checkpoint", so restoring a checkpoint deleted the vendored toolchain the
  // ignore list existed to protect -- on the workspace this was built for, 112 MB
  // of MinGit that had never been checkpointed in the first place.
  const root = await makeWorkspace();
  await write(root, "src/app.js", "const a = 1;\n");
  await write(root, ".tooling/git/mingw64/bin/git.exe", "TOOLCHAIN".repeat(200));

  const store = new CheckpointStore(root, ".guardrail", { ignore: [".tooling/**"] });
  const first = await store.capture({});

  // An ignored path must not be reported as a difference either.
  const before = await store.diff(first.id);
  assert.deepEqual(before.added, [], "an ignored path must not show up as added");

  await write(root, "src/app.js", "const a = 2;\n");
  await store.capture({});
  const result = await store.rollback(first.id);

  assert.equal(await readFile(join(root, "src/app.js"), "utf8"), "const a = 1;\n");
  assert.deepEqual(result.removed, [], "nothing outside the checkpoint's scope may be removed");
  assert.equal(
    await readFile(join(root, ".tooling/git/mingw64/bin/git.exe"), "utf8"),
    "TOOLCHAIN".repeat(200),
    "the ignored toolchain must survive a rollback",
  );
});
