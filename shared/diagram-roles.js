// Semantic diagram roles: the single source of truth for the role
// vocabulary, its per-theme/per-scheme palette, and the parsing that finds
// role references in mermaid sources. Authors tag elements with roles
// (":::store", "class a,b gate"), never colors; the engine renders each role
// from the palette of the active theme and scheme, inlining concrete hex so
// exported SVGs stand alone.
//
// Extending the vocabulary: add the role to DIAGRAM_ROLE_GROUPS and give it
// an entry in every theme/scheme palette below. The contrast regression
// recomputes WCAG ratios for every entry, so a new color that cannot carry
// its label ink (>= 4.5:1) or read against the canvas (>= 3:1) fails loudly.

export const DIAGRAM_ROLE_GROUPS = {
	architecture: ["person", "client", "service", "store", "queue", "external"],
	outcome: ["positive", "negative", "caution", "gate", "milestone"],
	change: ["new", "changed", "removed"],
};

export const DIAGRAM_ROLES = Object.values(DIAGRAM_ROLE_GROUPS).flat();

// Concrete hex per theme x scheme x role. fill carries the label ink, stroke
// reads against the diagram canvas, ink is the label color on the fill.
export const DIAGRAM_ROLE_PALETTES = {
	slate: {
		light: { person: { fill: "#9874cc", stroke: "#7c4dbe", ink: "#1a1c1f" }, client: { fill: "#3f8aca", stroke: "#0d6bbd", ink: "#1a1c1f" }, service: { fill: "#41928c", stroke: "#0f766e", ink: "#1a1c1f" }, store: { fill: "#b07b2e", stroke: "#a16207", ink: "#1a1c1f" }, queue: { fill: "#cb638f", stroke: "#be3a72", ink: "#1a1c1f" }, external: { fill: "#7f8690", stroke: "#57606e", ink: "#1a1c1f" }, positive: { fill: "#409380", stroke: "#147a63", ink: "#1a1c1f" }, negative: { fill: "#cf6572", stroke: "#c03546", ink: "#1a1c1f" }, caution: { fill: "#a67e3a", stroke: "#92600c", ink: "#1a1c1f" }, gate: { fill: "#b57656", stroke: "#a04e24", ink: "#1a1c1f" }, milestone: { fill: "#b57656", stroke: "#a04e24", ink: "#1a1c1f" }, new: { fill: "#409380", stroke: "#147a63", ink: "#1a1c1f" }, changed: { fill: "#a67e3a", stroke: "#92600c", ink: "#1a1c1f" }, removed: { fill: "#cf6572", stroke: "#c03546", ink: "#1a1c1f" } },
		dark: { person: { fill: "#756695", stroke: "#b79ce8", ink: "#f2f3f5" }, client: { fill: "#4f7190", stroke: "#7fbcf2", ink: "#f2f3f5" }, service: { fill: "#41766f", stroke: "#6cd3c2", ink: "#f2f3f5" }, store: { fill: "#836b30", stroke: "#e3b341", ink: "#f2f3f5" }, queue: { fill: "#925d78", stroke: "#f091bd", ink: "#f2f3f5" }, external: { fill: "#666e76", stroke: "#a8b3bf", ink: "#f2f3f5" }, positive: { fill: "#35796a", stroke: "#4cc2a4", ink: "#f2f3f5" }, negative: { fill: "#ab515c", stroke: "#ee6a79", ink: "#f2f3f5" }, caution: { fill: "#846a2c", stroke: "#d4a437", ink: "#f2f3f5" }, gate: { fill: "#995f45", stroke: "#e0855a", ink: "#f2f3f5" }, milestone: { fill: "#995f45", stroke: "#e0855a", ink: "#f2f3f5" }, new: { fill: "#35796a", stroke: "#4cc2a4", ink: "#f2f3f5" }, changed: { fill: "#846a2c", stroke: "#d4a437", ink: "#f2f3f5" }, removed: { fill: "#ab515c", stroke: "#ee6a79", ink: "#f2f3f5" } },
	},
	manuscript: {
		light: { person: { fill: "#9874cc", stroke: "#7c4dbe", ink: "#1a1c1f" }, client: { fill: "#3f8aca", stroke: "#0d6bbd", ink: "#1a1c1f" }, service: { fill: "#41928c", stroke: "#0f766e", ink: "#1a1c1f" }, store: { fill: "#b07b2e", stroke: "#a16207", ink: "#1a1c1f" }, queue: { fill: "#cb638f", stroke: "#be3a72", ink: "#1a1c1f" }, external: { fill: "#7f8690", stroke: "#57606e", ink: "#1a1c1f" }, positive: { fill: "#67914c", stroke: "#4a7c2a", ink: "#1a1c1f" }, negative: { fill: "#c46d64", stroke: "#b03a2e", ink: "#1a1c1f" }, caution: { fill: "#9e832b", stroke: "#8a6a00", ink: "#1a1c1f" }, gate: { fill: "#a87c63", stroke: "#8a4f2d", ink: "#1a1c1f" }, milestone: { fill: "#a87c63", stroke: "#8a4f2d", ink: "#1a1c1f" }, new: { fill: "#67914c", stroke: "#4a7c2a", ink: "#1a1c1f" }, changed: { fill: "#9e832b", stroke: "#8a6a00", ink: "#1a1c1f" }, removed: { fill: "#c46d64", stroke: "#b03a2e", ink: "#1a1c1f" } },
		dark: { person: { fill: "#756695", stroke: "#b79ce8", ink: "#f2f3f5" }, client: { fill: "#4f7190", stroke: "#7fbcf2", ink: "#f2f3f5" }, service: { fill: "#41766f", stroke: "#6cd3c2", ink: "#f2f3f5" }, store: { fill: "#836b30", stroke: "#e3b341", ink: "#f2f3f5" }, queue: { fill: "#925d78", stroke: "#f091bd", ink: "#f2f3f5" }, external: { fill: "#666e76", stroke: "#a8b3bf", ink: "#f2f3f5" }, positive: { fill: "#5b7443", stroke: "#8fb960", ink: "#f2f3f5" }, negative: { fill: "#a15b44", stroke: "#e07856", ink: "#f2f3f5" }, caution: { fill: "#836a2f", stroke: "#d9a93d", ink: "#f2f3f5" }, gate: { fill: "#876747", stroke: "#d9a066", ink: "#f2f3f5" }, milestone: { fill: "#876747", stroke: "#d9a066", ink: "#f2f3f5" }, new: { fill: "#5b7443", stroke: "#8fb960", ink: "#f2f3f5" }, changed: { fill: "#836a2f", stroke: "#d9a93d", ink: "#f2f3f5" }, removed: { fill: "#a15b44", stroke: "#e07856", ink: "#f2f3f5" } },
	},
	iris: {
		light: { person: { fill: "#9874cc", stroke: "#7c4dbe", ink: "#1a1c1f" }, client: { fill: "#3f8aca", stroke: "#0d6bbd", ink: "#1a1c1f" }, service: { fill: "#41928c", stroke: "#0f766e", ink: "#1a1c1f" }, store: { fill: "#b07b2e", stroke: "#a16207", ink: "#1a1c1f" }, queue: { fill: "#cb638f", stroke: "#be3a72", ink: "#1a1c1f" }, external: { fill: "#7f8690", stroke: "#57606e", ink: "#1a1c1f" }, positive: { fill: "#53936d", stroke: "#2b7a4b", ink: "#1a1c1f" }, negative: { fill: "#d26086", stroke: "#c42b5f", ink: "#1a1c1f" }, caution: { fill: "#a87e33", stroke: "#96640a", ink: "#1a1c1f" }, gate: { fill: "#817ad5", stroke: "#5a51c9", ink: "#1a1c1f" }, milestone: { fill: "#817ad5", stroke: "#5a51c9", ink: "#1a1c1f" }, new: { fill: "#53936d", stroke: "#2b7a4b", ink: "#1a1c1f" }, changed: { fill: "#a87e33", stroke: "#96640a", ink: "#1a1c1f" }, removed: { fill: "#d26086", stroke: "#c42b5f", ink: "#1a1c1f" } },
		dark: { person: { fill: "#756695", stroke: "#b79ce8", ink: "#f2f3f5" }, client: { fill: "#4f7190", stroke: "#7fbcf2", ink: "#f2f3f5" }, service: { fill: "#41766f", stroke: "#6cd3c2", ink: "#f2f3f5" }, store: { fill: "#836b30", stroke: "#e3b341", ink: "#f2f3f5" }, queue: { fill: "#925d78", stroke: "#f091bd", ink: "#f2f3f5" }, external: { fill: "#666e76", stroke: "#a8b3bf", ink: "#f2f3f5" }, positive: { fill: "#3c7858", stroke: "#58bd83", ink: "#f2f3f5" }, negative: { fill: "#af4c6f", stroke: "#f16292", ink: "#f2f3f5" }, caution: { fill: "#846a2e", stroke: "#d3a53a", ink: "#f2f3f5" }, gate: { fill: "#6a66ac", stroke: "#928af0", ink: "#f2f3f5" }, milestone: { fill: "#6a66ac", stroke: "#928af0", ink: "#f2f3f5" }, new: { fill: "#3c7858", stroke: "#58bd83", ink: "#f2f3f5" }, changed: { fill: "#846a2e", stroke: "#d3a53a", ink: "#f2f3f5" }, removed: { fill: "#af4c6f", stroke: "#f16292", ink: "#f2f3f5" } },
	},
	classic: {
		light: { person: { fill: "#9874cc", stroke: "#7c4dbe", ink: "#1a1c1f" }, client: { fill: "#3f8aca", stroke: "#0d6bbd", ink: "#1a1c1f" }, service: { fill: "#41928c", stroke: "#0f766e", ink: "#1a1c1f" }, store: { fill: "#b07b2e", stroke: "#a16207", ink: "#1a1c1f" }, queue: { fill: "#cb638f", stroke: "#be3a72", ink: "#1a1c1f" }, external: { fill: "#7f8690", stroke: "#57606e", ink: "#1a1c1f" }, positive: { fill: "#43965a", stroke: "#1a7f37", ink: "#1a1c1f" }, negative: { fill: "#db5b64", stroke: "#cf222e", ink: "#1a1c1f" }, caution: { fill: "#a97e26", stroke: "#9a6700", ink: "#1a1c1f" }, gate: { fill: "#3a87e1", stroke: "#0969da", ink: "#1a1c1f" }, milestone: { fill: "#3a87e1", stroke: "#0969da", ink: "#1a1c1f" }, new: { fill: "#43965a", stroke: "#1a7f37", ink: "#1a1c1f" }, changed: { fill: "#a97e26", stroke: "#9a6700", ink: "#1a1c1f" }, removed: { fill: "#db5b64", stroke: "#cf222e", ink: "#1a1c1f" } },
		dark: { person: { fill: "#756695", stroke: "#b79ce8", ink: "#f2f3f5" }, client: { fill: "#4f7190", stroke: "#7fbcf2", ink: "#f2f3f5" }, service: { fill: "#41766f", stroke: "#6cd3c2", ink: "#f2f3f5" }, store: { fill: "#836b30", stroke: "#e3b341", ink: "#f2f3f5" }, queue: { fill: "#925d78", stroke: "#f091bd", ink: "#f2f3f5" }, external: { fill: "#666e76", stroke: "#a8b3bf", ink: "#f2f3f5" }, positive: { fill: "#2f7c3d", stroke: "#3fb950", ink: "#f2f3f5" }, negative: { fill: "#c0433e", stroke: "#f85149", ink: "#f2f3f5" }, caution: { fill: "#8b6820", stroke: "#d29922", ink: "#f2f3f5" }, gate: { fill: "#3e6fa7", stroke: "#58a6ff", ink: "#f2f3f5" }, milestone: { fill: "#3e6fa7", stroke: "#58a6ff", ink: "#f2f3f5" }, new: { fill: "#2f7c3d", stroke: "#3fb950", ink: "#f2f3f5" }, changed: { fill: "#8b6820", stroke: "#d29922", ink: "#f2f3f5" }, removed: { fill: "#c0433e", stroke: "#f85149", ink: "#f2f3f5" } },
	},
};

