/**
 * Guard rules.
 *
 * A rule is a small predicate over a tool call plus a severity. The engine's
 * only job is to say, for one call, which rules it matches. Deciding what to do
 * with a `block` (refuse the call) versus a `warn` (let it through and record
 * it) lives with the harness wiring, because that is where the caller and the
 * session live.
 *
 * Rules are written so they can be tested with a plain object and no harness,
 * which is the point of keeping them pure.
 */

import { matchGlob } from "./glob.js";

export const SEVERITIES = ["block", "warn", "log"];

/**
 * @typedef {Object} RuleContext
 * @property {string} path - workspace-relative path, forward slashes.
 * @property {'write' | 'delete' | 'execute'} operation
 * @property {string} [command] - the shell command, for execute operations.
 * @property {boolean} [outsideWorkspace] - whether the target escapes the workspace.
 */

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string} type
 * @property {'block' | 'warn' | 'log'} severity
 * @property {string} [pattern]
 * @property {string} [reason]
 */

// `-r`, `-rf`, `--recursive`, `-Recurse` all mean "delete a directory tree".
// `-[A-Za-z]*r[A-Za-z]*` matches a short-flag group containing `r` and, from
// the second dash, a long `--recursive`; `rm -f` alone does not match, and
// that is correct: force without recursion deletes one path.
const RM_RECURSIVE = /(?:^|\s)(?:rm|Remove-Item)\b[^\r\n]*?-[A-Za-z]*r[A-Za-z]*/i;

/** Whether one rule matches a call context. */
export function ruleMatches(rule, ctx) {
  switch (rule.type) {
    case "outside-workspace":
      return ctx.outsideWorkspace === true;
    case "denylist":
      return matchGlob(ctx.path, rule.pattern);
    case "forbid-overwrite":
      return ctx.operation === "write" && matchGlob(ctx.path, rule.pattern);
    case "forbid-delete":
      return ctx.operation === "delete";
    case "rm-recursive":
      return ctx.operation === "execute" && RM_RECURSIVE.test(ctx.command ?? "");
    default:
      return false;
  }
}

/**
 * Every rule that matches, most severe first.
 * @param {Rule[]} rules
 * @param {RuleContext} ctx
 * @returns {Rule[]}
 */
export function evaluate(rules, ctx) {
  const order = { block: 0, warn: 1, log: 2 };
  return rules
    .filter((rule) => ruleMatches(rule, ctx))
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * The single outcome for a call: the highest severity among the matches.
 * @param {Rule[]} rules
 * @param {RuleContext} ctx
 * @returns {{ severity: 'block'|'warn'|'log'|null, matched: Rule[] }}
 */
export function decide(rules, ctx) {
  const matched = evaluate(rules, ctx);
  const severity = matched.length === 0 ? null : matched[0].severity;
  return { severity, matched };
}

/**
 * Default rules shipped with the plugin. Deliberately few and conservative:
 * a guard that blocks more than people expect gets disabled and then protects
 * nobody.
 */
export const DEFAULT_RULES = [
  {
    id: "outside-workspace",
    type: "outside-workspace",
    severity: "block",
    reason: "the operation targets a path outside the session workspace",
  },
  {
    id: "rm-recursive",
    type: "rm-recursive",
    severity: "block",
    reason: "recursive deletion cannot be undone by a checkpoint and is refused",
  },
  {
    id: "forbid-overwrite-git-config",
    type: "forbid-overwrite",
    pattern: ".git/**",
    severity: "block",
    reason: "overwriting .git corrupts the repository and is not covered by checkpoints",
  },
  {
    id: "denylist-credentials",
    type: "denylist",
    pattern: "**/*.{pem,key,p12,pfx}",
    severity: "warn",
    reason: "the call touches a file that looks like a private key or certificate",
  },
];
