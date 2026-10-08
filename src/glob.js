/**
 * A small glob matcher, implemented rather than imported.
 *
 * The plugin runs inside the harness process with no third-party dependencies,
 * so `minimatch` is not an option. The subset implemented here covers what a
 * guard rule actually needs: `**` (across directories), `*` (within one path
 * segment), `?` (one character), and literal text. Character classes and brace
 * expansion are deliberately absent; a rule that needs them can list two rules
 * instead.
 */

/**
 * Expand `{a,b}` alternation, which guard rules genuinely want (`*.{pem,key}`).
 * Only one level, no nesting: that covers every rule this project ships.
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandBraces(pattern) {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const options = match[1].split(",");
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return options.flatMap((option) => expandBraces(before + option + after));
}

function branchToSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        // `**` crosses directory boundaries; `**/` also matches zero segments.
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return source;
}

/**
 * Compile a glob pattern to an anchored regular expression.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  const source = expandBraces(pattern).map(branchToSource).join("|");
  return new RegExp(`^(?:${source})$`);
}

/**
 * Whether a path (forward-slash, workspace-relative) matches a glob.
 * @param {string} path
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchGlob(path, pattern) {
  return globToRegExp(pattern).test(path);
}
