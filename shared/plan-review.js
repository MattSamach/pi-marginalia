// Builds a plan review: a markdown document sliced into heading sections that
// behave like review files. Each section carries file-shaped fields (path,
// lines keyed by newLine = 1-based source line, commentary) so the thread
// store, selection validation, wire formatting, and most of the client work
// unchanged; only rendering swaps the diff table for the rendered document.

import { createHash } from "node:crypto";
import { elementExists, elementHint, splitElementRef } from "./diagram.js";

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

function rejectUnknownKeys(value, allowed, label) {
	for (const key of Object.keys(value)) {
		if (allowed.includes(key)) continue;
		const hint = ["startLine", "endLine", "side", "element"].includes(key) && !allowed.includes("startLine") ? " Anchors belong inside commentary entries." : "";
		throw new Error(`Unknown key "${key}" on ${label}.${hint}`);
	}
}

function normalizeCommentary(entries, section, limits, usedIds, sectionMarkdown) {
	if (entries === undefined) return [];
	if (!Array.isArray(entries) || entries.length > limits.maxCommentaryPerSection) fail(`Section "${section.title}" commentary must be an array of at most ${limits.maxCommentaryPerSection} notes.`);
	return entries.map((entry, index) => {
		if (!entry || typeof entry !== "object") fail("Each commentary note must be an object.");
		const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : fail("Commentary notes need a non-empty string id.");
		rejectUnknownKeys(entry, ["id", "body", "startLine", "endLine", "element"], `commentary note "${id}"`);
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
		if (entry.element !== undefined) {
			if (!splitElementRef(entry.element)) fail(`Commentary note "${id}" has an invalid element reference; use "node:id" or "edge:from->to".`);
			if (!elementExists(entry.element, sectionMarkdown)) fail(`Commentary note "${id}" anchors to element ${entry.element}, which no diagram in "${section.title}" defines (${elementHint(sectionMarkdown, entry.element)}).`);
			anchor = { ...anchor, element: entry.element };
		}
		return { id, body: entry.body.trim(), side: "new", ...anchor, order: index };
	});
}

/**
 * Build a plan review object from a manifest { title, markdown, sections? }.
 * sections entries reference a heading by its exact text (case-insensitive)
 * and may add anchored commentary (absolute source lines).
 */
