import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Review sessions persist as one JSON file each so a pi restart can resurrect
// them: rounds, threads, delivery state, auth material, and the port the open
// browser tab is retrying against. Files contain diff content, so the
// directory and every file are owner-only.

export const SESSION_VERSION = 1;
export const BOOT_HEAL_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const SWEEP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const sessionsDir = () => process.env.PI_MARGINALIA_SESSIONS_DIR || join(homedir(), ".pi", "marginalia", "sessions");
const sessionPath = (id) => join(sessionsDir(), `${id}.json`);

export async function saveSession(state) {
	const dir = sessionsDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const target = sessionPath(state.id);
	const scratch = `${target}.tmp-${process.pid}`;
	await writeFile(scratch, JSON.stringify(state), { mode: 0o600 });
	await rename(scratch, target);
}

export async function loadSession(id) {
	try {
		const parsed = JSON.parse(await readFile(sessionPath(id), "utf8"));
		return parsed && parsed.version === SESSION_VERSION ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function deleteSession(id) {
	await unlink(sessionPath(id)).catch(() => {});
}

export async function listSessions() {
	let names;
	try {
		names = await readdir(sessionsDir());
	} catch {
		return [];
	}
	const sessions = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const loaded = await loadSession(name.slice(0, -5));
		if (loaded) sessions.push(loaded);
	}
	return sessions;
}

// A live pi process claims the sessions it is serving by recording its pid;
// another pi booting concurrently must not double-spawn them.
export const isClaimed = (state) => {
	if (typeof state.pid !== "number" || state.pid === process.pid) return false;
	try {
		process.kill(state.pid, 0);
		return true;
	} catch (error) {
		// EPERM answers the liveness question: the process exists but belongs
		// to someone else.
		return error && error.code === "EPERM";
	}
};

// Terminal sessions and long-abandoned ones age out of the store entirely.
export async function sweepSessions(now = Date.now()) {
	const removed = [];
	for (const state of await listSessions()) {
		const terminal = state.phase === "approved" || state.phase === "closed";
		const stale = now - (state.lastActive ?? 0) > SWEEP_MAX_AGE_MS;
		if ((terminal || stale) && !isClaimed(state)) {
			await deleteSession(state.id);
			removed.push(state.id);
		}
	}
	return removed;
}
