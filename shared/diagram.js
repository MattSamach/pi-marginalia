// Diagram element identity. Threads and commentary may refine a line anchor
// with an element reference ("node:api" or "edge:api->db"); these helpers
// enumerate the ids a mermaid source defines so references validate with
// hints instead of guesswork. Parsing is a tolerant text scan — it aims to
// find every id an author could click, not to be a mermaid grammar.

// Fence recognition mirrors renderMarkdown exactly: any ``` line toggles a
// fence, the first info-string token names the language, and any ``` line
// closes. Divergence here would validate elements no diagram renders.
const MERMAID_OPEN = /^\s*```\s*mermaid\b/i;

/** Extract the mermaid fence sources from a markdown segment, in order. */
export function extractMermaidSources(markdown) {
	const sources = [];
	let fence;
	let collecting = false;
	for (const line of String(markdown ?? "").split(/\r?\n/)) {
		if (fence !== undefined) {
			if (/^\s*```/.test(line)) {
				if (collecting) sources.push(fence.join("\n"));
				fence = undefined;
			} else fence.push(line);
			continue;
		}
		if (/^\s*```/.test(line)) {
			fence = [];
			collecting = MERMAID_OPEN.test(line);
		}
	}
	return sources;
}

// Node ids appear as edge endpoints or shape definitions; both forms share a
// leading identifier token. Statements can chain (a --> b --> c), so every
// identifier adjacent to an arrow counts from both sides.
// An arrow is an optional start marker (x, o or <, a marker letter only
// after whitespace), a solid, thick or dotted body, and an optional end
// marker (x or o only before whitespace, so ids like `box` stay whole).
const ARROW = /(?:(?<=\s)[xo]|<)?(?:--+|==+|-\.+-?)(?:[xo](?=\s|$)|>)?|~~~+/;
// Word-labelled links (a -- text --> b, a -. text .-> b, a == text ==> b)
// collapse to a plain arrow before splitting.
const WORD_LINK = /(?:--|-\.|==)\s+[^|]*?\s+(?:--+[>xo]?|\.-+>?|==+>?)(?=\s|$|[A-Za-z0-9_])/g;
// Lines mermaid reads before the diagram header: blanks, %% comments and
// %%{init}%% directives, and a --- frontmatter block.
const headerIndex = (lines) => {
	let index = 0;
	if (lines.find((line) => line.trim())?.trim() === "---") {
		index = lines.findIndex((line) => line.trim() === "---");
		const close = lines.findIndex((line, at) => at > index && line.trim() === "---");
		index = close === -1 ? lines.length : close + 1;
	}
	while (index < lines.length && (!lines[index].trim() || lines[index].trim().startsWith("%%"))) index++;
	return index;
};
const IDENT = /[A-Za-z0-9_]+/;
// Sequence diagrams: participants are declared (participant/actor id, with
// an optional `as` label) or implied by a message; a message is
// `from <arrow> [+|-]to : text`, with solid or dotted arrows ending in
// >, >>, x, ) or a two-way <<…>>. The nth message from one participant to
// another is `from->to#n`, the first written plainly as `from->to` (as a
// flowchart edge is), in statement order, which is also the order mermaid
// draws them. Ids therefore survive rewording a message and adding one
// after it; only a message inserted before another of the same pair
// renumbers the later ones. Quoted participant names and `box` groupings
// are not recognized (their participants are still found from messages).
const SEQUENCE_PARTICIPANT = /^(?:create\s+)?(participant|actor)\s+([A-Za-z0-9_]+)(?:@\{[^}]*\})?(?:\s+as\s+(.+))?$/;
const SEQUENCE_MESSAGE = /^([A-Za-z0-9_]+)\s*(?:<<)?--?(?:>>|>|x|\))\s*[+-]?\s*([A-Za-z0-9_]+)\s*:(.*)$/;
/** The element id of the `count`th message from `from` to `to` (1-based). */
export const sequenceEdgeId = (from, to, count) => `${from}->${to}${count > 1 ? `#${count}` : ""}`;
const parseSequence = (lines, nodes, edges, labels, actors) => {
	const seen = new Map();
	for (const raw of lines) {
		const line = raw.replace(/%%.*$/, "").trim();
		const declared = SEQUENCE_PARTICIPANT.exec(line);
		if (declared) {
			nodes.add(declared[2]);
			if (declared[1] === "actor") actors.add(declared[2]);
			if (declared[3]) labels.set(declared[2], declared[3].trim());
			continue;
		}
		const message = SEQUENCE_MESSAGE.exec(line);
		if (!message) continue;
		nodes.add(message[1]);
		nodes.add(message[2]);
		const pair = `${message[1]}->${message[2]}`;
		seen.set(pair, (seen.get(pair) ?? 0) + 1);
		const id = sequenceEdgeId(message[1], message[2], seen.get(pair));
		edges.add(id);
		// The message text, so a reworded message reads as changed.
		labels.set(id, message[3].trim());
	}
};
/** Enumerate node ids and directed edge pairs from one mermaid source. */
export function parseMermaidElements(source) {
	const nodes = new Set();
	const edges = new Set();
	// id -> raw shape token ("[Store]", "((Hub))"). Not a clean label: only a
	// comparable signature, so a label edit is detectable across rounds.
	const labels = new Map();
	const lines = String(source ?? "").split(/\r?\n/);
	const start = headerIndex(lines);
	const header = lines[start]?.trim().toLowerCase() ?? "";
	const kind = /^(flowchart|graph)\b/.test(header) ? "flowchart" : /^statediagram/.test(header) ? "state" : /^sequencediagram\b/.test(header) ? "sequence" : "other";
	// The flowchart's direction as written in its header (TB when absent).
	const direction = (/^(?:flowchart|graph)\s+(tb|td|bt|lr|rl)\b/.exec(header)?.[1] ?? "tb").toUpperCase();
	// Sequence participants declared as `actor` (drawn as stick figures).
	const actors = new Set();
	if (kind === "sequence") parseSequence(lines.slice(start + 1), nodes, edges, labels, actors);
	if (kind === "other" || kind === "sequence") return { kind, direction, nodes, edges, labels, actors };
	for (let raw of lines.slice(start + 1)) {
		let line = raw.replace(/%%.*$/, "").trim();
		if (!line || /^(classDef|class|style|linkStyle|click|direction|subgraph|end\b)/.test(line)) {
			// Subgraph ids are containers, not clickable nodes; class statements
			// reference nodes that must already be defined elsewhere.
			continue;
		}
		// Pipe labels are edge prose; strip them before signature capture so
		// "a -->|api[1]| b" can never mint a signature for node api. Later
		// definitions overwrite earlier ones, matching mermaid's last-wins.
		const piped = line.replace(/\|[^|]*\|/g, "|");
		for (const match of piped.matchAll(new RegExp(`(${IDENT.source})\\s*([\\[({>][^\\])}]*[\\])}]+)`, "g"))) {
			labels.set(match[1], match[2]);
		}
		// State-diagram relabels use colon syntax (s1 : description).
		if (kind === "state") {
			const colonLabel = new RegExp(`^(${IDENT.source})\\s*:\\s*(.+)$`).exec(piped);
			if (colonLabel) {
				nodes.add(colonLabel[1]);
				labels.set(colonLabel[1], `:${colonLabel[2]}`);
			}
		}
		// Label bodies and ::: class shorthand are prose/annotations, never ids:
		// strip both before any scan so "api[API (v2)]" and "a:::hot" read as
		// just their identifiers.
		line = piped.replace(/\[[^\]]*\]/g, "[]").replace(/\(+[^()]*\)+/g, "()").replace(/\{[^}]*\}/g, "{}").replace(/:::[A-Za-z0-9_,]+/g, "");
		// A statement that is just an identifier renders as a bare node.
		if (new RegExp(`^${IDENT.source}$`).test(line)) {
			nodes.add(line);
			continue;
		}
		// Shape definitions: id[Label], id(Label), id{Label}, id((Label)), id>Label]
		for (const match of line.matchAll(new RegExp(`(${IDENT.source})\\s*(?=\\[|\\(|\\{|>)`, "g"))) nodes.add(match[1]);
		// Edges: split on arrows; endpoints are the identifier tail/head of the
		// adjacent parts. Word labels (-- text -->) are collapsed first.
		const stripped = line.replace(WORD_LINK, " --> ");
		const parts = stripped.split(ARROW);
		if (parts.length > 1) {
			const endpointOf = (part, fromEnd) => {
				const ids = [...part.matchAll(new RegExp(IDENT.source, "g"))].map((match) => match[0]);
				if (!ids.length) return undefined;
				return fromEnd ? ids[ids.length - 1] : ids[0];
			};
			for (let index = 0; index + 1 < parts.length; index++) {
				const from = endpointOf(parts[index].split("&").pop(), true);
				for (const branch of parts[index + 1].split("&")) {
					const to = endpointOf(branch, false);
					if (from && to) {
						nodes.add(from);
						nodes.add(to);
						edges.add(`${from}->${to}`);
					}
				}
			}
		}
	}
	return { kind, direction, nodes, edges, labels, actors };
}

