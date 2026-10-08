/**
 * Local integration test for src/index.js against the real cordis.
 *
 * Proves, without the harness: the plugin loads, the guard evaluates and
 * respects warn vs enforce, the checkpoint fires after a mutating tool, and the
 * rollback tool registers and restores.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP =
  "C:/Users/\u5f90\u6bc5\u9633/AppData/Local/Programs/DSH NEXT/resources/app/node_modules";
const { Context } = await import(`file:///${APP}/@deepseek-ai/cordis/lib/index.js`);
const plugin = await import(
  "file:///C:/Users/\u5f90\u6bc5\u9633/zekia/dsh-guardrail/src/index.js"
);

const workspace = "C:/Users/\u5f90\u6bc5\u9633/zekia/dsh-guardrail/.tmp/guardrail-ws";

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

async function boot(config) {
  const root = new Context();
  const registered = [];
  root.provide("tools", { name: "tools", register: (definition) => registered.push(definition) });
  const reg = root.registry.plugin({ ...plugin, inject: ["tools"] }, config);
  await reg.ctx.fiber.await();
  await sleep(10);
  return { root, registered };
}

const outsideExec = {
  name: "write",
  callId: "call_outside",
  arguments: { file_path: "C:/Windows/System32/drivers/etc/hosts", content: "x" },
};
const insideExec = {
  name: "write",
  callId: "call_inside",
  arguments: { file_path: join(workspace, "keep.txt"), content: "x" },
};
const rmExec = { name: "bash", callId: "call_rm", arguments: { command: "rm -rf /tmp/x" } };

async function fire(root, event, ...args) {
  let nextCalled = false;
  const next = async () => {
    nextCalled = true;
    return "next-ran";
  };
  const returned = await root.waterfall(event, ...args, next);
  return { nextCalled, returned };
}

// ---------------------------------------------------------------- scenario 1
await rm(workspace, { recursive: true, force: true });
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "keep.txt"), "original\n");

console.log("\n=== 1. warn mode (enforce: false, the default) ===");
{
  const { root, registered } = await boot({ workspace, enforce: false });

  const outside = await fire(root, "tools/pre-execute", outsideExec);
  check("an outside-workspace write is NOT blocked in warn mode", outside.nextCalled === true);

  const rm = await fire(root, "tools/pre-execute", rmExec);
  check("rm -rf is NOT blocked in warn mode", rm.nextCalled === true);

  const inside = await fire(root, "tools/pre-execute", insideExec);
  check("a harmless write passes through", inside.nextCalled === true);

  check("the rollback tool was registered", registered.length === 1, registered.map((d) => d.name).join(","));
  const definition = registered[0];
  check(
    "the tool definition has name, description, parameters and execute",
    Boolean(definition?.name && definition?.description && definition?.parameters && definition?.execute),
  );
  check("the tool parameters are an object schema", definition?.parameters?.type === "object");
}

// ---------------------------------------------------------------- scenario 2
console.log("\n=== 2. enforce mode (enforce: true) ===");
{
  const { root } = await boot({ workspace, enforce: true });

  const outside = await fire(root, "tools/pre-execute", outsideExec);
  check("an outside-workspace write is blocked", outside.nextCalled === false);
  check(
    "the block returns an isError result naming the rule",
    outside.returned?.isError === true && /outside-workspace/.test(outside.returned.content[0].text),
    String(outside.returned?.content?.[0]?.text ?? "").slice(0, 60),
  );

  const rm = await fire(root, "tools/pre-execute", rmExec);
  check("rm -rf is blocked", rm.nextCalled === false);
  check("the rm block names rm-recursive", /rm-recursive/.test(rm.returned?.content?.[0]?.text ?? ""));

  const inside = await fire(root, "tools/pre-execute", insideExec);
  check("a harmless write still passes", inside.nextCalled === true);
}

// ---------------------------------------------------------------- scenario 3
console.log("\n=== 3. checkpoints after a mutating tool ===");
{
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "keep.txt"), "original\n");

  const { root } = await boot({ workspace, enforce: false });

  // baseline
  await fire(root, "tools/post-execute", { name: "read", callId: "c0", arguments: {} }, { isError: false });
  const afterRead = await readFile(join(workspace, ".guardrail", "checkpoints.json"), "utf8").catch(() => null);
  check("a read does not create a checkpoint", afterRead === null);

  await fire(root, "tools/post-execute", { name: "write", callId: "c1", arguments: {} }, { isError: false });
  const first = await readFile(join(workspace, ".guardrail", "checkpoints.json"), "utf8").catch(() => null);
  check("a write creates a checkpoint", first !== null);

  await writeFile(join(workspace, "keep.txt"), "modified\n");
  await writeFile(join(workspace, "added.txt"), "new\n");
  await fire(root, "tools/post-execute", { name: "write", callId: "c2", arguments: {} }, { isError: false });

  const index = JSON.parse(await readFile(join(workspace, ".guardrail", "checkpoints.json"), "utf8"));
  check("two checkpoints were captured", index.length === 2, `${index.length}`);
  check("the second one records the change", index[1].files["keep.txt"] !== index[0].files["keep.txt"]);

  const failedTool = await fire(
    root,
    "tools/post-execute",
    { name: "write", callId: "c3", arguments: {} },
    { isError: true, content: [] },
  );
  const index2 = JSON.parse(await readFile(join(workspace, ".guardrail", "checkpoints.json"), "utf8"));
  check("a failed tool is not checkpointed as a change", index2.length === 2 && failedTool.nextCalled === true);
}

// ---------------------------------------------------------------- scenario 4
console.log("\n=== 4. the rollback tool ===");
{
  const { root, registered } = await boot({ workspace, enforce: false });
  const definition = registered[0];

  const list = await definition.execute({ action: "list" });
  check("list returns the checkpoints", /cp-/.test(list.content[0].text), list.content[0].text.split("\n").length + " lines");

  const index = JSON.parse(await readFile(join(workspace, ".guardrail", "checkpoints.json"), "utf8"));
  const baseline = index[0].id;

  await writeFile(join(workspace, "keep.txt"), "wrecked\n");
  await writeFile(join(workspace, "junk.txt"), "junk\n");

  const diff = await definition.execute({ action: "diff", id: baseline });
  check("diff reports the change", /changed: .*keep\.txt/.test(diff.content[0].text), diff.content[0].text.split("\n")[2]);

  const rollback = await definition.execute({ action: "rollback", id: baseline });
  check("rollback reports success", rollback.isError === false);

  const restored = await readFile(join(workspace, "keep.txt"), "utf8");
  check("the file content is restored", restored === "original\n", JSON.stringify(restored));
  const gone = await readFile(join(workspace, "junk.txt"), "utf8").catch(() => null);
  check("a file added after the checkpoint is removed", gone === null);

  const missingId = await definition.execute({ action: "rollback" });
  check("rollback without an id is a tool error, not a crash", missingId.isError === true);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