/** The palette for a theme and scheme, with slate as the fallback theme. */
export function rolePalette(theme, scheme) {
	const themed = DIAGRAM_ROLE_PALETTES[theme] ?? DIAGRAM_ROLE_PALETTES.slate;
	return themed[scheme === "dark" ? "dark" : "light"];
}

/** CSS custom properties ("--diagram-role-store-fill:#...;...") for a theme and scheme. */
export function roleCssVariables(theme, scheme) {
	const palette = rolePalette(theme, scheme);
	return DIAGRAM_ROLES.map((role) => {
		const color = palette[role];
		return `--diagram-role-${role}-fill:${color.fill};--diagram-role-${role}-stroke:${color.stroke};--diagram-role-${role}-ink:${color.ink}`;
	}).join(";");
}

/**
 * Class names a mermaid source references (":::name" shorthand and
 * "class id1,id2 name" statements) and the names its own classDef lines
 * define. Author-defined classes are the author's business; only referenced,
 * undefined names are candidates for role styling or rejection.
 */
export function collectRoleRefs(source) {
	const referenced = new Set();
	const defined = new Set();
	for (const raw of String(source ?? "").split(/\r?\n/)) {
		const line = raw.replace(/%%.*$/, "").trim();
		const definition = /^classDef\s+([A-Za-z0-9_,-]+)/.exec(line);
		if (definition) {
			for (const name of definition[1].split(",")) if (name) defined.add(name);
			continue;
		}
		const statement = /^class\s+[^\s]+\s+([A-Za-z0-9_-]+)\s*$/.exec(line);
		if (statement) referenced.add(statement[1]);
		for (const shorthand of line.matchAll(/:::([A-Za-z0-9_,-]+)/g)) {
			for (const name of shorthand[1].split(",")) if (name) referenced.add(name);
		}
	}
	return { referenced, defined };
}

/** Roles a source uses from the vocabulary (referenced, not author-defined). */
export function collectDiagramRoles(source) {
	const { referenced, defined } = collectRoleRefs(source);
	return new Set([...referenced].filter((name) => !defined.has(name) && DIAGRAM_ROLES.includes(name)));
}

/** Referenced class names that are neither author-defined nor vocabulary roles. */
export function unknownDiagramRoles(source) {
	const { referenced, defined } = collectRoleRefs(source);
	return [...referenced].filter((name) => !defined.has(name) && !DIAGRAM_ROLES.includes(name));
}

/** The teaching half of an unknown-role rejection. */
export function roleHint() {
	return `roles: ${Object.entries(DIAGRAM_ROLE_GROUPS).map(([group, roles]) => `${group}: ${roles.join(", ")}`).join("; ")} — or define your own classDef of that name`;
}
