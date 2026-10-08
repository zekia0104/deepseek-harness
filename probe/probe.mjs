/**
 * guardrail-probe — a deliberately tiny, observational cordis plugin.
 *
 * Its only job is to answer one question with evidence instead of a guess:
 * what does the harness actually pass to `tools/pre-execute` and
 * `tools/post-execute`, and what does `ctx` expose? Everything it sees is
 * written to a log file and also echoed to the harness logger.
 *
 * It is observational only: it never blocks a call. It registers no tools and
 * changes no state. Once the log has been read, this entry is removed.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";

const DEFAULT_LOG =
  process.env.GUARDRAIL_PROBE_LOG ?? "C:/Users/\u5f90\u6bc5\u9633/.dsh/guardrail-probe.log";

/** A serialization that survives functions, cycles and class instances. */
function describe(value) {
  try {
    return inspect(value, {
      depth: 5,
      maxArrayLength: 40,
      maxStringLength: 400,
      breakLength: Infinity,
      getters: false,
    });
  } catch {
    return String(value);
  }
}

function line(text) {
  try {
    mkdirSync(dirname(DEFAULT_LOG), { recursive: true });
    appendFileSync(DEFAULT_LOG, text + "\n");
  } catch {
    // The file channel is best-effort; the logger channel below still works.
  }
}

let events = 0;
const MAX_EVENTS = 40;

export const name = "guardrail-probe";

export function apply(ctx) {
  line(`\n=== apply() at ${new Date().toISOString()} ===`);
  line(`log file: ${DEFAULT_LOG}`);

  // 1. What does the context expose?
  const own = Object.keys(ctx ?? {}).sort();
  line(`ctx own keys (${own.length}): ${JSON.stringify(own.slice(0, 160))}`);
  for (const key of ["root", "baseDir", "baseUrl", "cwd", "logger", "tools", "shell", "agent", "workspace"]) {
    if (ctx && key in ctx) {
      const value = ctx[key];
      line(`ctx.${key}: ${typeof value} ${String(value).slice(0, 160)}`);
    }
  }
  if (ctx?.tools) {
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.tools));
    line(`ctx.tools prototype methods: ${JSON.stringify(proto.slice(0, 80))}`);
    line(`ctx.tools own keys: ${JSON.stringify(Object.keys(ctx.tools).slice(0, 80))}`);
  }
  if (ctx?.on) {
    line(`ctx.on type: ${typeof ctx.on}`);
  }

  // 2. Observe pre-execute, capturing every argument regardless of arity.
  ctx?.on?.("tools/pre-execute", async (...args) => {
    if (events++ >= MAX_EVENTS) return;
    line(`\n--- tools/pre-execute (${events}) ---`);
    line(`arguments.length = ${args.length}`);
    args.forEach((arg, index) => {
      line(`  arg${index} [${typeof arg}${arg?.constructor ? " " + arg.constructor.name : ""}]:`);
      line(describe(arg));
    });
    const last = args[args.length - 1];
    if (typeof last === "function") return last();
  });

  // 3. Observe post-execute.
  ctx?.on?.("tools/post-execute", async (...args) => {
    if (events++ >= MAX_EVENTS) return;
    line(`\n--- tools/post-execute (${events}) ---`);
    line(`arguments.length = ${args.length}`);
    args.forEach((arg, index) => {
      line(`  arg${index} [${typeof arg}${arg?.constructor ? " " + arg.constructor.name : ""}]:`);
      line(describe(arg));
    });
    const last = args[args.length - 1];
    if (typeof last === "function") return last();
  });

  ctx?.logger?.info("guardrail-probe: registered pre/post-execute observers, logging to " + DEFAULT_LOG);
}
