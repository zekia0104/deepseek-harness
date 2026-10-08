/**
 * guardrail-probe (v3) — compact: field names plus shallow values only.
 *
 * v2 answered the API surface. v3 answers one question with a dozen lines:
 * which field of the exec object carries the tool's arguments, and what does
 * the post-execute result look like. The huge `agent` and `signal` objects are
 * replaced with a one-line placeholder, because dumping them produced hundreds
 * of lines to read one field name.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";

const LOG =
  process.env.GUARDRAIL_PROBE_LOG ?? "C:/Users/\u5f90\u6bc5\u9633/.dsh/guardrail-probe.log";

function line(text) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, text + "\n");
  } catch {
    /* best effort */
  }
}

function shallow(value) {
  try {
    return inspect(value, {
      depth: 1,
      maxArrayLength: 8,
      maxStringLength: 160,
      breakLength: 200,
      getters: false,
    });
  } catch {
    return String(value);
  }
}

const OMITTED = new Set(["agent", "signal", "token"]);

export const name = "guardrail-probe";

export function apply(ctx) {
  line(`\n=== apply() ${new Date().toISOString()} ===`);

  const dump = (label, value) => {
    if (!value || typeof value !== "object") {
      line(`${label}: ${typeof value} ${shallow(value)}`);
      return;
    }
    const keys = Object.keys(value).sort();
    line(`${label} keys: ${keys.join(", ")}`);
    for (const key of keys) {
      if (OMITTED.has(key)) {
        line(`  ${key}: <${typeof value[key]}, omitted>`);
        continue;
      }
      line(`  ${key}: ${shallow(value[key])}`);
    }
  };

  const on = ctx?.on ?? ctx?.events?.on;

  on?.("tools/pre-execute", async (...args) => {
    line(`\n--- pre-execute (${args.length} args) ---`);
    dump("exec", args[0]);
    const next = args[args.length - 1];
    if (typeof next === "function") return next();
  });

  on?.("tools/post-execute", async (...args) => {
    line(`\n--- post-execute (${args.length} args) ---`);
    dump("exec", args[0]);
    dump("result", args[1]);
    const next = args[args.length - 1];
    if (typeof next === "function") return next();
  });

  line("apply() complete");
}
