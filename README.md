# omp-script-mode

Programmatic tool calling (PTC) for [omp](https://github.com/can1357/oh-my-pi) — a clone of
Factory Droid 1.0's "Script mode" as an omp extension.

Instead of the model calling tools one JSON invocation at a time (each round-trip re-sending
the whole context), the model writes one JavaScript program. The program runs in a sandboxed
`node --permission` subprocess, calls host tools over a stdio JSON-RPC bridge, and only what
it explicitly `text()` prints ever reaches the model's context. Raw files, search results and
command output stay inside the program as variables.

## What it adds

Three tools:

| Tool | Purpose |
|---|---|
| `script` | Run a JS program that calls host tools. `background: true` detaches it and wakes the agent on completion. |
| `script_status` | Check a background job's state, tail its log. |
| `script_cancel` | Kill a running background job. |

In-script API (all async, `await` them):

```js
read(path)                 // file contents
write(path, content)       // { path, bytes }
edit(path, from, to, {all})// unique string replace (all: true for global)
grep(pattern, {root,glob}) // rg output
glob(pattern, {root})      // string[]
bash(command, {timeoutMs}) // stdout
text(s)                    // print to the model's context (the only data it sees)
sleep(ms)
```

## Architecture

```text
model ──script({code})──► extension.ts ──runScript──► bridge.ts
                                                        │ spawn
                                                        ▼
                                  node --permission (fs limited to
                                  runner.cjs + code file)
                                                        │
                              runner.cjs: vm context, prelude injects
                              read/write/edit/grep/glob/bash/text/sleep
                                                        │
                              JSON-RPC over stdio ─────► bridge dispatch
                              (policy-enforced)          + log file
```

- **Sandbox**: Node ≥20 `--permission`; the script can only read `runner.cjs` and its own
  code file — every fs access goes through the bridge. `vm.createContext` isolates globals;
  `require`/`process`/`import()` are absent. The outer-realm invoke handle is bound
  (`Function.prototype.bind` has no `.constructor` leak), captured lexically, then deleted
  from the context global.
- **Approval**: `script` is `exec`-tiered; source containing shell/destructive-looking
  patterns forces an interactive prompt (`override: true`) even under yolo.
- **Policy**: `.omp/script-mode.json` in the project root — see below.
- **Logs**: every call and `console.*` lands in `.omp/script-logs/<run>.log`; `text()`
  output is what the model sees (capped ~16KB).
- **Wake semantics**: background jobs end with an `aside` user message (attribution `agent`),
  injected at the next step boundary; it starts a turn when the session is idle.

## Policy (`.omp/script-mode.json`)

```json
{
	"root": ".",
	"allowPaths": [],
	"writable": true,
	"allowBash": true,
	"bashDeny": ["\\bnpm\\s+publish\\b"],
	"maxScriptMs": 480000,
	"bashTimeoutMs": 150000,
	"maxTextBytes": 16384,
	"maxResultBytes": 262144
}
```

Defaults: confined to the session cwd, writes on, `bash()` on with a denylist
(`rm -rf`, `sudo`, `git push --force`, pipe-to-shell, etc.).

## Install

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/Documents/omp-script-mode/src/extension.ts
```

or per-project at `.omp/extensions/`, or `--extension ~/Documents/omp-script-mode/src/extension.ts`.

Requires `node` ≥ 20 on PATH (for `--permission`).

## Example

```js
// model writes one script instead of 300 tool calls
const files = await glob("src/**/*.ts");
let migrated = 0;
for (const f of files) {
  const src = await read(f);
  if (src.includes("legacyImport")) {
    await edit(f, "legacyImport", "newImport", { all: true });
    migrated++;
  }
}
const test = await bash("bun test 2>&1 | tail -5");
text(`migrated=${migrated}\n${test}`);
```

The model sees only the `text()` output; the 300 reads/edits never touch its context.

## Honest limitations vs Droid's Script tool

- **No permission parity with host tools**: inner calls run under the bridge's own policy,
  not omp's per-tool approval — the boundary approval (`script` itself) is the gate.
- **Writes don't create host snapshots**: `write`/`edit` inside a script bypass omp's
  hashline bookkeeping, so a later `edit` tool call on the same file has no snapshot.
- `grep`/`glob`/`bash` are equivalents, not the real host tools — `xd://` URLs,
  archive member reads, and hashline `:N-M` selectors are not supported inside scripts.
- Gains concentrate in the same tail Droid reports: batch/repetitive/filter-heavy tasks.
  For a three-call task the script just costs extra tokens.

## Dev

```bash
bun install
bun test          # 12 end-to-end tests spawning the real sandbox
bun run typecheck
```
