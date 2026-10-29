import { DEFAULT_IDLE_MIN, idleReuse, parseIdleMs, parseMaxSessions, UPSTREAM_IDLE_MIN } from "./fork-extensions.ts";

export type LiveProcess = { readonly owner: symbol; readonly sessionId: string | undefined; toolCallIds: string[]; kill(): void };

// Tools usually call back within seconds, but a question tool holds its call until the learner
// answers. Past this, the process is killed and the answer starts a fresh one with a full replay.
// It stays under MCP_TOOL_TIMEOUT so the process is killed before the CLI gives up on its own.
// Fork (owner, M11 Q3): LH_CLAUDE_IDLE_MIN overrides the idle limit (default 40 minutes with LH_CLAUDE_IDLE_REUSE=1, upstream's 10 without); and at most LH_CLAUDE_CODE_MAX_SESSIONS
// live processes are kept (oldest killed first). See fork-extensions.ts.
export const LIVE_PROCESS_IDLE_TIMEOUT_MS = parseIdleMs(globalThis.process?.env?.LH_CLAUDE_IDLE_MIN, idleReuse.current ? DEFAULT_IDLE_MIN : UPSTREAM_IDLE_MIN);

/** Test seam. */
export const maxLiveProcesses = { current: parseMaxSessions(globalThis.process?.env?.LH_CLAUDE_CODE_MAX_SESSIONS) };

/** Test seam (runner.ts's pdfModelOverride idiom). */
export const liveProcessIdleTimeoutMs = { current: LIVE_PROCESS_IDLE_TIMEOUT_MS };

// Each live process mapped to the timer that kills it if pi never calls back.
const liveProcesses = new Map<LiveProcess, NodeJS.Timeout>();

export function addLiveProcess(process: LiveProcess): void {
	removeLiveProcess(process);
	const timer = setTimeout(() => {
		removeLiveProcess(process);
		process.kill();
	}, liveProcessIdleTimeoutMs.current);

	timer.unref();

	liveProcesses.set(process, timer);

	// fork: a cap on what is kept (each holds a model conversation); the oldest goes first
	while (liveProcesses.size > maxLiveProcesses.current) {
		const oldest = liveProcesses.keys().next().value;
		if (!oldest || oldest === process) break;
		removeLiveProcess(oldest);
		oldest.kill();
	}
}

function hasSameIds(ids: string[], otherIds: string[]): boolean {
	return ids.length === otherIds.length && new Set(otherIds).size === otherIds.length && ids.every((id) => otherIds.includes(id));
}

export function getLiveProcess(toolCallIds: string[], owner: symbol, sessionId: string | undefined): LiveProcess | null {
	if (!sessionId || toolCallIds.length === 0) return null;

	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId && hasSameIds(process.toolCallIds, toolCallIds)) return process;
	}

	return null;
}

/** Fork (idle reuse): the process of this session that finished a plain answer and waits for the next user message. */
export function getIdleProcess(owner: symbol, sessionId: string | undefined): LiveProcess | null {
	if (!sessionId) return null;
	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId && process.toolCallIds.length === 0) return process;
	}
	return null;
}

export function removeLiveProcess(process: LiveProcess): void {
	clearTimeout(liveProcesses.get(process));
	liveProcesses.delete(process);
}
