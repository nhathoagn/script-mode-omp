import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
	deniedBashCommand,
	resolveInside,
	type ScriptPolicy,
} from "./policy";

export interface ScriptRunResult {
	ok: boolean;
	/** text() output destined for the model context. */
	text: string;
	/** Script's printed value from the implicit `return` (serialized). */
	value?: unknown;
	/** Number of bridged tool calls the script made. */
	callCount: number;
	/** Wall-clock duration. */
	durationMs: number;
	/** Absolute path of the full run log (all calls + console output). */
	logPath: string;
	error?: string;
	timedOut?: boolean;
}

export interface BridgeDeps {
	cwd: string;
	policy: ScriptPolicy;
	logDir: string;
	/** Optional progress callback: in-sandbox tool calls so far. */
	onProgress?: (callCount: number) => void;
	spawnImpl?: typeof spawn;
}

interface RpcRequest {
	id: number;
	op: string;
	args: unknown;
}

interface RpcResponse {
	id: number;
	result?: unknown;
	error?: string;
}

const OPS = new Set([
	"read", "write", "edit", "grep", "glob", "bash",
	"text", "log", "sleep",
]);

/**
 * Runs one script in `node --permission` sandbox and serves its JSON-RPC
 * tool calls on stdio. stdout of the child is the RPC channel; anything the
 * script prints through console.* arrives as `log` calls and lands in the
 * run log, not in the model context.
 */