export function buildPlanReview(manifest, limits = PLAN_LIMITS, previousFiles = undefined) {
	if (!manifest || typeof manifest !== "object") fail("Plan review needs a manifest object.");
	const title = typeof manifest.title === "string" && manifest.title.trim() ? manifest.title.trim() : fail("Plan review needs a non-empty title.");
	if (title.length > limits.maxTitle) fail(`Plan title must stay under ${limits.maxTitle} characters.`);
	const markdown = typeof manifest.markdown === "string" && manifest.markdown.trim() ? manifest.markdown : fail("Plan review needs non-empty markdown.");
	if (Buffer.byteLength(markdown, "utf8") > limits.maxPlanBytes) fail(`Plan markdown must stay under ${limits.maxPlanBytes} bytes.`);
	if (manifest.proposedApprovalNote !== undefined && (typeof manifest.proposedApprovalNote !== "string" || !manifest.proposedApprovalNote.trim() || manifest.proposedApprovalNote.length > 20_000)) {
		fail("proposedApprovalNote must be a non-empty string of at most 20000 characters.");
	}
	const { lines, sections } = sectionizePlan(markdown, title);
	if (lines.length > limits.maxPlanLines) fail(`Plan markdown must stay under ${limits.maxPlanLines} lines.`);
	if (sections.length > limits.maxSections) fail(`Plans support at most ${limits.maxSections} sections.`);
	if (!sections.length) fail("Plan markdown produced no sections.");

	const manifestSections = manifest.sections === undefined ? [] : manifest.sections;
	if (!Array.isArray(manifestSections)) fail("Plan manifest sections must be an array.");
	// Slugs are exact references and win outright; heading text is a
	// convenience that fails loudly when the document repeats it.
	const bySlug = new Map(sections.map((section) => [section.slug, section]));
	const byHeading = new Map();
	for (const section of sections) {
		const key = section.title.toLowerCase();
		byHeading.set(key, byHeading.has(key) ? "ambiguous" : section);
	}
	const claimed = new Set();
	// Sections whose manifest entry carries an explicit commentary value (even
	// an empty array) are authored this round; entries without one, and
	// sections never listed, carry the previous round's commentary while the
	// section's content is byte-identical.
	const authoredSlugs = new Set();
	const extras = new Map();
	const usedIds = new Set();
	for (const entry of manifestSections) {
		if (!entry || typeof entry !== "object" || typeof entry.heading !== "string") fail("Each manifest section needs a heading string.");
		const reference = entry.heading.trim();
		const section = bySlug.get(reference) ?? byHeading.get(reference.toLowerCase());
		if (section === "ambiguous") fail(`Heading "${entry.heading}" appears more than once in the plan; reference it by its slug instead.`);
		if (!section) fail(`Manifest section "${entry.heading}" matches no plan heading. Available: ${sections.map((candidate) => candidate.title).join(" · ")}`);
		rejectUnknownKeys(entry, ["heading", "commentary"], `manifest section "${entry.heading}"`);
		if (claimed.has(section.slug)) fail(`Manifest references heading "${entry.heading}" more than once.`);
		claimed.add(section.slug);
		if (entry.commentary !== undefined) authoredSlugs.add(section.slug);
		extras.set(section.slug, {
			commentary: normalizeCommentary(entry.commentary, section, limits, usedIds, lines.slice(section.startLine - 1, section.endLine).join("\n")),
		});
	}
	const previousByPath = previousFiles === undefined ? undefined : new Map(previousFiles.map((file) => [file.path, file]));
	const carryCommentary = (file) => {
		if (authoredSlugs.has(file.path) || previousByPath === undefined) return file.commentary;
		const previous = previousByPath.get(file.path);
		if (!previous || previous.contentSha256 !== file.contentSha256 || !previous.commentary?.length) return file.commentary;
		for (const entry of previous.commentary) {
			if (usedIds.has(entry.id)) fail(`Carried commentary id "${entry.id}" in section "${file.sectionTitle}" collides with an authored id; re-author that section or rename the id.`);
			usedIds.add(entry.id);
		}
		return structuredClone(previous.commentary);
	};

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
			commentary: extras.get(section.slug)?.commentary ?? [],
		};
	}).map((file) => ({ ...file, commentary: carryCommentary(file) }));
	const id = createHash("sha256").update(`plan\0${title}\0${markdown}`).digest("hex");
	return {
		kind: "plan",
		id,
		title,
		// root scopes session replacement: opening a new plan closes the previous
		// plan session, exactly as a new code review closes its repository's.
		root: "plan",
		files,
		markdownLines: lines.length,
		// Rendered on the approve screen through the same field code reviews use.
		...(manifest.proposedApprovalNote === undefined ? {} : { proposedCommitMessage: manifest.proposedApprovalNote.trim() }),
	};
}

/**
 * Resolve threadResponses' section references (heading text or slug) to slugs
 * for a plan round. Slugs resolve exactly; duplicated heading text stays
 * unresolved so the round-advance validation names the offending value. side
 * is stamped only alongside explicit lines — a section-only anchor stays bare.
 */
export function resolvePlanResponses(review, responses) {
	if (!Array.isArray(responses)) return responses;
	const bySection = new Map();
	for (const section of review.files) {
		const heading = String(section.sectionTitle ?? "").toLowerCase();
		bySection.set(heading, bySection.has(heading) ? "" : section.path);
	}
	for (const section of review.files) bySection.set(section.path.toLowerCase(), section.path);
	return responses.map((response) => {
		if (!response || typeof response !== "object" || response.file === undefined) return response;
		const resolved = bySection.get(String(response.file).trim().toLowerCase()) || response.file;
		return { ...response, file: resolved, ...(response.startLine === undefined ? {} : { side: "new" }) };
	});
}

