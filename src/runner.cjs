"use strict";
/*
 * Sandbox runner. Executes inside `node --permission` with fs access limited
 * to this file and the user code file. All tool access goes through the
 * JSON-RPC channel on stdin/stdout, served by the host bridge.
 *
 * Wire protocol (one JSON object per line):
 *   out: {"id": n, "op": "read", "args": {...}}   -> host replies {"id": n, "result": ...}
 *   out: {"t": "finish", "ok": bool, "error"?: str, "value"?: any}
 *   in : {"id": n, "result": any} | {"id": n, "error": str}
 */
const fs = require("node:fs");
const vm = require("node:vm");
const readline = require("node:readline");

const codePath = process.argv[2];
const code = fs.readFileSync(codePath, "utf8");

const pending = new Map();
let nextId = 0;

function sendRaw(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// Outer (host-realm) invoke: gives a real outer Promise the in-realm
// wrapper awaits. Never exposed to user code — the prelude deletes the
// binding inside the context, and the outer `inv` stays a closure.
function inv(op, args) {
	return new Promise(res => {
		const id = nextId++;
		pending.set(id, res);
		sendRaw({ id, op, args });
	});
}

readline
	.createInterface({ input: process.stdin })
	.on("line", line => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		const entry = pending.get(msg.id);
		if (!entry) return;
		pending.delete(msg.id);
		entry(msg.error ? { error: msg.error } : { result: msg.result });
	});

const PRELUDE = `
const __inv = globalThis.__omp_invoke;
delete globalThis.__omp_invoke;
globalThis.__omp_rpc = (op, args) => new Promise((resolve, reject) => {
	__inv(op, args).then(
		r => (r.error ? reject(new Error(r.error)) : resolve(r.result)),
		reject,
	);
});
const __rpc = globalThis.__omp_rpc;
Object.defineProperty(globalThis, "read",  { value: p => __rpc("read", { path: p }) });
Object.defineProperty(globalThis, "write", { value: (p, content) => __rpc("write", { path: p, content }) });
Object.defineProperty(globalThis, "edit",  { value: (p, from, to, opts) => __rpc("edit", { path: p, from, to, ...(opts ?? {}) }) });
Object.defineProperty(globalThis, "grep",  { value: (pattern, opts) => __rpc("grep", { pattern, ...(opts ?? {}) }) });
Object.defineProperty(globalThis, "glob",  { value: (pattern, opts) => __rpc("glob", { pattern, ...(opts ?? {}) }).then(r => r.matches) });
Object.defineProperty(globalThis, "bash",  { value: (command, opts) => __rpc("bash", { command, ...(opts ?? {}) }) });
Object.defineProperty(globalThis, "text",  { value: s => __rpc("text", { s: typeof s === "string" ? s : JSON.stringify(s, null, 2) }) });
Object.defineProperty(globalThis, "sleep", { value: ms => __rpc("sleep", { ms }) });
console.log = console.info = (...a) => __rpc("log", { s: a.map(String).join(" ") });
console.warn = console.error = (...a) => __rpc("log", { s: "[warn] " + a.map(String).join(" ") });
console.debug = (...a) => __rpc("log", { s: "[debug] " + a.map(String).join(" ") });
`;

const context = vm.createContext({}, { name: "omp-script-sandbox" });
context.__omp_invoke = inv.bind(undefined);

function finish(ok, error, value) {
	sendRaw(error ? { t: "finish", ok: false, error: String(error) } : { t: "finish", ok, value });
	// Drain: give stdout a beat, then exit. Pending RPC calls die with us.
	setTimeout(() => process.exit(ok ? 0 : 1), 20).unref();
}

let serialized;
try {
	vm.runInContext(PRELUDE, context, { filename: "prelude.js" });
	if (context.__omp_invoke !== undefined) {
		throw new Error("sandbox setup failed: invoke binding still visible");
	}
	serialized = `(async () => { ${code}\n })()`;
} catch (err) {
	finish(false, `sandbox init: ${err && err.message ? err.message : err}`);
	return;
}

Promise.resolve()
	.then(() => vm.runInContext(serialized, context, { filename: "user-script.js" }))
	.then(
		value => finish(true, undefined, value),
		err => finish(false, err && err.stack ? String(err.stack).slice(0, 4000) : String(err)),
	);
