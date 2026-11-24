# Handoff — omp-script-mode v0.1.0

## Logic

Clone of Factory Droid 1.0's Script mode (programmatic tool calling) as an omp extension.
The model calls `script({code})` once; the code runs in a sandboxed `node --permission`
subprocess and calls host-side operations over JSON-RPC on stdio. Only `text()` output
reaches the model context — everything else stays in the program as variables.

## Implementation

- `src/extension.ts` — registers `script`, `script_status`, `script_cancel` via
  `pi.registerTool`. Owns the background-job registry (`jobs: Map`) and wake delivery
  (`sendUserMessage` `deliverAs: "aside"`, `attribution: "agent"`).
- `src/bridge.ts` — `runScript()`: writes code to `.omp/script-logs/*.code.js`, spawns
  `node --permission`, serves the stdio JSON-RPC dispatch (`read/write/edit/grep/glob/
  bash/text/log/sleep`), caps results, kills on `maxScriptMs`, and captures the final
  `{t:"finish"}` frame. This is the runtime owner of policy enforcement.
- `src/runner.cjs` — executes inside the sandbox. Builds a `vm` context, injects the
  prelude (helper globals + `__omp_rpc`), runs user code in `(async()=>{...})()`, sends
  the `finish` frame. RPC replies arrive on stdin and resolve by `id`.
- `src/policy.ts` — `ScriptPolicy`, `.omp/script-mode.json` loading, `resolveInside`
  path containment (realpath'd deepest-existing ancestor), `deniedBashCommand`.
- `test/bridge.test.ts` — 12 end-to-end tests that spawn the real `node --permission`
  sandbox via `runScript()`: read/write/edit/grep/glob/bash round-trips, policy
  denials, sandbox-escape attempts, timeout kill, and log-file capture.

## Decisions

- Node subprocess + `vm` + `--permission` chosen over in-process eval: real isolation,
  no `require`/`process`, crash/timeout survivable by kill.
- The outer-realm invoke is `inv.bind(undefined)` — bound functions have no
  `.constructor` path to the outer `Function` — captured into a lexical `__inv` inside
  the prelude, then `__omp_invoke` is deleted from the context global.
- Inner calls do NOT go through omp's per-tool approval (no API exists to invoke a
  builtin from an extension; `ctx.invokeTool` is same-name only). Bridge policy +
  the one `script` boundary approval is the gate. Documented in README.
- `ToolDefinition<typeof params>` annotations required: `pi.registerTool` does not
  infer `Static<TParams>` from an inline `parameters` value on this omptype version.

## Debug without AI

- Script exits instantly, `script exited without finishing`: child spawn failed —
  check `env.PATH` is set in the spawn (nvm-node needs real PATH), then run the
  printed runner command by hand to see stderr.
- `__omp_invoke is not defined`: prelude ordering — `__inv` must be captured before
  `delete globalThis.__omp_invoke`.
- Calls hang: stdin replies must be single-line JSON; `console.log` inside the script
  is redirected to the `log` op, so stdout stays protocol-only.
- `path outside allowed root`: `resolveInside` realpaths the deepest existing ancestor —
  a symlink under cwd pointing out of root is rejected by design.
- Full call trace per run: `.omp/script-logs/<run>.log`.

## Risks

- `bash()` inside a script has full shell: denylist is best-effort, cwd can't be
  constrained by PATH tricks. The boundary approval + policy file is the real gate.
- In-script `write`/`edit` bypass omp's hashline snapshot — a following `edit` tool
  call on the same file won't see the script's write.
- Node < 20 or missing `node` on PATH: spawn fails; no fallback runner yet.
- Background jobs are in-memory; `omp` restart loses them (logs persist on disk).

## Q&A

- Q: Where does policy get enforced? A: `bridge.ts` dispatch + `policy.ts`; the
  sandbox itself cannot touch fs (node --permission), it can only ask the bridge.
- Q: What reaches model context? A: `text()` buffer (16KB cap) + the `finish` frame;
  everything else is in `.omp/script-logs/`.
- Q: Proof a fix works? A: `bun test` — spawns the real `node --permission` sandbox,
  12 tests cover read/write/edit/grep/glob/bash/text, policy denials, sandbox escape,
  timeout, logging.

Confirmed-by: nhathoang
Confirmed-at: 2026-11-24T07:33:16Z
