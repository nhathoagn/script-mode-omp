import fs from "node:fs";
import path from "node:path";

/** Rough bytes-per-token ratio for mixed tool output. */
const BYTES_PER_TOKEN = 4;

export interface SessionSavings {
	/** Session this accumulator belongs to; reset when a new session starts. */
	sessionStarted: string;
	runs: number;
	bridgedCalls: number;
	/** Bytes tool results returned into the sandbox (would have entered context with direct calls). */
	bytesKeptInSandbox: number;
	/** Bytes text() actually sent to the model context. */
	bytesSentToContext: number;
	/** (bytesKeptInSandbox - bytesSentToContext) / BYTES_PER_TOKEN, floored at 0 per run. */
	tokensSavedEstimate: number;
}

export function emptySavings(): SessionSavings {
	return {
		sessionStarted: new Date().toISOString(),
		runs: 0,
		bridgedCalls: 0,
		bytesKeptInSandbox: 0,
		bytesSentToContext: 0,
		tokensSavedEstimate: 0,
	};
}

export function recordRun(s: SessionSavings, bytesIn: number, callCount: number, textBytes: number): void {
	s.runs += 1;
	s.bridgedCalls += callCount;
	s.bytesKeptInSandbox += bytesIn;
	s.bytesSentToContext += textBytes;
	s.tokensSavedEstimate += Math.max(0, Math.round((bytesIn - textBytes) / BYTES_PER_TOKEN));
}

export function formatSavingsLine(s: SessionSavings): string {
	return `[PTC session: ${s.runs} run(s), ${s.bridgedCalls} bridged call(s), ~${s.tokensSavedEstimate.toLocaleString("en-US")} tokens saved — .omp/script-logs/savings.json]`;
}

/** Persists cumulative totals; overwritten after every run so it is current even on crash. */
export function writeSavings(logDir: string, s: SessionSavings): void {
	try {
		fs.mkdirSync(logDir, { recursive: true });
		fs.writeFileSync(
			path.join(logDir, "savings.json"),
			JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2),
		);
	} catch {
		// Logging must never break a run.
	}
}
