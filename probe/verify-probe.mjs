/**
 * Verify the probe in isolation, before it ever touches the harness.
 *
 * Two things are proven here:
 *  1. `import(file://...)` of the probe module works with the bundled runtime;
 *  2. `apply(ctx)` registers handlers, and a simulated pre-execute call writes
 *     the payload to the log exactly as the harness would deliver it.
 *
 * The one thing this cannot prove — that the harness calls `apply` at all — is
 * what the probe is for in the first place.
 */

import { readFileSync } from "node:fs";

const url = "file:///C:/Users/\u5f90\u6bc5\u9633/zekia/dsh-guardrail/probe/probe.mjs";
const log = "C:/Users/\u5f90\u6bc5\u9633/zekia/dsh-guardrail/.tmp/probe-verify.log";
process.env.GUARDRAIL_PROBE_LOG = log;

const module = await import(url);
console.log("exported names:", Object.keys(module).sort().join(", "));
console.log("apply is a function:", typeof module.apply === "function");
console.log("name:", module.name);

const handlers = {};
const ctx = {
  root: "C:/Users/\u5f90\u6bc5\u9633/zekia",
  on(event, fn) {
    handlers[event] = fn;
  },
  logger: { info: (m) => console.log("[logger]", m) },
  tools: { register() {} },
};

module.apply(ctx);
console.log("registered events:", Object.keys(handlers).sort().join(", "));

// Simulate a pre-execute delivery with a representative payload.
const fakeExec = {
  name: "read",
  args: { file_path: "a.txt" },
  agent: { session: "session-1" },
  signal: new AbortController().signal,
  async *[Symbol.asyncIterator]() {},
};
await handlers["tools/pre-execute"](fakeExec, async () => "next-called");

const content = readFileSync(log, "utf8");
console.log("\n--- probe log ---\n" + content);
console.log("verification complete");
