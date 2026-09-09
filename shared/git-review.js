import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

/** Browser rendering limits. The frozen fingerprint still covers omitted content. */
export const REVIEW_LIMITS = Object.freeze({
	perFilePatchBytes: 200 * 1024,
	perFileDiffLines: 2_000,
	overallPatchBytes: 2 * 1024 * 1024,
	overallDiffLines: 10_000,
	maxManifestFiles: 500,
	maxCommentaryPerFile: 100,
	maxManifestString: 20_000,
});

async function git(cwd, args, signal) {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			signal,
		});
		return stdout;
	} catch (error) {
		const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
		throw new Error(stderr || error?.message || "Git command failed.");
	}
}

function createStreamAccumulator(retainBytes, sampleBytes = 8_192) {
	const retained = [];
	const sample = [];
	const hash = createHash("sha256");
	let retainedSize = 0;
	let sampleSize = 0;
	let totalBytes = 0;
	let newlineCount = 0;
	let lastByte;
	return {
		add(value) {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			hash.update(chunk);
			totalBytes += chunk.length;
			for (let index = 0; index < chunk.length; index++) if (chunk[index] === 10) newlineCount++;
			if (chunk.length) lastByte = chunk.at(-1);
			if (retainedSize < retainBytes) {
				const part = chunk.subarray(0, retainBytes - retainedSize);
				retained.push(part);
				retainedSize += part.length;
			}
			if (sampleSize < sampleBytes) {
				const part = chunk.subarray(0, sampleBytes - sampleSize);
				sample.push(part);
				sampleSize += part.length;
			}
		},
		finish() {
			return {
				retained: Buffer.concat(retained, retainedSize),
				sample: Buffer.concat(sample, sampleSize),
				totalBytes,
				totalLines: totalBytes === 0 ? 0 : newlineCount + (lastByte === 10 ? 0 : 1),
				hasFinalNewline: lastByte === 10,
				sha256: hash.digest("hex"),
			};
		},
	};
}

async function streamFile(path, retainBytes, signal) {
	const accumulator = createStreamAccumulator(retainBytes);
	const stream = createReadStream(path, { signal });
	for await (const chunk of stream) accumulator.add(chunk);
	return accumulator.finish();
}

function collectBuffer(bytes, retainBytes) {
	const accumulator = createStreamAccumulator(retainBytes);
	accumulator.add(bytes);
	return accumulator.finish();
}

async function streamGit(cwd, args, retainBytes, signal) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("git", ["-C", cwd, ...args], { signal, stdio: ["ignore", "pipe", "pipe"] });
		const accumulator = createStreamAccumulator(retainBytes);
		const stderr = [];
		let stderrSize = 0;
		let settled = false;
		child.stdout.on("data", (chunk) => accumulator.add(chunk));
		child.stderr.on("data", (chunk) => {
			if (stderrSize >= 64 * 1024) return;
			const part = chunk.subarray(0, 64 * 1024 - stderrSize);
			stderr.push(part);
			stderrSize += part.length;
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			rejectPromise(error);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			if (code === 0) resolvePromise(accumulator.finish());
			else rejectPromise(new Error(Buffer.concat(stderr, stderrSize).toString("utf8").trim() || `Git command failed with exit code ${code}.`));
		});
	});
}

function parseNameStatus(value) {
	const fields = value.split("\0");
	if (fields.at(-1) === "") fields.pop();
	const files = [];
	for (let index = 0; index < fields.length;) {
		const code = fields[index++];
		if (!code) break;
		const statusCode = code[0];
		if (statusCode === "R" || statusCode === "C") {
			const oldPath = fields[index++];
			const path = fields[index++];
			if (!oldPath || !path) throw new Error("Git returned an incomplete rename record.");
			files.push({ path, oldPath, status: statusCode === "R" ? "renamed" : "copied", statusCode: code });
		} else {
			const path = fields[index++];
			if (!path) throw new Error("Git returned an incomplete changed-file record.");
			const status = statusCode === "A" ? "added" : statusCode === "D" ? "deleted" : statusCode === "M" ? "modified" : "changed";
			files.push({ path, status, statusCode: code });
		}
	}
	return files;
}

function looksBinary(bytes) {
	const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
	if (sample.includes(0)) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(sample);
		return false;
	} catch {
		return true;
	}
}