/** Whether directed [from, to] pairs form a cycle (a self-loop counts). */
export const pairsCycle = (pairs) => {
	const out = new Map();
	for (const [from, to] of pairs) {
		if (!out.has(from)) out.set(from, []);
		out.get(from).push(to);
	}
	const state = new Map();
	const visit = (id) => {
		if (state.get(id) === 1) return true;
		if (state.get(id) === 2) return false;
		state.set(id, 1);
		const found = (out.get(id) ?? []).some(visit);
		state.set(id, 2);
		return found;
	};
	return [...out.keys()].some(visit);
};
/** Whether a parsed diagram's edges form a cycle. */
export const hasCycle = (parsed) => pairsCycle([...parsed.edges].map((edge) => edge.split("#")[0].split("->")));

/**
 * Diff the diagram elements of two markdown segments into round-over-round
 * review metadata: refs that should glow (new ids, or nodes whose label
 * signature changed) and refs that are gone. Nodes glow only for their own
 * changes; topology changes surface as the edges themselves. A sequence
 * message also glows when its text changes (flowchart edge labels carry no
 * signature). Sequence message ids number each pair's messages in order, so
 * a message inserted before another of the same pair renumbers the later
 * ones: they read as removed and added.
 */
export function computeElementDiff(previousMarkdown, nextMarkdown) {
	const collect = (markdown) => {
		const nodes = new Set();
		const edges = new Set();
		const labels = new Map();
		for (const source of extractMermaidSources(markdown)) {
			const parsed = parseMermaidElements(source);
			for (const node of parsed.nodes) nodes.add(node);
			for (const edge of parsed.edges) edges.add(edge);
			for (const [id, label] of parsed.labels) if (!labels.has(id)) labels.set(id, label);
		}
		return { nodes, edges, labels };
	};
	const previous = collect(previousMarkdown);
	const next = collect(nextMarkdown);
	const changed = [];
	const removed = [];
	for (const node of next.nodes) {
		if (!previous.nodes.has(node)) changed.push(`node:${node}`);
		else if (previous.labels.get(node) !== next.labels.get(node)) changed.push(`node:${node}`);
	}
	for (const edge of next.edges) if (!previous.edges.has(edge) || previous.labels.get(edge) !== next.labels.get(edge)) changed.push(`edge:${edge}`);
	for (const node of previous.nodes) if (!next.nodes.has(node)) removed.push(`node:${node}`);
	for (const edge of previous.edges) if (!next.edges.has(edge)) removed.push(`edge:${edge}`);
	return { changed, removed };
}

