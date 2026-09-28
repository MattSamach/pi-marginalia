// End-to-end check of the /margin-doc command: drives a real pi process in
// RPC mode with only this extension loaded, invokes the command against a
// markdown file on disk, and verifies the served document review. The bare
// (latest-response) variant is exercised for its graceful empty-branch path;
// producing a real assistant message would require a model call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Never let test servers persist sessions into the real user store.
process.env.PI_MARGINALIA_SESSIONS_DIR ??= await mkdtemp(join(tmpdir(), "marginalia-test-sessions-"));

if (process.platform === "win32") {
	console.log("margin-doc RPC check is skipped on Windows.");
	process.exit(0);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "pi-marginalia-margin-doc-"));
const bin = join(root, "bin");
const openLog = join(root, "open.log");
await mkdir(bin);
await writeFile(join(bin, "cmux"), '#!/bin/sh\nprintf "%s\\n" "$3" >> "$PCR_OPEN_LOG"\n');
await chmod(join(bin, "cmux"), 0o755);
await writeFile(openLog, "");
await writeFile(join(root, "doc.md"), "Intro before any heading.\n\n## Goals\n1. first goal\n   wrapped goal tail\n2. second goal\n\n## Steps\n- do the thing\n");
const codeRepo = join(root, "code-repo");
await mkdir(join(codeRepo, "nested"), { recursive: true });
const sh = (command) => new Promise((resolvePromise, rejectPromise) => {
	const proc = spawn("/bin/sh", ["-c", command], { cwd: codeRepo });
	proc.on("exit", (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} -> ${code}`))));
});
await writeFile(join(codeRepo, "app.txt"), "one\n");
await sh("git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm base");
await writeFile(join(codeRepo, "app.txt"), "one\ntwo\n");

const child = spawn(join(repo, "node_modules", ".bin", "pi"), [
	"--mode", "rpc",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-context-files",
	"--extension", join(repo, "index.ts"),
], {
	cwd: root,
	env: { ...process.env, CMUX_WORKSPACE_ID: "margin-doc-test", CMUX_BUNDLED_CLI_PATH: join(bin, "cmux"), PCR_OPEN_LOG: openLog },
	stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderr = "";
const responses = new Map();
const waiters = new Map();
const notifications = [];
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk.toString();
	for (;;) {
		const newlineIndex = stdoutBuffer.indexOf("\n");
		if (newlineIndex < 0) break;
		const line = stdoutBuffer.slice(0, newlineIndex);
		stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
		if (!line) continue;
		const event = JSON.parse(line);
		if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(event);
		if (event.type === "response" && event.id) {
			responses.set(event.id, event);
			waiters.get(event.id)?.(event);
			waiters.delete(event.id);
		}
	}
});

let commandSequence = 0;
const command = (message) => {
	const id = `command-${++commandSequence}`;
	child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
	return (responses.has(id)
		? Promise.resolve(responses.get(id))
		: new Promise((resolvePromise, rejectPromise) => {
			const timeout = setTimeout(() => {
				waiters.delete(id);
				rejectPromise(new Error(`Timed out waiting for ${id}\n${stderr}`));
			}, 30_000);
			waiters.set(id, (event) => {
				clearTimeout(timeout);
				resolvePromise(event);
			});
		})
	).then((response) => assert.equal(response.success, true, `${message}: ${JSON.stringify(response)}`));
};
const waitFor = async (predicate, label, timeoutMs = 15_000) => {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = await predicate();
		if (value) return value;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	throw new Error(`Timed out waiting for ${label}\n${stderr}`);
};

try {
	// Bare invocation with no assistant messages degrades gracefully.
	await command("/margin-doc");
	const emptyNotice = await waitFor(
		async () => notifications.find((event) => event.message?.includes("No assistant markdown found")),
		"empty-branch notice",
	);
	assert.equal(emptyNotice.notifyType, "warning");

	// File invocation serves the document review.
	await command("/margin-doc doc.md");
	const urls = await waitFor(async () => {
		const lines = (await readFile(openLog, "utf8")).trim().split("\n").filter(Boolean);
		return lines.length >= 1 ? lines : undefined;
	}, "browser open");
	const opened = await waitFor(
		async () => notifications.find((event) => event.message?.includes('Opened document review "doc.md"')),
		"open notice",
	);
	assert.match(opened.message, /3 section\(s\)/, "Intro preamble + two headings sectionize.");

	const entry = await fetch(urls[0], { redirect: "manual" });
	assert.ok(entry.status === 200 || (entry.status >= 300 && entry.status < 400), `Entry URL admits the first visitor (got ${entry.status}).`);
	const cookie = (entry.headers.get("set-cookie") ?? "").split(";", 1)[0];
	assert.ok(cookie, "Entry URL grants the session cookie.");
	const html = await (await fetch(new URL(urls[0]).origin, { headers: { cookie } })).text();
	assert.match(html, /data-review-kind="plan"/, "The command opens a plan-mode session.");
	assert.match(html, /<header class="plan-head"><h1>doc\.md<\/h1><\/header>/, "The file's basename titles the document.");
	assert.match(html, /<h2 data-md-line="3" data-md-end="3">Goals<\/h2>/, "The document renders with source-line stamps.");
	assert.match(html, /<li data-md-line="4" data-md-end="5">first goal wrapped goal tail<\/li>/, "Wrapped list items stay in their list end to end.");

	// A missing file reports rather than crashing the session.
	await command("/margin-doc nope-does-not-exist.md");
	await waitFor(
		async () => notifications.find((event) => event.notifyType === "error" && event.message?.includes("nope-does-not-exist.md")),
		"missing-file error notice",
	);

	// /margin-code with a path reviews a repository the session is not in —
	// including from a nested subdirectory of it.
	await command("/margin-code " + join(codeRepo, "nested"));
	const codeOpened = await waitFor(
		async () => notifications.find((event) => event.message?.startsWith("Opened static review")),
		"static review notice",
	);
	assert.match(codeOpened.message, /1 files in /, "The snapshot finds the dirty file from the nested path.");
	const codeUrls = (await readFile(openLog, "utf8")).trim().split("\n").filter(Boolean);
	const codeEntry = await fetch(codeUrls[codeUrls.length - 1], { redirect: "manual" });
	const codeCookie = (codeEntry.headers.get("set-cookie") ?? "").split(";", 1)[0];
	const codeHtml = await (await fetch(new URL(codeUrls[codeUrls.length - 1]).origin, { headers: { cookie: codeCookie } })).text();
	assert.doesNotMatch(codeHtml, /<body[^>]*data-review-kind="plan"/, "The path form opens a code-mode session.");
	assert.match(codeHtml, /app\.txt/, "The reviewed repo's changed file is served.");

	// A path outside any repository reports politely.
	await command("/margin-code " + bin);
	await waitFor(
		async () => notifications.find((event) => event.notifyType === "error" && event.message?.includes("requires a Git repository")),
		"non-repo error notice",
	);

	console.log("margin-doc RPC flow passed.");
} finally {
	child.kill();
	await rm(root, { recursive: true, force: true });
}