function quoteDiffPath(path) {
	return path.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

function makeUntrackedPatchPrefix(path, data, mode) {
	const text = data.retained.toString("utf8");
	const sourceLines = text.split("\n");
	if (sourceLines.at(-1) === "") sourceLines.pop();
	const escaped = quoteDiffPath(path);
	const headerLines = [
		`diff --git a/${escaped} b/${escaped}`,
		`new file mode ${mode}`,
		"--- /dev/null",
		`+++ b/${escaped}`,
		`@@ -0,0 +1,${data.totalLines} @@`,
	];
	const retainedComplete = data.retained.length === data.totalBytes;
	const lines = [...headerLines, ...sourceLines.map((line) => `+${line}`)];
	if (retainedComplete && !data.hasFinalNewline && data.totalLines) lines.push("\\ No newline at end of file");
	const missingNewlineBytes = !data.hasFinalNewline && data.totalLines ? 1 + Buffer.byteLength("\\ No newline at end of file\n") : 0;
	return {
		patch: `${lines.join("\n")}\n`,
		patchBytes: Buffer.byteLength(`${headerLines.join("\n")}\n`) + data.totalBytes + data.totalLines + missingNewlineBytes,
		totalDiffLines: headerLines.length + data.totalLines + (!data.hasFinalNewline && data.totalLines ? 1 : 0),
		contentRetained: retainedComplete,
	};
}

/** Parse unified diff lines and retain old/new anchors. */
export function parseUnifiedPatch(patch, limits = REVIEW_LIMITS) {
	const sourceLines = patch.replace(/\n$/, "").split("\n");
	const rendered = [];
	let oldLine;
	let newLine;
	let consumedBytes = 0;
	let truncated = false;
	for (const content of sourceLines) {
		const bytes = Buffer.byteLength(`${content}\n`);
		if (rendered.length >= limits.perFileDiffLines || consumedBytes + bytes > limits.perFilePatchBytes) {
			truncated = true;
			break;
		}
		consumedBytes += bytes;
		const hunk = content.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			rendered.push({ kind: "hunk", content });
			continue;
		}
		if (oldLine !== undefined && newLine !== undefined && content.startsWith("+") && !content.startsWith("+++")) {
			rendered.push({ kind: "add", content: content.slice(1), newLine });
			newLine++;
		} else if (oldLine !== undefined && newLine !== undefined && content.startsWith("-") && !content.startsWith("---")) {
			rendered.push({ kind: "del", content: content.slice(1), oldLine });
			oldLine++;
		} else if (oldLine !== undefined && newLine !== undefined && content.startsWith(" ")) {
			rendered.push({ kind: "context", content: content.slice(1), oldLine, newLine });
			oldLine++;
			newLine++;
		} else {
			rendered.push({ kind: "meta", content });
		}
	}
	return {
		lines: rendered,
		truncated,
		patchBytes: Buffer.byteLength(patch),
		totalDiffLines: sourceLines.length,
		renderedBytes: consumedBytes,
	};
}

function parseCollectedPatch(data, limits, totals = {}) {
	const parsed = parseUnifiedPatch(data.retained.toString("utf8"), limits);
	return {
		...parsed,
		truncated: parsed.truncated || data.retained.length < data.totalBytes || totals.contentRetained === false,
		patchBytes: totals.patchBytes ?? data.totalBytes,
		totalDiffLines: totals.totalDiffLines ?? data.totalLines,
	};
}

