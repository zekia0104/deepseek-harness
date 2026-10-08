/**
 * The pure engine, exported for tests and for the future harness wiring.
 *
 * This module deliberately knows nothing about cordis, tool runtimes or event
 * hooks. Those live in the wiring layer, because the engine has to be provable
 * with nothing but `node --test`, and the wiring has to be provable only
 * against a running harness.
 */

export { BlobStore, hashContent } from "./store.js";
export { CheckpointStore } from "./checkpoints.js";
export {
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_NAMES,
  DEFAULT_MAX_FILE_BYTES,
  diffSnapshots,
  resolveInside,
  snapshot,
  walkFiles,
} from "./snapshot.js";
export { DEFAULT_RULES, SEVERITIES, decide, evaluate, ruleMatches } from "./rules.js";
export { globToRegExp, matchGlob } from "./glob.js";
