import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { runScript, type ScriptRunResult } from "./bridge";
import { loadPolicy } from "./policy";

const RISKY_SOURCE = /\b(rm\s+-|sudo\b|curl|wget|ssh\b|scp\b|>\s*\/)/;

const DESCRIPTION = `Run one async JS program that batches host-tool calls inside a Node sandbox; only text() output reaches your context.

USE ONLY for ≥4 same-shape calls or >10KB of tool output — otherwise call the host tools directly, it is cheaper.

Async helpers: read(path), write(path,content), edit(path,from,to,{all}), grep(pattern,{root,glob}), glob(pattern,{root}), bash(command,{timeoutMs}), text(s), sleep(ms). Prefer Promise.all for independent calls.

Keep raw results in variables; text() only the distilled answer (≤16KB). No require/process/fs. Paths confined to project root; bash() has a policy denylist; .omp/script-mode.json extends policy.`;

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
					? (r.text || "(script finished; nothing printed — see log file)") +
						(r.callCount <= 3 && r.bytesIn < 8192
							? `\n[script note: ${r.callCount} bridged call(s), ${r.bytesIn}B kept in sandbox — direct tool calls would have cost fewer tokens here]`
							: "")
					: `script failed: ${r.error}\n${r.text}`,
			},
		],
		details: {
			ok: r.ok,
			error: r.error,
			value: r.value,
			bytesIn: r.bytesIn,
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
		loadMode: "essential",
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
							bytesIn: 0,
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