async function collectTrackedPatch(root, file, limits, signal) {
	const pathspecs = file.oldPath ? [file.oldPath, file.path] : [file.path];
	return streamGit(root, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=3", "HEAD", "--", ...pathspecs], limits.perFilePatchBytes + 1, signal);
}

async function fingerprintWorktreePath(root, path, signal) {
	const absolutePath = resolve(root, path);
	let fileStat;
	try {
		fileStat = await lstat(absolutePath);
	} catch (error) {
		if (error?.code === "ENOENT") return { kind: "missing", sha256: "" };
		throw error;
	}
	if (fileStat.isSymbolicLink()) {
		const data = collectBuffer(Buffer.from(await readlink(absolutePath)), 0);
		return { kind: "symlink", sha256: data.sha256 };
	}
	if (fileStat.isFile()) {
		const data = await streamFile(absolutePath, 0, signal);
		return { kind: `file:${fileStat.mode & 0o777}`, sha256: data.sha256 };
	}
	return { kind: `special:${fileStat.mode}:${fileStat.size}`, sha256: "" };
}

/** Collect a frozen HEAD-to-worktree snapshot, including staged, unstaged, and untracked files. */
export async function collectReviewSnapshot(cwd, options = {}) {
	const limits = { ...REVIEW_LIMITS, ...(options.limits ?? {}) };
	let root;
	try {
		root = (await git(cwd, ["rev-parse", "--show-toplevel"], options.signal)).trim();
	} catch {
		throw new Error("Code review requires a Git repository.");
	}
	let head;
	try {
		head = (await git(root, ["rev-parse", "HEAD"], options.signal)).trim();
	} catch {
		throw new Error("Code review requires a repository with an existing HEAD commit.");
	}
	const tracked = parseNameStatus(await git(root, ["diff", "--name-status", "-z", "--find-renames", "HEAD", "--"], options.signal));
	const trackedPaths = new Set(tracked.flatMap((file) => [file.path, file.oldPath].filter(Boolean)));
	const untrackedPaths = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], options.signal))
		.split("\0").filter(Boolean).filter((path) => !trackedPaths.has(path));
	const records = [...tracked, ...untrackedPaths.map((path) => ({ path, status: "untracked", statusCode: "?" }))];
	if (!records.length) throw new Error("No staged, unstaged, or untracked changes found against HEAD.");

	const fingerprint = createHash("sha256").update(`head\0${head}\0`);
	const files = [];
	for (const record of records) {
		let binary = false;
		let parsed;
		if (record.status === "untracked") {
			const absolutePath = resolve(root, record.path);
			const fileStat = await lstat(absolutePath);
			const isSymlink = fileStat.isSymbolicLink();
			let data;
			if (isSymlink) data = collectBuffer(Buffer.from(await readlink(absolutePath)), limits.perFilePatchBytes + 1);
			else if (fileStat.isFile()) data = await streamFile(absolutePath, limits.perFilePatchBytes + 1, options.signal);
			else data = collectBuffer(Buffer.from(`special:${fileStat.mode}:${fileStat.size}`), limits.perFilePatchBytes + 1);
			binary = !isSymlink && (!fileStat.isFile() || looksBinary(data.sample));
			const mode = isSymlink ? "120000" : (fileStat.mode & 0o111) ? "100755" : "100644";
			fingerprint.update(`file\0${record.status}\0${record.path}\0${mode}\0`).update(Buffer.from(data.sha256, "hex"));
			if (binary) parsed = { lines: [], truncated: false, patchBytes: data.totalBytes, totalDiffLines: 0, renderedBytes: 0 };
			else {
				const synthetic = makeUntrackedPatchPrefix(record.path, data, mode);
				const patchData = { ...data, retained: Buffer.from(synthetic.patch), totalBytes: synthetic.patchBytes, totalLines: synthetic.totalDiffLines };
				parsed = parseCollectedPatch(patchData, limits, synthetic);
			}
		} else {
			const patchData = await collectTrackedPatch(root, record, limits, options.signal);
			const patchSample = patchData.sample.toString("utf8");
			binary = /(?:^|\n)Binary files .* differ(?:\n|$)/.test(patchSample) || /(?:^|\n)GIT binary patch(?:\n|$)/.test(patchSample);
			fingerprint.update(`file\0${record.statusCode}\0${record.oldPath ?? ""}\0${record.path}\0patch\0`).update(Buffer.from(patchData.sha256, "hex"));
			if (binary) {
				const worktree = await fingerprintWorktreePath(root, record.path, options.signal);
				fingerprint.update(`\0worktree\0${worktree.kind}\0`).update(worktree.sha256 ? Buffer.from(worktree.sha256, "hex") : Buffer.alloc(0));
				parsed = { lines: [], truncated: false, patchBytes: patchData.totalBytes, totalDiffLines: 0, renderedBytes: 0 };
			} else parsed = parseCollectedPatch(patchData, limits);
		}
		files.push({ ...record, binary, omitted: false, ...parsed });
	}
	return { root, head, id: fingerprint.digest("hex"), files };
}

function assertString(value, label, allowEmpty = false) {
	if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > REVIEW_LIMITS.maxManifestString) {
		throw new Error(`${label} must be a non-empty string of at most ${REVIEW_LIMITS.maxManifestString} characters.`);
	}
	return value.trim();
}