export async function runScript(
	code: string,
	deps: BridgeDeps,
	signal?: AbortSignal,
): Promise<ScriptRunResult> {
	const { cwd, policy, spawnImpl = spawn } = deps;
	const started = Date.now();
	fs.mkdirSync(deps.logDir, { recursive: true });

	const runId = `run-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const logPath = path.join(deps.logDir, `${runId}.log`);
	const codePath = path.join(deps.logDir, `${runId}.code.js`);
	fs.writeFileSync(codePath, code, "utf8");
	const log = fs.createWriteStream(logPath, { flags: "a" });
	const logLine = (s: string) => log.write(`[${new Date().toISOString()}] ${s}\n`);

	const runnerPath = new URL("./runner.cjs", import.meta.url);
	const child = spawnImpl("node", nodeSandboxArgs(runnerPath.pathname, codePath), {
		cwd,
		env: { NODE_DISABLE_COMPILE_CACHE: "1", PATH: process.env.PATH ?? "/usr/bin:/bin" },
		stdio: ["pipe", "pipe", "pipe"],
	});

	let callCount = 0;
	let textBuf = "";
	let textTruncated = false;
	let finished: { ok: boolean; error?: string } | undefined;
	let finishedValue: unknown;
	let childExited = false;

	const rl = createInterface({ input: child.stdout! });

	const respond = (id: number, res: RpcResponse["result"], error?: string) => {
		if (childExited || !child.stdin?.writable) return;
		child.stdin.write(`${JSON.stringify(error ? { id, error } : { id, result: res })}\n`);
	};

	const dispatch = async (op: string, args: Record<string, unknown>): Promise<unknown> => {
		switch (op) {
			case "read":
				return cap(await fsp.readFile(resolveInside(String(args.path), policy), "utf8"), policy);
			case "write": {
				requireWritable(policy);
				const abs = resolveInside(String(args.path), policy);
				await fsp.mkdir(path.dirname(abs), { recursive: true });
				await fsp.writeFile(abs, String(args.content), "utf8");
				return { path: abs, bytes: Buffer.byteLength(String(args.content)) };
			}
			case "edit": {
				requireWritable(policy);
				const abs = resolveInside(String(args.path), policy);
				const src = await fsp.readFile(abs, "utf8");
				const from = String(args.from);
				const to = String(args.to ?? "");
				const count = src.split(from).length - 1;
				if (count === 0) throw new Error(`edit: string not found in ${args.path}`);
				if (count > 1 && args.all !== true)
					throw new Error(`edit: string occurs ${count}x in ${args.path}; pass all:true or disambiguate`);
				await fsp.writeFile(abs, args.all === true ? src.split(from).join(to) : src.replace(from, to), "utf8");
				return { path: abs, replaced: args.all === true ? count : 1 };
			}
			case "grep": {
				const pat = String(args.pattern);
				const root = resolveInside(String(args.root ?? "."), policy);
				const glob = args.glob ? String(args.glob) : undefined;
				return cap(await runBash(
					`rg --line-number --no-heading ${glob ? `--glob ${sh(glob)} ` : ""}-- ${sh(pat)} ${sh(root)} || true`,
					policy, 60_000,
				), policy);
			}
			case "glob": {
				const root = resolveInside(String(args.root ?? "."), policy);
				const matches: string[] = [];
				let truncated = false;
				for await (const m of fsp.glob(String(args.pattern), { cwd: root })) {
					if (matches.length >= 2000) { truncated = true; break; }
					matches.push(m);
				}
				return { matches, truncated };
			}
			case "bash": {
				if (!policy.allowBash) throw new Error("bash() disabled by policy");
				const cmd = String(args.command);
				const deny = deniedBashCommand(cmd, policy);
				if (deny) throw new Error(`bash() denied by policy pattern: ${deny}`);
				return cap(await runBash(cmd, policy, Number(args.timeoutMs) || policy.bashTimeoutMs), policy);
			}
			case "text": {
				const s = String(args.s ?? "");
				logLine(`text> ${s}`);
				if (textBuf.length < policy.maxTextBytes) {
					textBuf += (textBuf ? "\n" : "") + s;
					if (textBuf.length > policy.maxTextBytes) {
						textBuf = textBuf.slice(0, policy.maxTextBytes);
						textTruncated = true;
					}
				} else textTruncated = true;
				return undefined;
			}
			case "log":
				logLine(`log> ${String(args.s ?? "")}`);
				return undefined;
			case "sleep":
				await new Promise(r => setTimeout(r, Math.min(Number(args.ms) || 0, 30_000)));
				return undefined;
			default:
				throw new Error(`unknown op: ${op}`);
		}
	};

	rl.on("line", line => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line);
		} catch {
			logLine(`bad-frame> ${line.slice(0, 500)}`);
			return;
		}
		if (msg.t === "finish") {
			finished = { ok: msg.ok === true, error: typeof msg.error === "string" ? msg.error : undefined };
			finishedValue = msg.value;
			return;
		}
		const req = msg as unknown as RpcRequest;
		if (typeof req.id !== "number" || typeof req.op !== "string" || !OPS.has(req.op)) {
			logLine(`bad-req> ${line.slice(0, 500)}`);
			return;
		}
		callCount++;
		deps.onProgress?.(callCount);
		logLine(`call ${req.id} ${req.op} ${JSON.stringify(req.args).slice(0, 800)}`);
		dispatch(req.op, (req.args ?? {}) as Record<string, unknown>)
			.then(res => respond(req.id, res))
			.catch((err: unknown) => respond(req.id, undefined, err instanceof Error ? err.message : String(err)));
	});

	const stderr: string[] = [];
	child.stderr?.on("data", d => stderr.push(String(d)));

	const kill = () => {
		if (!childExited) {
			try { child.kill("SIGKILL"); } catch { /* gone */ }
		}
	};

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, policy.maxScriptMs);
	timer.unref?.();

	const onAbort = () => kill();
	signal?.addEventListener("abort", onAbort, { once: true });

	const { promise: exitPromise, resolve: onExit } = Promise.withResolvers<void>();
	child.on("exit", () => {
		childExited = true;
		onExit();
	});
	child.on("error", () => {
		childExited = true;
		onExit();
	});
	await exitPromise;

	clearTimeout(timer);
	signal?.removeEventListener("abort", onAbort);
	logLine(`--- end calls=${callCount} timedOut=${timedOut}`);
	log.end();

	const errText = stderr.join("").trim();
	let error: string | undefined;
	if (finished && !finished.ok) error = finished.error ?? "script failed";
	if (!finished && !timedOut) error = errText || "script exited without finishing";
	if (timedOut) error = `script exceeded ${policy.maxScriptMs}ms limit`;
	if (signal?.aborted) error = "aborted";

	if (textTruncated) textBuf += "\n[output truncated: full results in log file]";

	return {
		ok: error === undefined,
		text: textBuf,
		value: finishedValue,
		callCount,
		durationMs: Date.now() - started,
		logPath,
		error,
		timedOut,
	};
}

function cap(s: string, policy: ScriptPolicy): string {
	return s.length > policy.maxResultBytes
		? `${s.slice(0, policy.maxResultBytes)}\n[result truncated at ${policy.maxResultBytes} bytes]`
		: s;
}

function requireWritable(policy: ScriptPolicy): void {
	if (!policy.writable) throw new Error("writes disabled by policy (writable: false)");
}

function sh(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function runBash(cmd: string, policy: ScriptPolicy, timeoutMs: number): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn("bash", ["-lc", cmd], { cwd: policy.root, env: process.env });
	const out: string[] = [];
	const err: string[] = [];
	child.stdout?.on("data", (d: Buffer) => out.push(String(d)));
	child.stderr?.on("data", (d: Buffer) => err.push(String(d)));
	const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	child.on("exit", (code: number | null) => {
		clearTimeout(t);
		const body = out.join("") + (err.length ? `\n[stderr]\n${err.join("")}` : "");
		resolve(code === 0 ? body : `${body}\n[exit ${code}]`);
	});
	child.on("error", reject);
	return promise;
}


function nodeSandboxArgs(runnerPath: string, codePath: string): string[] {
	return [
		"--permission",
		`--allow-fs-read=${runnerPath}`,
		`--allow-fs-read=${codePath}`,
		runnerPath,
		codePath,
	];
}
