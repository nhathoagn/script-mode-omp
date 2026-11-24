import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScript } from "../src/bridge";
import { defaultPolicy, type ScriptPolicy } from "../src/policy";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "script-mode-"));
const logDir = path.join(tmp, "logs");
const policy = (over: Partial<ScriptPolicy> = {}): ScriptPolicy => ({
	...defaultPolicy(tmp),
	...over,
});

fs.writeFileSync(path.join(tmp, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
fs.mkdirSync(path.join(tmp, "sub"));
fs.writeFileSync(path.join(tmp, "sub", "b.txt"), "one\ntwo\n", "utf8");

describe("runScript sandbox", () => {
	test("reads a file and prints distilled output", async () => {
		const r = await runScript(
			`const c = await read("a.txt");
			 text("lines=" + c.split("\\n").filter(Boolean).length);`,
			{ cwd: tmp, logDir, policy: policy() },
		);
		expect(r.ok).toBe(true);
		expect(r.text).toBe("lines=3");
		expect(r.callCount).toBe(2); // read + text
	});

	test("glob + grep in one program", async () => {
		const r = await runScript(
			`const files = await glob("**/*.txt");
			 const hits = await grep("beta", { root: "." });
			 text(JSON.stringify({ files: files.length, hasBeta: hits.includes("beta") }));`,
			{ cwd: tmp, logDir, policy: policy() },
		);
		expect(r.ok).toBe(true);
		const out = JSON.parse(r.text);
		expect(out.files).toBe(2);
		expect(out.hasBeta).toBe(true);
	});

	test("write + edit round trip stays inside root", async () => {
		const r = await runScript(
			`await write("out.txt", "hello");
			 await edit("out.txt", "hello", "world");
			 text(await read("out.txt"));`,
			{ cwd: tmp, logDir, policy: policy() },
		);
		expect(r.ok).toBe(true);
		expect(r.text.trim()).toBe("world");
		expect(fs.readFileSync(path.join(tmp, "out.txt"), "utf8")).toBe("world");
	});

	test("path outside root is rejected", async () => {
		const r = await runScript(`await read("/etc/hosts");`, {
			cwd: tmp,
			logDir,
			policy: policy(),
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("outside allowed root");
	});

	test("writes blocked when writable=false", async () => {
		const r = await runScript(`await write("x.txt", "no");`, {
			cwd: tmp,
			logDir,
			policy: policy({ writable: false }),
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("writes disabled");
	});

	test("denied bash pattern is rejected", async () => {
		const r = await runScript(`await bash("rm -rf .");`, {
			cwd: tmp,
			logDir,
			policy: policy(),
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("denied by policy");
	});

	test("bash runs and returns stdout", async () => {
		const r = await runScript(`text((await bash("echo hi")).trim());`, {
			cwd: tmp,
			logDir,
			policy: policy(),
		});
		expect(r.ok).toBe(true);
		expect(r.text).toBe("hi");
	});

	test("sandbox cannot touch require/process/fs", async () => {
		const r = await runScript(
			`try { require("fs") } catch (e) { text("require:" + e.constructor.name) }
			 try { console.log(typeof process === "undefined" ? "process:hidden" : "process:LEAKED") } catch {}
			 try { text(this.constructor.constructor("return typeof process")()) } catch (e) { text("escape:" + e.message.slice(0,40)) }`,
			{ cwd: tmp, logDir, policy: policy() },
		);
		expect(r.ok).toBe(true);
		expect(r.text).toContain("require:ReferenceError");
		expect(r.text).not.toContain("process:LEAKED");
	});

	test("script error surfaces with stack", async () => {
		const r = await runScript(`throw new Error("boom")`, {
			cwd: tmp,
			logDir,
			policy: policy(),
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("boom");
	});

	test("concurrent calls via Promise.all", async () => {
		const r = await runScript(
			`const [a, b] = await Promise.all([read("a.txt"), read("sub/b.txt")]);
			 text(a.length + b.length);`,
			{ cwd: tmp, logDir, policy: policy() },
		);
		expect(r.ok).toBe(true);
		expect(r.text).toBe(String("alpha\nbeta\ngamma\n".length + "one\ntwo\n".length));
	});

	test("timeout kills runaway script", async () => {
		const r = await runScript(`while (true) { await sleep(50) }`, {
			cwd: tmp,
			logDir,
			policy: policy({ maxScriptMs: 1500 }),
		});
		expect(r.ok).toBe(false);
		expect(r.timedOut).toBe(true);
	}, 10_000);

	test("log file captures calls and console output", async () => {
		const r = await runScript(`console.log("dbg", 1); await text("done");`, {
			cwd: tmp,
			logDir,
			policy: policy(),
		});
		expect(r.ok).toBe(true);
		const log = fs.readFileSync(r.logPath, "utf8");
		expect(log).toContain("dbg 1");
		expect(log).toContain("call");
	});
});
