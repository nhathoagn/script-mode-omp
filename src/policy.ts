import fs from "node:fs";
import path from "node:path";

export interface ScriptPolicy {
	/** Absolute root every file op must resolve under. Defaults to session cwd. */
	root: string;
	/** Extra absolute dirs readable/writable beyond root. */
	allowPaths: string[];
	/** In-script file writes allowed. */
	writable: boolean;
	/** `bash()` allowed inside scripts. */
	allowBash: boolean;
	/** Regexes matched against bash commands -> rejected before execution. */
	bashDeny: string[];
	/** Max size of one tool result returned into the sandbox (bytes). */
	maxResultBytes: number;
	/** Max size of text() buffer reaching the model context (bytes). */
	maxTextBytes: number;
	/** Per-bash-call timeout (ms). */
	bashTimeoutMs: number;
	/** Whole-script wall-clock limit (ms). */
	maxScriptMs: number;
}

const DEFAULT_BASH_DENY = [
	`\\brm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)*[^|;&]*`,
	`\\bsudo\\b`,
	`\\bgit\\s+push\\b[^|;&]*--force`,
	`\\bgit\\s+push\\s+-f\\b`,
	`\\bmkfs\\b`,
	`\\bdd\\s+.*of=/dev/`,
	`\\bshutdown\\b|\\breboot\\b|\\bhalt\\b`,
	`\\b:\\(\\)\\s*{`,
	`\\bcurl\\b[^|]*\\|\\s*(ba)?sh\\b`,
	`\\bwget\\b[^|]*\\|\\s*(ba)?sh\\b`,
	`>\\s*/etc/`,
	`\\bchmod\\s+777\\s+/`,
	`\\bnpm\\s+publish\\b|\\bbun\\s+publish\\b`,
];

export function defaultPolicy(cwd: string): ScriptPolicy {
	return {
		root: cwd,
		allowPaths: [],
		writable: true,
		allowBash: true,
		bashDeny: DEFAULT_BASH_DENY,
		maxResultBytes: 256 * 1024,
		maxTextBytes: 16 * 1024,
		bashTimeoutMs: 150_000,
		maxScriptMs: 480_000,
	};
}

const POLICY_FILE = "script-mode.json";

/** Reads `.omp/script-mode.json` from the project root; missing/invalid -> defaults. */
export function loadPolicy(cwd: string): ScriptPolicy {
	const base = defaultPolicy(cwd);
	const file = path.join(cwd, ".omp", POLICY_FILE);
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ScriptPolicy>;
		return {
			...base,
			...raw,
			root: raw.root ? path.resolve(cwd, raw.root) : base.root,
			allowPaths: (raw.allowPaths ?? []).map(p => path.resolve(cwd, p)),
			bashDeny: raw.bashDeny ?? base.bashDeny,
		};
	} catch {
		return base;
	}
}

export function deniedBashCommand(command: string, policy: ScriptPolicy): string | undefined {
	for (const pattern of policy.bashDeny) {
		try {
			if (new RegExp(pattern, "i").test(command)) return pattern;
		} catch {
			// invalid user pattern: ignore
		}
	}
	return undefined;
}

/** Resolves `p` against root, follows existing symlinks, verifies containment. */
export function resolveInside(p: string, policy: ScriptPolicy): string {
	const abs = path.resolve(policy.root, p);
	const roots = [policy.root, ...policy.allowPaths];
	const inRoot = roots.some(r => abs === r || abs.startsWith(r + path.sep));
	if (!inRoot) throw new Error(`path outside allowed root: ${p}`);

	// Realpath the deepest existing ancestor to catch symlink escapes.
	let probe = abs;
	while (!fs.existsSync(probe)) {
		const parent = path.dirname(probe);
		if (parent === probe) break;
		probe = parent;
	}
	const real = fs.realpathSync(probe);
	const under = roots.some(r => {
		const rr = safeRealpath(r);
		return real === rr || real.startsWith(rr + path.sep);
	});
	if (!under) throw new Error(`path escapes allowed root via symlink: ${p}`);
	return abs;
}

function safeRealpath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}
