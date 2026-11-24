import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { runScript, type ScriptRunResult } from "./bridge";
import { loadPolicy } from "./policy";

const RISKY_SOURCE = /\b(rm\s+-|sudo\b|curl|wget|ssh\b|scp\b|>\s*\/)/;

const DESCRIPTION = `Run a JavaScript program that calls host tools from inside a sandboxed Node process (programmatic tool calling).

Use this instead of many sequential tool calls when a task repeats the same call shape (per file, per test, per ticket), filters or aggregates large tool output, or follows a deterministic loop. One script = one model round-trip no matter how many calls it makes.

Sandbox helpers (all async — await them):
  read(path)                      -> file contents (string)
  write(path, content)            -> { path, bytes }
  edit(path, from, to, {all})     -> string replace; fails unless unique or all:true
  grep(pattern, {root, glob})     -> rg output (string)
  glob(pattern, {root})           -> string[] of matches
  bash(command, {timeoutMs})      -> stdout(+stderr on failure)
  text(s)                         -> print to YOUR context (the only data you see)
  sleep(ms)

Everything else stays inside the program as variables and never enters your context — keep raw file contents, search hits, and command output in variables, then text() only the distilled result. console.log goes to a log file, not to you. Independent calls run concurrently with Promise.all / Promise.allSettled.

text() is capped (~16KB) and individual results are capped (~256KB); the full run log lands in .omp/script-logs/ and you can read() or grep() it afterwards.

Paths are confined to the project root. bash() has a policy denylist; .omp/script-mode.json can extend policy (root, allowPaths, writable, allowBash, bashDeny, maxScriptMs).`;

interface Job {
	id: string;
	label?: string;
	started: number;
	state: "running" | "done" | "failed" | "cancelled";
	controller: AbortController;
	result?: ScriptRunResult;
}

export default function (pi: ExtensionAPI) {
	const z = pi.zod;
	const jobs = new Map<string, Job>();
	let seq = 0;
	let cwd = ".";
	let sendWake: ((job: Job) => void) | undefined;

	const logDir = () => path.join(cwd, ".omp", "script-logs");

	const runJob = async (code: string, signal?: AbortSignal): Promise<ScriptRunResult> =>
		runScript(code, { cwd, logDir: logDir(), policy: loadPolicy(cwd) }, signal);

	const formatResult = (r: ScriptRunResult) => ({
		content: [
			{
				type: "text" as const,
				text: r.ok
					? r.text || "(script finished; nothing printed — see log file)"
					: `script failed: ${r.error}\n${r.text}`,
			},
		],
		details: {
			ok: r.ok,
			error: r.error,
			value: r.value,
			callCount: r.callCount,
			durationMs: r.durationMs,
			logPath: r.logPath,
			timedOut: r.timedOut,
		},
	});

	const scriptParams = z.object({
		code: z.string().describe("JavaScript program; async helpers in scope; top-level code may use await via async wrapper semantics"),
		background: z
			.boolean()
			.optional()
			.describe("true: run detached and return a job id; you are woken when it finishes"),
		label: z.string().optional().describe("short job label for status reporting"),
	});

	const scriptDef: ToolDefinition<typeof scriptParams> = {
		name: "script",
		label: "Script (PTC)",
		description: DESCRIPTION,
		parameters: scriptParams,
		approval: (args: unknown) => {
			const code =
				args && typeof args === "object" && "code" in args && typeof args.code === "string"
					? args.code
					: "";
			return RISKY_SOURCE.test(code)
				? { tier: "exec", override: true, reason: "script contains shell/destructive-looking code; review the source" }
				: "exec";
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			cwd = ctx.cwd;
			sendWake = job =>
				pi.sendUserMessage(
					`[script job ${job.id}${job.label ? ` "${job.label}"` : ""} finished: ${job.state}${
						job.result?.error ? ` — ${job.result.error}` : ""
					}. Log: ${job.result?.logPath}. Result text: ${job.result?.text?.slice(0, 2000) ?? "(none)"}`,
					{ deliverAs: "aside", attribution: "agent" },
				);

			if (params.background) {
				const id = `job-${++seq}`;
				const job: Job = {
					id,
					label: params.label,
					started: Date.now(),
					state: "running",
					controller: new AbortController(),
				};
				jobs.set(id, job);
				void runJob(params.code, job.controller.signal)
					.then(r => {
						job.state = r.ok ? "done" : "failed";
						job.result = r;
					})
					.catch((e: unknown) => {
						job.state = "failed";
						job.result = undefined;
						job.result = {
							ok: false,
							text: "",
							callCount: 0,
							durationMs: Date.now() - job.started,
							logPath: "",
							error: e instanceof Error ? e.message : String(e),
						};
					})
					.finally(() => sendWake?.(job));
				return {
					content: [
						{
							type: "text" as const,
							text: `background job ${id} started${params.label ? ` (${params.label})` : ""}. You will be notified when it finishes; check progress with script_status.`,
						},
					],
					details: { jobId: id },
				};
			}

			const result = await runJob(params.code, signal);
			return formatResult(result);
		},
		onSession(event) {
			if (event.reason === "shutdown") {
				for (const job of jobs.values()) {
					if (job.state === "running") {
						job.state = "cancelled";
						job.controller.abort();
					}
				}
				jobs.clear();
			}
		},
	};

	pi.registerTool(scriptDef);

	const statusParams = z.object({
		jobId: z.string(),
		tail: z.number().optional().describe("last N bytes of the run log to include"),
	});
	const statusDef: ToolDefinition<typeof statusParams> = {
		name: "script_status",
		label: "Script Status",
		description: "Check a background script job's state and tail its output.",
		parameters: statusParams,
		approval: "read",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const job = jobs.get(params.jobId);
			if (!job) {
				return { content: [{ type: "text" as const, text: `unknown job: ${params.jobId}` }] };
			}
			let logTail = "";
			if (params.tail && job.result?.logPath) {
				try {
					const buf = await Bun.file(job.result.logPath).text();
					logTail = `\n--- log tail ---\n${buf.slice(-params.tail)}`;
				} catch {
					// log file may not exist yet
				}
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `job ${job.id}: ${job.state} (${Math.round((Date.now() - job.started) / 1000)}s)${
							job.result ? `, ${job.result.callCount} calls, ${job.result.durationMs}ms` : ""
						}${job.result?.error ? `\nerror: ${job.result.error}` : ""}${
							job.result?.text ? `\n${job.result.text}` : ""
						}${logTail}`,
					},
				],
				details: {
					jobId: job.id,
					state: job.state,
					label: job.label,
					result: job.result,
				},
			};
		},
	};
	pi.registerTool(statusDef);

	const cancelParams = z.object({ jobId: z.string() });
	const cancelDef: ToolDefinition<typeof cancelParams> = {
		name: "script_cancel",
		label: "Script Cancel",
		description: "Cancel a running background script job.",
		parameters: cancelParams,
		approval: "exec",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const job = jobs.get(params.jobId);
			if (!job || job.state !== "running") {
				return {
					content: [{ type: "text" as const, text: `job ${params.jobId} is not running` }],
				};
			}
			job.state = "cancelled";
			job.controller.abort();
			return { content: [{ type: "text" as const, text: `cancelled ${job.id}` }] };
		},
	};
	pi.registerTool(cancelDef);
}