const FENCE = "```";

/**
 * Build a diagram-first plan review from { title, diagrams }. Each diagram
 * becomes one generated section: a heading (its name), a mermaid fence, and
 * an optional caption paragraph. The result IS a plan review — same engine,
 * same threads, same rounds — so element anchors, carries, and approval all
 * behave identically to a hand-written plan.
 */
export function buildDiagramReview(manifest, limits = PLAN_LIMITS) {
	if (!manifest || typeof manifest !== "object") fail("Diagram review needs a manifest object.");
	const diagrams = manifest.diagrams;
	if (!Array.isArray(diagrams) || !diagrams.length || diagrams.length > 40) fail("Diagram review needs 1-40 diagrams.");
	const seen = new Set();
	const parts = [];
	const sections = [];
	for (const diagram of diagrams) {
		if (!diagram || typeof diagram !== "object") fail("Each diagram must be an object.");
		const name = typeof diagram.name === "string" && diagram.name.trim() ? diagram.name.trim() : fail("Each diagram needs a non-empty name.");
		rejectUnknownKeys(diagram, ["name", "source", "caption", "commentary"], `diagram "${name}"`);
		if (name.length > 200 || /[\r\n#`]/.test(name)) fail(`Diagram name "${name.slice(0, 40)}" must stay under 200 characters with no newlines, hashes, or backticks.`);
		const key = name.toLowerCase();
		if (seen.has(key)) fail(`Diagram name "${name}" is used more than once (names are section headings and must be unique).`);
		seen.add(key);
		const source = typeof diagram.source === "string" && diagram.source.trim() ? diagram.source : fail(`Diagram "${name}" needs non-empty mermaid source.`);
		if (source.length > 100_000) fail(`Diagram "${name}" source must stay under 100000 characters.`);
		if (/^\s*```/m.test(source)) fail(`Diagram "${name}" source contains a fence line (${FENCE}), which would break out of its markdown fence.`);
		if (diagram.caption !== undefined && (typeof diagram.caption !== "string" || !diagram.caption.trim() || diagram.caption.length > 2_000)) {
			fail(`Diagram "${name}" caption must be a non-empty string under 2000 characters.`);
		}
		// The caption is one prose paragraph in a generated document: a leading
		// heading or fence marker would change the document's structure.
		const cleanCaption = diagram.caption === undefined ? undefined : diagram.caption.replace(/\r\n?|\n/g, " ").trim();
		if (cleanCaption !== undefined && /^(#|\x60{3})/.test(cleanCaption)) {
			fail(`Diagram "${name}" caption cannot start with a heading or fence marker.`);
		}
		// Distinct names must also produce distinct slug bases: suffix numbering
		// is document-order dependent, and a reorder would silently swap which
		// diagram a carried thread's slug resolves to.
		const slugBase = key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";
		if (seen.has(`slug\0${slugBase}`)) fail(`Diagram names "${name}" and another collapse to the same section slug "${slugBase}"; make them distinct.`);
		seen.add(`slug\0${slugBase}`);
		const cleanSource = source.replace(/\r\n/g, "\n").replace(/\s+$/, "");
		const caption = cleanCaption === undefined ? "" : `\n\n${cleanCaption}`;
		parts.push(`## ${name}\n\n${FENCE}mermaid\n${cleanSource}\n${FENCE}${caption}`);
		sections.push({ heading: name, ...(diagram.commentary === undefined ? {} : { commentary: diagram.commentary }) });
	}
	return buildPlanReview({
		title: manifest.title,
		markdown: parts.join("\n\n"),
		sections,
		...(manifest.proposedApprovalNote === undefined ? {} : { proposedApprovalNote: manifest.proposedApprovalNote }),
	}, limits);
}