/** Union of elements across every mermaid fence in a markdown segment. */
export function collectDiagramElements(markdown) {
	const nodes = new Set();
	const edges = new Set();
	for (const source of extractMermaidSources(markdown)) {
		const parsed = parseMermaidElements(source);
		for (const node of parsed.nodes) nodes.add(node);
		for (const edge of parsed.edges) edges.add(edge);
	}
	return { nodes, edges };
}

/** Validate an element reference against a markdown segment's diagrams. */
export function elementExists(reference, markdown) {
	const parsed = splitElementRef(reference);
	if (!parsed) return false;
	const { nodes, edges } = collectDiagramElements(markdown);
	return parsed.type === "node" ? nodes.has(parsed.id) : edges.has(parsed.id);
}

/** Parse "node:x" / "edge:a->b" or return undefined. */
export function splitElementRef(reference) {
	if (typeof reference !== "string" || reference.length > 200) return undefined;
	const match = /^(node|edge):(.+)$/.exec(reference);
	if (!match) return undefined;
	if (match[1] === "edge" && !/^[A-Za-z0-9_]+->[A-Za-z0-9_]+(?:#\d+)?$/.test(match[2])) return undefined;
	if (match[1] === "node" && !/^[A-Za-z0-9_]+$/.test(match[2])) return undefined;
	return { type: match[1], id: match[2] };
}

/** Reject-with-hints text listing what a segment's diagrams actually define. */
export function elementHint(markdown) {
	const { nodes, edges } = collectDiagramElements(markdown);
	if (!nodes.size && !edges.size) return "no diagram elements found in this section";
	const list = (values, limit) => [...values].slice(0, limit).join(", ") + (values.size > limit ? ", …" : "");
	const parts = [];
	if (nodes.size) parts.push(`nodes: ${list(nodes, 20)}`);
	if (edges.size) parts.push(`edges: ${list(edges, 15)}`);
	return parts.join("; ");
}

// Punctuation mermaid reads as syntax inside an unquoted label.
const LABEL_PUNCTUATION = /[()[\]{}<>#;:&]/;

const CLOSER = { "[": "]", "(": ")", "{": "}" };
/**
 * Repair the commonest parse failures: quote unquoted edge labels
 * (`-->|a (b)|`), subgraph titles (`subgraph id[a (b)]`) and plain node
 * labels (`id[a (b)]`) that contain punctuation mermaid would parse as
 * syntax; bracket a subgraph title written as a bare string
 * (`subgraph id "Title"`); and rebuild a quoted node label's closing brackets
 * as the mirror of its opening ones (`id(["A"]))`) where a node starts a
 * statement or ends an edge. The renderer retries with
 * this when a source fails to parse; ids are untouched, so element anchors
 * are unaffected. Shape syntax (`id[(db)]`, `id[/x/]`) is left alone.
 */
export function quoteMermaidLabels(source) {
	return String(source ?? "")
		.replace(/\|([^|"\n]+)\|/g, (whole, text) => (LABEL_PUNCTUATION.test(text) ? `|"${text}"|` : whole))
		.replace(/^(\s*subgraph\s+[A-Za-z0-9_-]+)\s+("[^"\n]*")\s*$/gm, "$1[$2]")
		.replace(/^(\s*subgraph\s+[A-Za-z0-9_-]+\s*)\[([^\]"\n]+)\]\s*$/gm, (whole, head, text) => (LABEL_PUNCTUATION.test(text) ? `${head}["${text}"]` : whole))
		.replace(/(^|[\s&>|;-])([A-Za-z0-9_]+)\[(?![([/\\"])([^\]"\n]+)\](?!\])/gm, (whole, before, id, text) => (LABEL_PUNCTUATION.test(text) && !/^subgraph$/i.test(id) ? `${before}${id}["${text}"]` : whole))
		.replace(new RegExp(`(^\\s*|(?:${ARROW.source})\\s*(?:\\|[^|\\n]*\\|\\s*)?|&\\s*)([A-Za-z0-9_]+)([[({]+)("[^"\\n]*")([\\])}]+)`, "gm"), (whole, before, id, open, text) => `${before}${id}${open}${text}${[...open].reverse().map((bracket) => CLOSER[bracket]).join("")}`);
}

/**
 * Prepare a mermaid ELK graph for layout, in place. The root gets
 * `rootOptions`, every container `containerOptions` plus
 * `containerExtra(id)`. ELK leaves a container downstream and enters one
 * upstream, so of an antiparallel edge pair crossing a container boundary
 * (b -> a after a -> b, whether a reply or a two-way flow) the second is
 * routed around the whole drawing; it is laid out reversed instead, beside
 * its partner. `balance` also reverses edges against the majority between
 * two parts (see below). Returns the ids of the reversed edges for
 * restoreElkResult.
 */
export function transformElkGraph(graph, { rootOptions = {}, containerOptions = {}, containerExtra = () => undefined, balance = false } = {}) {
	graph.layoutOptions = { ...graph.layoutOptions, ...rootOptions };
	const parent = new Map();
	const edges = [];
	const collect = (node) => {
		edges.push(...(node.edges ?? []));
		for (const child of node.children ?? []) {
			parent.set(child.id, node);
			if (!Array.isArray(child.children)) continue;
			child.layoutOptions = { ...child.layoutOptions, ...containerOptions, ...(containerExtra(child.id) ?? {}) };
			collect(child);
		}
	};
	collect(graph);
	const laidOut = new Set();
	const flipped = new Set();
	// Toggles, so an edge reversed twice is laid out and restored as written.
	const flip = (edge) => {
		if (!flipped.delete(edge.id)) flipped.add(edge.id);
		[edge.sources, edge.targets] = [edge.targets, edge.sources];
	};
	for (const edge of edges) {
		const [from, to] = [edge.sources?.[0], edge.targets?.[0]];
		if (laidOut.has(`${to}\0${from}`) && parent.get(from) !== parent.get(to)) flip(edge);
		laidOut.add(`${edge.sources?.[0]}\0${edge.targets?.[0]}`);
	}
	const top = (id) => {
		let current = id;
		while (parent.get(current) && parent.get(current) !== graph) current = parent.get(current).id;
		return current;
	};
	// With `balance`: between two top-level parts of which one is a
	// container, edges running both ways put the parts in a cycle ELK breaks
	// by routing one side around the whole drawing. The minority direction (on a tie, the one written
	// second) is laid out reversed instead, so the parts stack along the
	// majority and every edge between them runs directly.
	// Edges the pass above reversed already run with their partner, and stay.
	const between = new Map();
	for (const edge of balance ? edges : []) {
		if (flipped.has(edge.id)) continue;
		const [from, to] = [edge.sources?.[0], edge.targets?.[0]];
		const [a, b] = [top(from), top(to)];
		if (a === b || (parent.get(from) === graph && parent.get(to) === graph)) continue;
		if (!between.has(`${a}\0${b}`)) between.set(`${a}\0${b}`, []);
		between.get(`${a}\0${b}`).push(edge);
	}
	for (const [key, forward] of between) {
		const [a, b] = key.split("\0");
		const backward = between.get(`${b}\0${a}`);
		if (!backward?.length || !forward.length) continue;
		const firstAt = (list) => Math.min(...list.map((edge) => edges.indexOf(edge)));
		const minority = forward.length !== backward.length ? (forward.length < backward.length ? forward : backward) : firstAt(forward) > firstAt(backward) ? forward : backward;
		minority.splice(0).forEach(flip);
	}
	return flipped;
}

/** Turn the edges transformElkGraph reversed back to their own direction. */
export function restoreElkResult(result, flipped) {
	const restore = (node) => {
		for (const edge of node.edges ?? []) {
			if (!flipped.has(edge.id)) continue;
			[edge.sources, edge.targets] = [edge.targets, edge.sources];
			for (const section of edge.sections ?? []) {
				[section.startPoint, section.endPoint] = [section.endPoint, section.startPoint];
				[section.incomingShape, section.outgoingShape] = [section.outgoingShape, section.incomingShape];
				section.bendPoints?.reverse();
			}
		}
		(node.children ?? []).forEach(restore);
	};
	restore(result);
	return result;
}

/**
 * Re-lay out a top-down ELK result that is a chain of questions, in place:
 * decision diamonds each answered onward to the next, with every other
 * answer ending in a small tree of outcome boxes (no merges, no loops). The
 * questions stack in one column; each question's outcome tree grows level
 * with it to the side (right, then left for a second one), each box's
 * successors stacked in the next column out, and the last question's other
 * answer continues down the column with its own tree beside it. Boxes
 * leading into the first question stack above it. Edges run straight, or
 * with one vertical jog between columns; a side edge's label is centred on
 * its last run, a column edge's label sits beside its line.
 * Any other graph (containers, merges, cycles, a question with three
 * answers) is left alone; returns whether it was re-laid out. This is placed
 * by hand because a layered layout (ELK's) always puts a node's successors
 * in later layers, so an outcome can never sit level with its question.
 *
 * Gaps are the caller's layout spacing, in SVG units: `rowGap` between
 * rows, `sideGap` between side columns (room for one vertical jog), and
 * `edgeClearance`, which pads a side edge's label each side along its run,
 * sets the margin of a column edge's label beside its line, and sets how
 * far past its source a side edge jogs (leaving the longer run into the
 * target for the label).
 */
// A question is a diamond: `{…}` in flowchart source (not the `{{…}}`
// hexagon), mermaid's diamond/question shape in the laid-out graph.
export const isQuestionShape = (shape) => /^(?:diamond|question)$/.test(shape ?? "") || /^\{[^{]/.test(shape ?? "");
/**
 * Whether a graph is a decision chain, and its parts if so: a spine of
 * questions (`isQuestion(id)`), each answered onward to the next, every
 * other answer ending in a tree of non-question boxes, and a lead-in chain
 * of boxes before the first question; no cycles, no box with two parents.
 * `edges` are { from, to } objects (other fields pass through). Returns
 * { out, into, spine, lead, onward } (spine as ids, lead as edges in order,
 * out/into and onward(id) as edge lists) or null. The decision variant's
 * gate checks the parsed source with it and layoutDecisionChain ELK's
 * result, so the two agree on what a chain is.
 */
export function decisionChain(ids, isQuestion, edges) {
	const out = new Map(ids.map((id) => [id, []]));
	const into = new Map(ids.map((id) => [id, []]));
	for (const edge of edges) {
		if (!out.has(edge.from) || !out.has(edge.to) || edge.from === edge.to) return null;
		out.get(edge.from).push(edge);
		into.get(edge.to).push(edge);
	}
	if (pairsCycle(edges.map((edge) => [edge.from, edge.to]))) return null;
	const questions = ids.filter(isQuestion);
	if (!questions.length || ids.some((id) => into.get(id).length > 1)) return null;
	const onward = (id) => out.get(id).filter((edge) => isQuestion(edge.to));
	const spine = [questions.find((id) => !into.get(id).some((edge) => isQuestion(edge.from)))];
	while (spine[0] !== undefined && onward(spine.at(-1)).length === 1 && spine.length <= questions.length) spine.push(onward(spine.at(-1))[0].to);
	if (spine[0] === undefined || spine.length !== questions.length || spine.some((id) => out.get(id).length !== 2 || onward(id).length > 1)) return null;
	const lead = [];
	for (let id = spine[0]; into.get(id).length; id = into.get(id)[0].from) lead.unshift(into.get(id)[0]);
	if (lead.some((edge) => isQuestion(edge.from) || out.get(edge.from).length !== 1)) return null;
	// Outcome trees hold no questions; with single parents they can't merge.
	const tree = (id) => [id, ...out.get(id).flatMap((edge) => tree(edge.to))];
	const outcomes = spine.flatMap((id, index) => out.get(id).filter((edge) => index === spine.length - 1 || !isQuestion(edge.to)).map((edge) => edge.to));
	const placed = [...spine, ...lead.map((edge) => edge.from), ...outcomes.flatMap(tree)];
	if (placed.some((id, index) => (index >= spine.length + lead.length && isQuestion(id)) || placed.indexOf(id) !== index) || placed.length !== ids.length) return null;
	return { out, into, spine, lead, onward };
}
/** Whether a parsed flowchart source is a decision chain (decisionChain). */
export const isDecisionChain = (parsed) => Boolean(decisionChain([...parsed.nodes], (id) => isQuestionShape(parsed.labels.get(id)), [...parsed.edges].map((edge) => {
	const [from, to] = edge.split("->");
	return { from, to };
})));
export function layoutDecisionChain(result, { rowGap, sideGap, edgeClearance }) {
	const nodes = result.children ?? [];
	const edges = result.edges ?? [];
	if (!nodes.length || nodes.some((node) => Array.isArray(node.children)) || edges.some((edge) => edge.sources?.length !== 1 || edge.targets?.length !== 1)) return false;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const chain = decisionChain(nodes.map((node) => node.id), (id) => isQuestionShape(byId.get(id).shape), edges.map((edge) => ({ from: edge.sources[0], to: edge.targets[0], edge })));
	if (!chain) return false;
	const { out, lead, onward } = chain;
	const spine = chain.spine.map((id) => byId.get(id));
	const target = (edge) => byId.get(edge.to);
	const question = (node) => isQuestionShape(node.shape);
	const label = (edge) => (edge.edge ?? edge).labels?.find((entry) => entry.width > 0 && entry.text) ?? null;
	// A side edge's label sits on its run, padded each side; a column edge's
	// label sits beside its line, so the gap only needs the label's height.
	const hGap = (edge) => Math.max(sideGap, label(edge) ? label(edge).width + 2 * edgeClearance : 0);
	const vGap = (edge) => Math.max(rowGap, label(edge) ? label(edge).height + edgeClearance : 0);
	const place = (node, cx, cy) => Object.assign(node, { x: cx - node.width / 2, y: cy - node.height / 2 });
	// Height of a box's tree: its successors stack in the next column out.
	const spans = new Map();
	const span = (node) => {
		if (!spans.has(node.id)) spans.set(node.id, Math.max(node.height, out.get(node.id).reduce((sum, edge, at) => sum + span(target(edge)) + (at ? rowGap : 0), 0)));
		return spans.get(node.id);
	};
	// The targets of `branches` stack in the next column out (side 1 right,
	// -1 left), as one block centred on `node`, each centred on its own
	// tree; their successors follow the same way.
	const grow = (node, side, branches = out.get(node.id)) => {
		const block = branches.reduce((sum, edge, at) => sum + span(target(edge)) + (at ? rowGap : 0), 0);
		let top = node.y + node.height / 2 - block / 2;
		for (const edge of branches) {
			const child = target(edge);
			const height = span(child);
			place(child, side > 0 ? node.x + node.width + hGap(edge) + child.width / 2 : node.x - hGap(edge) - child.width / 2, top + height / 2);
			grow(child, side);
			top += height + rowGap;
		}
	};
	let y = 0;
	for (const edge of lead) {
		const node = byId.get(edge.from);
		place(node, 0, y + node.height / 2);
		y += node.height + vGap(edge);
	}
	spine.forEach((node, index) => {
		const last = index === spine.length - 1;
		const across = out.get(node.id).filter((edge) => !question(target(edge)));
		const down = last ? across.pop() : onward(node.id)[0];
		const height = Math.max(node.height, ...across.map((edge) => span(target(edge))));
		place(node, 0, y + height / 2);
		across.forEach((edge, at) => grow(node, at === 0 ? 1 : -1, [edge]));
		y += height + vGap(down);
		if (!last) return;
		const end = target(down);
		const endHeight = span(end);
		place(end, 0, y + endHeight / 2);
		grow(end, 1);
	});
	const left = Math.min(...nodes.map((node) => node.x));
	const top = Math.min(...nodes.map((node) => node.y));
	for (const node of nodes) Object.assign(node, { x: node.x - left, y: node.y - top });
	// Column edges run straight down; side edges leave the facing side and
	// jog vertically just past the source when the two boxes aren't level.
	for (const edge of edges) {
		const [a, b] = [byId.get(edge.sources[0]), byId.get(edge.targets[0])];
		const column = Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)) < 1 && b.y > a.y;
		const side = b.x > a.x ? 1 : -1;
		const start = column ? { x: a.x + a.width / 2, y: a.y + a.height } : { x: side > 0 ? a.x + a.width : a.x, y: a.y + a.height / 2 };
		const end = column ? { x: start.x, y: b.y } : { x: side > 0 ? b.x : b.x + b.width, y: b.y + b.height / 2 };
		const jog = !column && Math.abs(start.y - end.y) >= 1 ? start.x + side * edgeClearance : null;
		const bendPoints = jog === null ? [] : [{ x: jog, y: start.y }, { x: jog, y: end.y }];
		edge.sections = [{ id: `${edge.id}_s0`, startPoint: start, endPoint: end, bendPoints, incomingShape: a.id, outgoingShape: b.id }];
		const text = label(edge);
		const from = jog === null ? start : { x: jog, y: end.y };
		if (text && column) Object.assign(text, { x: start.x + edgeClearance / 2, y: (start.y + end.y) / 2 - text.height / 2 });
		else if (text) Object.assign(text, { x: (from.x + end.x) / 2 - text.width / 2, y: (from.y + end.y) / 2 - text.height / 2 });
	}
	result.width = Math.max(...nodes.map((node) => node.x + node.width));
	result.height = Math.max(...nodes.map((node) => node.y + node.height));
	return true;
}

// Rendered-diagram helpers below run in the browser only (review.js calls
// them after mermaid renders); they touch no DOM at import time.

// Alpha compositing and WCAG 2 contrast of {r,g,b} colors.
export const composite = (top, bottom, alpha) => ({
	r: top.r * alpha + bottom.r * (1 - alpha),
	g: top.g * alpha + bottom.g * (1 - alpha),
	b: top.b * alpha + bottom.b * (1 - alpha),
});
export const channelLuminance = (value) => {
	const c = value / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const luminance = ({ r, g, b }) => 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
export const contrastRatio = (a, b) => {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
};

export const SHAPE_SELECTOR = 'rect, path, polygon, circle, ellipse';
// A node's or cluster's own outline: its first shape child, or the first
// shape inside a non-label child group (rough/multi-part shapes).
export const shapeOfGroup = (group) => {
	for (const child of group.children) {
		if (child.matches(SHAPE_SELECTOR)) return child;
		if (child.matches('g:not(.label):not(.cluster-label)')) {
			const inner = child.querySelector(SHAPE_SELECTOR);
			if (inner) return inner;
		}
	}
	return null;
};

// Container titles sit top-left, as in conventional architecture diagrams,
// unless edges entering the container would cross them there; then they
// slide right to the leftmost spot along the top the fewest edges cross,
// preferring spots that also leave a clear gap beside the text.
// Geometry is in the SVG's own user units (16px type), so the result is
// independent of how large the diagram is displayed.
export const TITLE = {
	sampleStep: 4, // edge sampling interval; finer than a stroke-width wobble
	slideStep: 8, // candidate title offsets, about half a glyph apart
	inset: 10, // keeps the title off the container's rounded border
	slop: 2, // an edge this close to the text still reads as crossing it
	gap: 10, // an edge this close to the text looks cramped against it
	row: 16, // y-bucket height for edge samples (one line of 16px type)
	band: 24, // depth of the bottom title band an ELK layout can reserve: one 16px line plus margins
	// Spot cost tiers: overlapping a node or edge label rules a spot out;
	// each edge sample through the text outweighs any number merely nearby.
	covered: 1e6,
	through: 1000,
};
export const toRootMatrix = (svgRoot, element) => svgRoot.getScreenCTM().inverse().multiply(element.getScreenCTM());
export const boxInRoot = (svgRoot, element) => {
	const box = element.getBBox();
	const matrix = toRootMatrix(svgRoot, element);
	const a = new DOMPoint(box.x, box.y).matrixTransform(matrix);
	const b = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
	return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
};
// Move an element by (dx, dy) root units: a translate prepended in its
// parent's units, whatever transform mermaid already set on it.
export const shiftInRoot = (svgRoot, element, dx, dy) => {
	const scale = toRootMatrix(svgRoot, element.parentNode).a || 1;
	const shift = svgRoot.createSVGTransform();
	shift.setTranslate(dx / scale, dy / scale);
	element.transform.baseVal.insertItemBefore(shift, 0);
};
export const edgePointRows = (svgRoot) => {
	const rows = new Map();
	svgRoot.querySelectorAll('g.edgePaths path, path.flowchart-link, path.transition').forEach((path) => {
		const length = path.getTotalLength ? path.getTotalLength() : 0;
		if (!length) return;
		const matrix = toRootMatrix(svgRoot, path);
		for (let at = 0; at <= length; at += TITLE.sampleStep) {
			const point = path.getPointAtLength(at).matrixTransform(matrix);
			const row = Math.floor(point.y / TITLE.row);
			if (!rows.has(row)) rows.set(row, []);
			rows.get(row).push(point);
		}
	});
	return rows;
};
// Pairs of flowchart edges whose drawn paths cross away from their ends
// (edges meeting at a shared node don't count), from paths sampled every
// TITLE.sampleStep units. Layout variants compare it because a crossing is
// the one place a reader has to stop and disambiguate which line continues
// where; each variant also requires the drawing not to pan further.
export const edgeCrossings = (svgRoot, endRadius = 12) => {
	// Each path's samples are grouped in runs of CROSSING_RUN segments with
	// their bounding box; only runs whose boxes meet are compared segment by
	// segment, so dense diagrams cost little more than sparse ones.
	const CROSSING_RUN = 12;
	const box = (points) => ({ left: Math.min(...points.map((point) => point.x)), right: Math.max(...points.map((point) => point.x)), top: Math.min(...points.map((point) => point.y)), bottom: Math.max(...points.map((point) => point.y)) });
	const lines = [...svgRoot.querySelectorAll('g.edgePaths path, path.flowchart-link')].map((path) => {
		const length = path.getTotalLength?.() ?? 0;
		const matrix = toRootMatrix(svgRoot, path);
		const points = [];
		for (let at = 0; at <= length; at += TITLE.sampleStep) points.push(path.getPointAtLength(at).matrixTransform(matrix));
		const runs = [];
		for (let start = 1; start < points.length; start += CROSSING_RUN) {
			const end = Math.min(points.length, start + CROSSING_RUN);
			runs.push({ start, end, box: box(points.slice(start - 1, end)) });
		}
		return Object.assign(points, { runs, box: points.length ? box(points) : null });
	}).filter((points) => points.length > 1);
	const meet = (a, b) => a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
	const cross = (p, q, r, t) => {
		const side = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
		return side(p, q, r) * side(p, q, t) < 0 && side(r, t, p) * side(r, t, q) < 0;
	};
	const nearEnd = (point, ...ends) => ends.some((end) => Math.hypot(point.x - end.x, point.y - end.y) < endRadius);
	const crosses = (a, b) => {
		const ends = [a[0], a.at(-1), b[0], b.at(-1)];
		for (const runA of a.runs) for (const runB of b.runs) {
			if (!meet(runA.box, runB.box)) continue;
			for (let k = runA.start; k < runA.end; k++) {
				if (nearEnd(a[k], ...ends)) continue;
				for (let m = runB.start; m < runB.end; m++) if (cross(a[k - 1], a[k], b[m - 1], b[m])) return true;
			}
		}
		return false;
	};
	let count = 0;
	for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (meet(lines[i].box, lines[j].box) && crosses(lines[i], lines[j])) count++;
	return count;
};
// When every spot along the top is crossed, the title may move to the same
// inset along the bottom, if the container has a clear band there (see
// TITLE.band) and the spot is clear of nodes and edge labels. A spot is
// crossed when an edge runs through the title text.
const boxContains = (outer, inner) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
// Plans are computed once per rendered SVG, before any title moves: the
// acceptance checks and the final placement share one plan.
const titlePlans = new WeakMap();
export const planClusterTitles = (svgRoot) => {
	if (!titlePlans.has(svgRoot)) titlePlans.set(svgRoot, computeTitlePlan(svgRoot));
	return titlePlans.get(svgRoot);
};
const computeTitlePlan = (svgRoot) => {
	const rows = edgePointRows(svgRoot);
	const boxes = (selector) => [...svgRoot.querySelectorAll(selector)].map((element) => boxInRoot(svgRoot, element)).filter((box) => box.right - box.left >= 1);
	// Nodes, plus nested containers' outlines and titles.
	const contents = [...boxes('g.node'), ...[...svgRoot.querySelectorAll('g.cluster')].map((cluster) => shapeOfGroup(cluster)).filter(Boolean).map((shape) => boxInRoot(svgRoot, shape)), ...boxes('g.cluster > .cluster-label')];
	const obstacles = [...contents, ...boxes('g.edgeLabel')];
	const plan = [];
	for (const cluster of svgRoot.querySelectorAll('g.cluster')) {
		const shape = shapeOfGroup(cluster);
		const label = cluster.querySelector(':scope > .cluster-label');
		if (!shape || !label) continue;
		const box = boxInRoot(svgRoot, shape);
		const title = boxInRoot(svgRoot, label);
		if (box.right <= box.left || title.right <= title.left) continue;
		// This container's own outline and title, and its ancestors' outlines, never obstruct.
		const own = (other) => boxContains(other, box) || ['left', 'top', 'right', 'bottom'].every((side) => Math.abs(other[side] - title[side]) < 0.5);
		const spotAt = (dy, ignoreContent = false) => {
			const [textTop, textBottom] = [title.top + dy, title.bottom + dy];
			const [top, bottom] = [textTop - TITLE.gap, textBottom + TITLE.slop];
			const band = [];
			for (let row = Math.floor(top / TITLE.row); row <= Math.floor(bottom / TITLE.row); row++) {
				for (const point of rows.get(row) ?? []) if (point.y > top && point.y < bottom) band.push(point);
			}
			const spot = { label, dx: 0, dy, hits: Infinity };
			for (let dx = box.left + TITLE.inset - title.left; dx <= box.right - TITLE.inset - title.right && spot.hits > 0; dx += TITLE.slideStep) {
				const near = (margin) => band.filter(({ x, y }) => y > textTop - margin && x > title.left + dx - margin && x < title.right + dx + margin).length;
				const covered = !ignoreContent && obstacles.some((other) => !own(other) && other.left < title.right + dx && other.right > title.left + dx && other.top < textBottom && other.bottom > textTop);
				const hits = (covered ? TITLE.covered : 0) + near(TITLE.slop) * TITLE.through + near(TITLE.gap);
				if (hits < spot.hits) Object.assign(spot, { dx, hits });
			}
			spot.crossed = spot.hits >= TITLE.through;
			return spot;
		};
		const top = spotAt(0);
		const inside = contents.filter((other) => !own(other) && boxContains(box, other));
		const bandDepth = box.bottom - Math.max(box.top, ...inside.map((other) => other.bottom));
		const bottom = top.crossed && bandDepth >= TITLE.band ? spotAt(box.bottom - title.bottom - (title.top - box.top)) : top;
		const spot = bottom.hits < top.hits ? bottom : top;
		// Without a bottom band yet, whether one would help: are the edges
		// leaving through the bottom border clear of some title position?
		const bottomWouldClear = spot.crossed && bandDepth < TITLE.band && !spotAt(box.bottom - (title.top + title.bottom) / 2, true).crossed;
		plan.push({ ...spot, cluster, width: title.right - title.left, bottomWouldClear });
	}
	return plan;
};
export const placeClusterTitles = (svgRoot) => {
	for (const { label, dx, dy } of planClusterTitles(svgRoot)) if (dx || dy) shiftInRoot(svgRoot, label, dx, dy);
};

// Mermaid centers each edge label on its path's midpoint, so labels on edges
// that run side by side (a request and its reply) stack on each other. A label
// that would overlap a node or an already-placed label slides along its own
// path to the nearest clear spot in LABEL_SLIDE order (fractions of length).
export const LABEL_SLIDE = [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8];
export const placeEdgeLabels = (svgRoot) => {
	const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
	const placed = [...svgRoot.querySelectorAll('g.node')].map((node) => boxInRoot(svgRoot, node));
	const paths = new Map([...svgRoot.querySelectorAll('path[data-id]')].map((path) => [path.dataset.id, path]));
	for (const label of svgRoot.querySelectorAll('g.edgeLabel')) {
		const box = boxInRoot(svgRoot, label);
		if (box.right - box.left < 1) continue;
		const id = label.querySelector('.label[data-id]')?.dataset.id;
		const path = id ? paths.get(id) : null;
		const length = path?.getTotalLength() ?? 0;
		let final = box;
		if (length && placed.some((other) => overlaps(other, box))) {
			const matrix = toRootMatrix(svgRoot, path);
			const center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
			for (const fraction of LABEL_SLIDE) {
				const point = path.getPointAtLength(fraction * length).matrixTransform(matrix);
				const [dx, dy] = [point.x - center.x, point.y - center.y];
				const moved = { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy };
				if (placed.some((other) => overlaps(other, moved))) continue;
				shiftInRoot(svgRoot, label, dx, dy);
				final = moved;
				break;
			}
		}
		placed.push(final);
	}
};
