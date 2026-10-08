/**
 * guardrail-probe (v2) — capture what the harness really gives a plugin.
 *
 * v1 learned that `ctx.on` (a mixin accessor) read as falsy in the harness
 * while the same cordis exposes it in isolation. v2 stops guessing: it records
 * the typeof of every candidate API, registers handlers through every channel
 * that might work, and lets one tool call decide which one actually fires.
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

let events = 0;
const MAX_EVENTS = 60;

export const name = "guardrail-probe";

export function apply(ctx) {
  line(`\n=== apply() at ${new Date().toISOString()} ===`);

  // Every candidate API, by typeof, so nothing is assumed.
  for (const key of [
    "on", "once", "emit", "serial", "bail", "parallel", "waterfall",
    "events", "logger", "registry", "reflect", "root", "baseUrl", "get", "provide", "tools",
  ]) {
    let kind;
    try {
      kind = typeof ctx?.[key];
    } catch (error) {
      kind = "THROWS: " + error.message;
    }
    line(`ctx.${key}: ${kind}`);
  }

  // Service access via ctx.get(), the fallback the loader itself documents.
  for (const name of ["events", "tools", "logger"]) {
    try {
      const value = typeof ctx?.get === "function" ? ctx.get(name, false) : undefined;
      line(`ctx.get('${name}', false): ${value === undefined ? "undefined" : typeof value + " " + (value?.constructor?.name ?? "")}`);
    } catch (error) {
      line(`ctx.get('${name}'): THROWS ${error.message}`);
    }
  }

  // Register observers through every channel that exists, and record which one
  // accepted the registration.
  const observe = (label, ...args) => {
    if (events++ >= MAX_EVENTS) return;
    line(`\n--- ${label} (${events}) ---`);
    line(`arguments.length = ${args.length}`);
    args.forEach((arg, index) => {
      line(`  arg${index} [${typeof arg}${arg?.constructor ? " " + arg.constructor.name : ""}]:`);
      line(describe(arg));
    });
    const last = args[args.length - 1];
    if (typeof last === "function") return last();
  };

  const pre = async (...args) => observe("tools/pre-execute", ...args);
  const post = async (...args) => observe("tools/post-execute", ...args);

  if (typeof ctx?.events?.on === "function") {
    ctx.events.on("tools/pre-execute", pre);
    ctx.events.on("tools/post-execute", post);
    line("registered via ctx.events.on");
  }
  if (typeof ctx?.on === "function") {
    ctx.on("tools/pre-execute", pre);
    ctx.on("tools/post-execute", post);
    line("registered via ctx.on");
  }
  line("apply() complete");
}
