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
const ARROW = /(?:--+>?|==+>?|-\.+->?|--[xo]|<--+|o--|x--)/;
const IDENT = /[A-Za-z0-9_]+/;

/** Enumerate node ids and directed edge pairs from one mermaid source. */
export function parseMermaidElements(source) {
	const nodes = new Set();
	const edges = new Set();
	const lines = String(source ?? "").split(/\r?\n/);
	const header = lines.find((line) => line.trim())?.trim().toLowerCase() ?? "";
	const kind = /^(flowchart|graph)\b/.test(header) ? "flowchart" : /^statediagram/.test(header) ? "state" : "other";
	if (kind === "other") return { kind, nodes, edges };
	for (let raw of lines.slice(1)) {
		let line = raw.replace(/%%.*$/, "").trim();
		if (!line || /^(classDef|class|style|linkStyle|click|direction|subgraph|end\b)/.test(line)) {
			// Subgraph ids are containers, not clickable nodes; class statements
			// reference nodes that must already be defined elsewhere.
			continue;
		}
		// Label bodies and ::: class shorthand are prose/annotations, never ids:
		// strip both before any scan so "api[API (v2)]" and "a:::hot" read as
		// just their identifiers.
		line = line.replace(/\|[^|]*\|/g, "|").replace(/\[[^\]]*\]/g, "[]").replace(/\(+[^()]*\)+/g, "()").replace(/\{[^}]*\}/g, "{}").replace(/:::[A-Za-z0-9_,]+/g, "");
		// A statement that is just an identifier renders as a bare node.
		if (new RegExp(`^${IDENT.source}$`).test(line)) {
			nodes.add(line);
			continue;
		}
		// Shape definitions: id[Label], id(Label), id{Label}, id((Label)), id>Label]
		for (const match of line.matchAll(new RegExp(`(${IDENT.source})\\s*(?=\\[|\\(|\\{|>)`, "g"))) nodes.add(match[1]);
		// Edges: split on arrows; endpoints are the identifier tail/head of the
		// adjacent parts. Word labels (-- text -->) are collapsed first.
		const stripped = line.replace(/--+\s+[^-<>|]+?\s+--+(>?)/g, "--$1");
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
	return { kind, nodes, edges };
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
	if (match[1] === "edge" && !/^[A-Za-z0-9_]+->[A-Za-z0-9_]+$/.test(match[2])) return undefined;
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
