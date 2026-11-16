function words(source) {
	const tokens = [];
	let token = "";
	let started = false;
	let quote;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "\\" && quote !== "'" && /[\s"'\\]/.test(source[index + 1] ?? "")) {
			token += source[++index];
			started = true;
		} else if (quote) {
			if (char === quote) quote = undefined;
			else token += char;
		} else if (!started && (char === '"' || char === "'")) {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) tokens.push(token);
			token = "";
			started = false;
		} else {
			token += char;
			started = true;
		}
	}
	if (quote) throw new Error("Unclosed quote in /margin-code arguments.");
	if (started) tokens.push(token);
	return tokens;
}

/**
 * Explicit flags leave the legacy unquoted repository-path form unambiguous.
 * @returns {{ help?: boolean, repoPath?: string, baseRef?: string, headRef?: string }}
 */
export function parseCodeReviewArgs(args) {
	const source = args.trim();
	if (source === "--help" || source === "-h") return { help: true };
	const tokens = words(source);
	if (!tokens.some((token) => /^(--base|--head)(=|$)/.test(token))) {
		return { repoPath: tokens.length === 1 ? tokens[0] : source || undefined };
	}
	const refs = {};
	const path = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--") {
			path.push(...tokens.slice(index + 1));
			break;
		}
		const flag = /^(--base|--head)(?:=(.*))?$/.exec(token);
		if (!flag) {
			if (token.startsWith("--")) throw new Error(`Unknown /margin-code option: ${token}`);
			path.push(token);
			continue;
		}
		const key = flag[1] === "--base" ? "baseRef" : "headRef";
		if (refs[key] !== undefined) throw new Error(`${flag[1]} may only be supplied once.`);
		const value = flag[2] ?? tokens[++index];
		if (!value || value.startsWith("--")) throw new Error(`${flag[1]} requires a commit ref.`);
		refs[key] = value;
	}
	if (!refs.baseRef || !refs.headRef) throw new Error("Both --base and --head are required for a commit-range review.");
	return { ...refs, repoPath: path.length ? path.join(" ") : undefined };
}