function normalizeOverview(overview) {
	if (overview === undefined) return undefined;
	if (!overview || typeof overview !== "object") throw new Error("Review overview must be an object.");
	const conciseString = (value, label) => {
		const normalized = assertString(value, label);
		if (normalized.length > 500) throw new Error(`${label} must contain at most 500 characters.`);
		return normalized;
	};
	const intent = conciseString(overview.intent, "Review overview intent");
	const list = (value, label, minimum, maximum) => {
		if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain ${minimum} to ${maximum} entries.`);
		return value.map((entry, index) => conciseString(entry, `${label} entry ${index + 1}`));
	};
	const changes = list(overview.changes, "Review overview changes", 2, 4);
	const validation = list(overview.validation, "Review overview validation", 1, 2);
	const reviewFocus = overview.reviewFocus === undefined ? undefined : conciseString(overview.reviewFocus, "Review overview focus");
	const risks = overview.risks === undefined ? undefined : conciseString(overview.risks, "Review overview risks");
	const words = [intent, ...changes, ...validation, reviewFocus, risks].filter(Boolean).join(" ").trim().split(/\s+/).filter(Boolean).length;
	if (words > 500) throw new Error("Review overview must contain at most 500 words.");
	return { intent, changes, validation, ...(reviewFocus ? { reviewFocus } : {}), ...(risks ? { risks } : {}) };
}

/** Validate the overview and commentary, apply agent ordering, and enforce rendering caps. */
export function applyReviewManifest(snapshot, manifest = {}, limits = REVIEW_LIMITS) {
	if (!manifest || typeof manifest !== "object") throw new Error("Review manifest must be an object.");
	const overview = normalizeOverview(manifest.overview);
	const requested = manifest.files ?? [];
	if (!Array.isArray(requested) || requested.length > REVIEW_LIMITS.maxManifestFiles) throw new Error(`Review manifest may contain at most ${REVIEW_LIMITS.maxManifestFiles} files.`);
	const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
	const used = new Set();
	const ordered = [];
	for (const item of requested) {
		if (!item || typeof item !== "object") throw new Error("Each manifest file must be an object.");
		const path = assertString(item.path, "Manifest file path");
		if (used.has(path)) throw new Error(`Manifest file path is duplicated: ${path}`);
		const file = byPath.get(path);
		if (!file) throw new Error(`Manifest path is not changed against HEAD: ${path}`);
		used.add(path);
		const summary = item.summary === undefined ? "" : assertString(item.summary, `Summary for ${path}`, true);
		const requestedReviewMode = item.reviewMode ?? "review";
		if (!["review", "reference"].includes(requestedReviewMode)) throw new Error(`Review mode for ${path} must be review or reference.`);
		const reviewMode = file.binary ? "reference" : requestedReviewMode;
		const entries = item.commentary ?? [];
		if (!Array.isArray(entries) || entries.length > REVIEW_LIMITS.maxCommentaryPerFile) throw new Error(`${path} may contain at most ${REVIEW_LIMITS.maxCommentaryPerFile} commentary entries.`);
		const ids = new Set();
		const commentary = entries.map((entry) => {
			if (!entry || typeof entry !== "object") throw new Error(`Commentary for ${path} must be an object.`);
			const id = assertString(entry.id, `Commentary id for ${path}`);
			if (ids.has(id)) throw new Error(`Commentary id is duplicated in ${path}: ${id}`);
			ids.add(id);
			const body = assertString(entry.body, `Commentary body for ${path}`);
			const side = entry.side ?? "both";
			if (!["old", "new", "both"].includes(side)) throw new Error(`Commentary ${id} has an invalid side.`);
			const startLine = entry.startLine;
			if (startLine === undefined && entry.endLine !== undefined) throw new Error(`Commentary ${id} cannot set endLine without startLine.`);
			const endLine = entry.endLine ?? startLine;
			if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) throw new Error(`Commentary ${id} has an invalid startLine.`);
			if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < startLine)) throw new Error(`Commentary ${id} has an invalid endLine.`);
			if (startLine !== undefined && file.binary) throw new Error(`Commentary ${id} cannot anchor to binary file ${path}.`);
			return { id, body, side, startLine, endLine };
		});
		ordered.push({ ...file, summary, reviewMode, commentary });
	}
	for (const file of snapshot.files) if (!used.has(file.path)) ordered.push({ ...file, summary: "", reviewMode: file.binary ? "reference" : "review", commentary: [] });

	let totalBytes = 0;
	let totalLines = 0;
	const cappedByPath = new Map();
	const allocationOrder = [
		...ordered.filter((file) => file.reviewMode !== "reference"),
		...ordered.filter((file) => file.reviewMode === "reference"),
	];
	for (const file of allocationOrder) {
		let rendered = file;
		if (!file.binary) {
			if (totalBytes + file.renderedBytes > limits.overallPatchBytes || totalLines + file.lines.length > limits.overallDiffLines) {
				rendered = { ...file, omitted: true, lines: [] };
			} else {
				totalBytes += file.renderedBytes;
				totalLines += file.lines.length;
			}
		}
		cappedByPath.set(file.path, rendered);
	}
	const capped = ordered.map((file) => cappedByPath.get(file.path));
	for (const file of capped) {
		for (const entry of file.commentary) {
			if (entry.startLine === undefined) continue;
			if (file.omitted) throw new Error(`Commentary ${entry.id} does not anchor to a visible ${entry.side} line in ${file.path}.`);
			const boundaryIsVisible = (targetLine) => file.lines.some((line) => {
				const oldMatches = entry.side !== "new" && line.oldLine === targetLine;
				const newMatches = entry.side !== "old" && line.newLine === targetLine;
				return oldMatches || newMatches;
			});
			if (!boundaryIsVisible(entry.startLine) || !boundaryIsVisible(entry.endLine)) {
				throw new Error(`Commentary ${entry.id} does not anchor to a visible complete ${entry.side} range in ${file.path}.`);
			}
		}
	}
	const title = manifest.title === undefined ? "Code review" : assertString(manifest.title, "Review title");
	return { ...snapshot, title, overview, files: capped, renderedBytes: totalBytes, renderedLines: totalLines };
}
