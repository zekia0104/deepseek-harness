# dsh-guardrail

**Intelligent checkpoints, workspace safety guards and instant rollback for DeepSeek Harness.**

> **Status: running on a real harness.**
> The engine passes 18 tests with `node --test --test-isolation=none`, and the
> cordis wiring passes 22 integration checks against the harness's own cordis.
> Enforcement ships **off**: the first install only warns, so a wrong assumption
> about the veto contract cannot make the harness unusable.

## How it attaches

The harness delivers the tool lifecycle as cordis **waterfalls**:

```js
ctx.on("tools/pre-execute",  async (exec, next) => { ... })           // 2 args
ctx.on("tools/post-execute", async (exec, result, next) => { ... })   // 3 args
```

with `exec = { name, arguments, callId, rootCallId, signal, agent, token, ... }`
and `result = { content, isError, meta, value }`. A listener that does **not**
call `next()` vetoes the rest of the chain and its return value becomes the tool
result — that is the blocking contract, and it is why a guard can refuse a call
rather than merely complain about it afterwards.

Reading `ctx.tools` **throws** unless the entry declares `inject: [tools]`, which
is how the rollback tool gets registered.

## Installing it

Append to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-guardrail
      name: 'file:///C:/Users/you/dsh-guardrail/src/index.js'
      inject: [tools]
      config:
        workspace: 'C:/Users/you/workspace'
        enforce: false
        directory: .guardrail
```

`inject: [tools]` is not optional. Single-quote Windows paths: a YAML
double-quoted scalar processes backslash escapes, and `"C:\Users"` is a parse
error. Restart the harness — plugin configuration is read at startup.

## What the shapes cost to learn

Every field name above was read out of the harness rather than guessed, after
four wrong guesses:

| Wrong | Right |
| --- | --- |
| `ctx.on` is unavailable | it is a mixin accessor, and fine — v1 crashed on `ctx.tools` *before* reaching the `ctx.on` check, so the log looked like `on` was missing |
| `exec.args` | `exec.arguments` |
| `exec.cwd` / `exec.session` | neither exists; the real keys are `agent, arguments, callId, concludeTurn, deferContext, name, rootCallId, signal, token` |
| a bare patch entry adds a plugin | it is an *override*, silently dropped |

The pattern in all four is the one this project exists to complain about: **a
system that reports nothing is not the same as a system that succeeded.**

## What it does

Three features, each mapped to one real harness hook:

| Feature | Harness hook |
| --- | --- |
| **Safety guards** — block dangerous operations before they run | `tools/pre-execute` |
| **Intelligent checkpoints** — snapshot the workspace after writes | `tools/post-execute` |
| **Instant rollback** — restore any checkpoint | a tool registered on `ctx.tools` |

### Safety guards

Declarative rules with three severities — `block`, `warn`, `log`:

| Rule | Default |
| --- | --- |
| `outside-workspace` | **block** — writes escaping the session workspace |
| `rm-recursive` | **block** — `rm -rf`, `--recursive`, `-Recurse` |
| `forbid-overwrite-git-config` | **block** — writing `.git/**` |
| `denylist-credentials` | warn — touching `*.{pem,key,p12,pfx}` |

### Intelligent checkpoints

"Intelligent" is four concrete behaviours:

1. **content-addressed deduplication** — identical bytes stored once (`blobs/<sha256>`);
2. **change-only capture** — a blob is written only when new and only when it
   differs from the previous checkpoint;
3. **scope awareness** — `.git`, `node_modules`, caches and vendor trees are
   never walked;
4. **coalescing** — a capture that changes nothing produces no new checkpoint.

### Instant rollback

Restoring is `O(number of changed files)`: each path is a direct write-back from
a content-addressed blob, not a replay of an edit log. Rollback also removes
files that appeared after the checkpoint, so the workspace returns to the
captured state.

## Storage

```
.guardrail/                  ← gitignored
├── checkpoints.json         ← index: id, time, turn, reason, files
└── blobs/<sha256>           ← content-addressed file contents
```

## Architecture

```
src/glob.js        glob matching (**, *, ?, {a,b})
src/store.js       content-addressed blob store
src/snapshot.js    directory walk + hash snapshot + diff
src/rules.js       guard rule predicates
src/checkpoints.js capture / list / diff / rollback
src/engine.js      re-exports (the pure, harness-free surface)
```

The engine deliberately knows nothing about cordis, tool runtimes or events. It
has to be provable with `node --test` alone; the harness wiring has to be
provable only against a running harness, and keeping the two apart is what makes
each one verifiable.

## Test

```bash
node --test --test-isolation=none test/
```

Zero dependencies, no install step. The bundled runtime in a DSH Desktop install
works too:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "$env:LOCALAPPDATA\Programs\DSH NEXT\DSH NEXT.exe" --test --test-isolation=none test/
```

`--test-isolation=none` runs the suite in-process, which is both faster and
required in an environment that forbids the child processes the default runner
spawns.

## Why "no harness wiring yet" is the honest state

The harness exposes `ctx.on("tools/pre-execute", (exec, next) => ...)` and
`ctx.on("tools/post-execute", (exec, result, next) => ...)` as middleware, and
registers tools via `ctx.tools.register({ name, description, parameters, ... })`.
Those shapes are confirmed from the harness's own code. What has not been pinned
down precisely enough to ship is the `exec` payload fields and the exact
short-circuit semantics of the middleware — details that live in a
`docs/architecture.md` not shipped in the compiled distribution, and that a
single run against a real harness will confirm or refute. Guessing them here
would repeat the failure mode this project exists to prevent: a plugin that
loads cleanly, logs nothing, and does nothing.

## License

[MIT](LICENSE) © 2026 zekia0104
