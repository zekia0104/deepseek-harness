/**
 * dsh-guardrail — the cordis wiring.
 *
 * Everything in this file is written against the shapes the harness was
 * observed to use, not against shapes that seemed reasonable:
 *
 *   ctx.on('tools/pre-execute',  (exec, next) => ...)          2 arguments
 *   ctx.on('tools/post-execute', (exec, result, next) => ...)  3 arguments
 *   exec  = { name, arguments, callId, rootCallId, signal, agent, token, ... }
 *   result= { content, isError, meta, value }
 *
 * A listener that does not call `next()` vetoes the rest of the waterfall,
 * which is how a tool call is blocked; its return value becomes the result.
 *
 * Blocking is OFF by default. The first install only warns, so that a wrong
 * assumption about the veto contract cannot make the harness unusable. Turn it
 * on with `enforce: true` once the warnings have been seen.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { CheckpointStore } from "./checkpoints.js";
import { DEFAULT_RULES, decide } from "./rules.js";

export const name = "dsh-guardrail";

/** Tools whose success means the workspace changed and deserves a checkpoint. */
const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "multi_edit",
  "str_replace_editor",
  "str-replace-editor",
  "apply_patch",
  "create_file",
  "move_file",
  "delete_file",
  "notebook_edit",
  "bash",
  "pwsh",
]);

/** Argument keys that can name a filesystem target, across the harness's tools. */
const PATH_KEYS = [
  "file_path",
  "path",
  "notebook_path",
  "target",
  "destination",
  "new_path",
  "source",
];

/**
 * Paths never worth checkpointing.
 *
 * A workspace that contains a vendored toolchain -- a portable git, a downloaded
 * SDK -- otherwise has every one of its binaries copied into the store by the
 * first capture. On the machine this was developed on that was 112 MB and 769
 * files for three checkpoints.
 */
export const DEFAULT_IGNORE = [".tooling/**", ".cache/**", "**/*.log", "**/*.tmp"];

export function workspaceRelative(workspace, value) {
  const absolute = isAbsolute(value) ? value : resolve(workspace, value);
  return relative(workspace, absolute).split(sep).join("/");
}

export function isInsideWorkspace(workspace, value) {
  const base = resolve(workspace);
  const target = isAbsolute(value) ? resolve(value) : resolve(workspace, value);
  return target === base || target.startsWith(base + sep);
}

/**
 * One rule context per plausible target of a call.
 * @param {string} workspace
 * @param {object} exec
 */
export function callContexts(workspace, exec) {
  const toolName = typeof exec?.name === "string" ? exec.name : "";
  const args = exec?.arguments ?? {};
  const command = typeof args?.command === "string" ? args.command : "";
  const operation = command ? "execute" : "write";

  const paths = PATH_KEYS.map((key) => args?.[key]).filter(
    (value) => typeof value === "string" && value.length > 0,
  );

  if (paths.length === 0) {
    return [{ path: "", operation, command, outsideWorkspace: false, toolName }];
  }
  return paths.map((value) => ({
    path: workspaceRelative(workspace, value),
    operation,
    command,
    outsideWorkspace: !isInsideWorkspace(workspace, value),
    toolName,
  }));
}

function blockedResult(rule, target) {
  const where = target.path || target.command || "(no target)";
  return {
    content: [
      {
        type: "text",
        text:
          `[dsh-guardrail] refused: ${rule.id} -- ${rule.reason}\n` +
          `target: ${where}\n` +
          `Disable enforcement with guardrail.enforce=false, or add a rule exception.`,
      },
    ],
    isError: true,
  };
}

