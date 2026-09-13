// Builds a plan review: a markdown document sliced into heading sections that
// behave like review files. Each section carries file-shaped fields (path,
// lines keyed by newLine = 1-based source line, commentary) so the thread
// store, selection validation, wire formatting, and most of the client work
// unchanged; only rendering swaps the diff table for the rendered document.

import { createHash } from "node:crypto";

export const PLAN_LIMITS = {
	maxPlanBytes: 1024 * 1024,
	maxPlanLines: 20_000,
	maxSections: 200,
	maxTitle: 200,
	maxSummary: 2_000,
	maxCommentaryPerSection: 20,
	maxCommentaryBody: 20_000,
};

function fail(message) {
	throw new Error(message);
}

function slugify(text, used) {
	const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";
	let slug = base;
	for (let suffix = 2; used.has(slug); suffix++) slug = `${base}-${suffix}`;
	used.add(slug);
	return slug;
}

/** Split markdown into sections at its shallowest heading level. */
export function sectionizePlan(markdown, title) {
	const lines = String(markdown).split(/\r?\n/);
	const headingAt = (line) => {
		const match = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
		return match ? { level: match[1].length, text: match[2].trim() } : undefined;
	};
	// Headings inside fences are code, not structure.
	const headings = [];
	let fence = false;
	for (let index = 0; index < lines.length; index++) {
		if (/^\s*```/.test(lines[index])) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		const heading = headingAt(lines[index]);
		if (heading) headings.push({ ...heading, line: index + 1 });
	}
	const splitLevel = headings.length ? Math.min(...headings.map((heading) => heading.level)) : undefined;
	const boundaries = headings.filter((heading) => heading.level === splitLevel);
	const used = new Set();
	const sections = [];
	if (!boundaries.length || boundaries[0].line > 1) {
		const end = boundaries.length ? boundaries[0].line - 1 : lines.length;
		if (lines.slice(0, end).some((line) => line.trim())) {
			sections.push({ slug: slugify("introduction", used), title: title, startLine: 1, endLine: end });
		}
	}
	for (const [index, boundary] of boundaries.entries()) {
		const end = index + 1 < boundaries.length ? boundaries[index + 1].line - 1 : lines.length;
		sections.push({ slug: slugify(boundary.text, used), title: boundary.text, startLine: boundary.line, endLine: end });
	}
	return { lines, sections };
}

function normalizeCommentary(entries, section, limits, usedIds) {
	if (entries === undefined) return [];
	if (!Array.isArray(entries) || entries.length > limits.maxCommentaryPerSection) fail(`Section "${section.title}" commentary must be an array of at most ${limits.maxCommentaryPerSection} notes.`);
	return entries.map((entry, index) => {
		if (!entry || typeof entry !== "object") fail("Each commentary note must be an object.");
		const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : fail("Commentary notes need a non-empty string id.");
		if (usedIds.has(id)) fail(`Commentary id "${id}" is used more than once.`);
		usedIds.add(id);
		if (typeof entry.body !== "string" || !entry.body.trim() || entry.body.length > limits.maxCommentaryBody) fail(`Commentary note "${id}" needs a body of at most ${limits.maxCommentaryBody} characters.`);
		let anchor = {};
		if (entry.startLine !== undefined) {
			const start = entry.startLine;
			const end = entry.endLine ?? entry.startLine;
			if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < section.startLine || end > section.endLine) {
				fail(`Commentary note "${id}" anchors lines ${start}-${end}, outside its section (${section.startLine}-${section.endLine}).`);
			}
			anchor = { startLine: start, endLine: end };
		} else if (entry.endLine !== undefined) fail(`Commentary note "${id}" sets endLine without startLine.`);
		return { id, body: entry.body.trim(), side: "new", ...anchor, order: index };
	});
}

/**
 * Build a plan review object from a manifest { title, markdown, sections? }.
 * sections entries reference a heading by its exact text (case-insensitive)
 * and may add a summary and anchored commentary (absolute source lines).
 */
export function buildPlanReview(manifest, limits = PLAN_LIMITS) {
	if (!manifest || typeof manifest !== "object") fail("Plan review needs a manifest object.");
	const title = typeof manifest.title === "string" && manifest.title.trim() ? manifest.title.trim() : fail("Plan review needs a non-empty title.");
	if (title.length > limits.maxTitle) fail(`Plan title must stay under ${limits.maxTitle} characters.`);
	const markdown = typeof manifest.markdown === "string" && manifest.markdown.trim() ? manifest.markdown : fail("Plan review needs non-empty markdown.");
	if (Buffer.byteLength(markdown, "utf8") > limits.maxPlanBytes) fail(`Plan markdown must stay under ${limits.maxPlanBytes} bytes.`);
	const { lines, sections } = sectionizePlan(markdown, title);
	if (lines.length > limits.maxPlanLines) fail(`Plan markdown must stay under ${limits.maxPlanLines} lines.`);
	if (sections.length > limits.maxSections) fail(`Plans support at most ${limits.maxSections} sections.`);
	if (!sections.length) fail("Plan markdown produced no sections.");

	const manifestSections = manifest.sections === undefined ? [] : manifest.sections;
	if (!Array.isArray(manifestSections)) fail("Plan manifest sections must be an array.");
	const byHeading = new Map();
	for (const section of sections) {
		const key = section.title.toLowerCase();
		// Duplicate heading text is legal in the document but ambiguous as a
		// reference; such headings must be referenced by slug instead.
		byHeading.set(key, byHeading.has(key) ? "ambiguous" : section);
		byHeading.set(section.slug, section);
	}
	const claimed = new Set();
	const extras = new Map();
	const usedIds = new Set();
	for (const entry of manifestSections) {
		if (!entry || typeof entry !== "object" || typeof entry.heading !== "string") fail("Each manifest section needs a heading string.");
		const section = byHeading.get(entry.heading.trim().toLowerCase());
		if (section === "ambiguous") fail(`Heading "${entry.heading}" appears more than once in the plan; reference it by its slug instead.`);
		if (!section) fail(`Manifest section "${entry.heading}" matches no plan heading. Available: ${sections.map((candidate) => candidate.title).join(" · ")}`);
		if (claimed.has(section.slug)) fail(`Manifest references heading "${entry.heading}" more than once.`);
		claimed.add(section.slug);
		if (entry.summary !== undefined && (typeof entry.summary !== "string" || entry.summary.length > limits.maxSummary)) fail(`Section "${entry.heading}" summary must be a string under ${limits.maxSummary} characters.`);
		extras.set(section.slug, {
			summary: typeof entry.summary === "string" && entry.summary.trim() ? entry.summary.trim() : undefined,
			commentary: normalizeCommentary(entry.commentary, section, limits, usedIds),
		});
	}

	const files = sections.map((section) => {
		const segmentLines = lines.slice(section.startLine - 1, section.endLine);
		const segment = segmentLines.join("\n");
		return {
			path: section.slug,
			sectionTitle: section.title,
			status: "section",
			reviewMode: "review",
			binary: false,
			omitted: false,
			truncated: false,
			startLine: section.startLine,
			endLine: section.endLine,
			markdown: segment,
			contentSha256: createHash("sha256").update(segment).digest("hex"),
			lines: segmentLines.map((content, offset) => ({ kind: "context", newLine: section.startLine + offset, content })),
			summary: extras.get(section.slug)?.summary,
			commentary: extras.get(section.slug)?.commentary ?? [],
		};
	});
	const id = createHash("sha256").update(`plan\0${title}\0${markdown}`).digest("hex");
	// root scopes session replacement: opening a new plan closes the previous
	// plan session, exactly as a new code review closes its repository's session.
	return { kind: "plan", id, title, root: "plan", files, markdownLines: lines.length };
}