/**
 * @param {object} ctx - the cordis context the loader provides.
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const workspace = resolve(config.workspace ?? process.cwd());
  const enforce = config.enforce === true;
  const rules =
    Array.isArray(config.rules) && config.rules.length > 0 ? config.rules : DEFAULT_RULES;
  const store = new CheckpointStore(workspace, config.directory ?? ".guardrail", {
    ignore: config.ignore ?? DEFAULT_IGNORE,
    maxBytes: config.maxBytes,
  });

  const logger = typeof ctx?.logger === "function" ? ctx.logger("dsh-guardrail") : undefined;
  const say = (message) => {
    try {
      if (typeof logger === "function") logger(message);
      else if (logger?.info) logger.info(message);
      else console.error(`[dsh-guardrail] ${message}`);
    } catch {
      /* logging must never break a tool call */
    }
  };

  // `ctx.tools` THROWS when the entry does not declare `inject: [tools]`; reading
  // it unguarded is what killed the first probe before it registered anything.
  let tools;
  try {
    tools = ctx?.tools;
  } catch {
    tools = undefined;
  }

  // ---------------------------------------------------------------- guards --
  ctx?.on?.("tools/pre-execute", async (exec, next) => {
    let contexts;
    try {
      contexts = callContexts(workspace, exec);
    } catch (error) {
      say(`guard failed open: ${error.message}`);
      return next();
    }

    const verdicts = contexts.map((context) => ({ context, decision: decide(rules, context) }));
    const blocking = verdicts.find((entry) => entry.decision.severity === "block");

    if (blocking && enforce) {
      const rule = blocking.decision.matched[0];
      say(`blocked ${exec?.name}: ${rule.id}`);
      // Not calling next() vetoes the chain; the returned value is the result.
      return blockedResult(rule, blocking.context);
    }

    for (const entry of verdicts) {
      const rule = entry.decision.matched[0];
      if (!rule) continue;
      const where = entry.context.path || entry.context.command || "";
      const prefix = blocking ? "would block" : entry.decision.severity;
      say(`${prefix}: ${rule.id} on ${where} -- ${rule.reason}`);
    }
    return next();
  });

  // ----------------------------------------------------------- checkpoints --
  ctx?.on?.("tools/post-execute", async (exec, result, next) => {
    const toolName = typeof exec?.name === "string" ? exec.name : "";
    if (MUTATING_TOOLS.has(toolName) && result?.isError !== true) {
      try {
        const outcome = await store.capture({
          reason: `${toolName}:${exec?.callId ?? ""}`,
          turn: exec?.callId ?? null,
        });
        if (!outcome.noop) {
          const changed =
            outcome.changes.added.length +
            outcome.changes.removed.length +
            outcome.changes.changed.length;
          say(`checkpoint ${outcome.id} after ${toolName} (${changed} file(s), ${outcome.stored} new blob(s))`);
        }
      } catch (error) {
        say(`checkpoint failed: ${error.message}`);
      }
    }
    return next();
  });

  // -------------------------------------------------------------- rollback --
  if (tools && typeof tools.register === "function") {
    try {
      tools.register({
        name: "guardrail_checkpoints",
        description:
          "List, diff and restore the workspace checkpoints this session has captured. " +
          "Use action=list to see them, action=diff for the current differences against " +
          "one, and action=rollback to restore it. Rollback also removes files that " +
          "appeared after the checkpoint.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "diff", "rollback"],
              description: "What to do. Defaults to list.",
            },
            id: {
              type: "string",
              description: "Checkpoint id, required for diff and rollback.",
            },
            remove_added: {
              type: "boolean",
              description:
                "For rollback: also delete files created after the checkpoint. Default true.",
            },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          const action = typeof args?.action === "string" ? args.action : "list";
          try {
            if (action === "list") {
              const checkpoints = await store.list();
              if (checkpoints.length === 0) {
                return text("No checkpoints yet.");
              }
              const lines = checkpoints.map(
                (checkpoint) =>
                  `- ${checkpoint.id}  ${checkpoint.createdAt}  ${checkpoint.files} file(s)  ${checkpoint.reason}`,
              );
              return text(`Checkpoints (newest last):\n${lines.join("\n")}`);
            }

            if (typeof args?.id !== "string" || args.id.length === 0) {
              return text(`action=${action} needs an id.`, true);
            }

            if (action === "diff") {
              const diff = await store.diff(args.id);
              return text(
                `Against ${args.id}:\n` +
                  `  added:   ${diff.added.join(", ") || "(none)"}\n` +
                  `  changed: ${diff.changed.join(", ") || "(none)"}\n` +
                  `  removed: ${diff.removed.join(", ") || "(none)"}`,
              );
            }

            const result = await store.rollback(args.id, {
              removeAdded: args?.remove_added !== false,
            });
            return text(
              `Restored ${result.restored.length} file(s) from ${args.id}` +
                (result.removed.length ? `, removed ${result.removed.length} newer file(s)` : ""),
            );
          } catch (error) {
            return text(`guardrail_checkpoints failed: ${error.message}`, true);
          }
        },
      });
    } catch (error) {
      say(`could not register the rollback tool: ${error.message}`);
    }
  } else {
    say("ctx.tools is unavailable; rollback tool not registered (add inject: [tools])");
  }

  say(`active on ${workspace} (enforce=${enforce}, ${rules.length} rule(s))`);
}

function text(body, isError = false) {
  return { content: [{ type: "text", text: body }], isError };
}
