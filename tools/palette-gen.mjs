// Synthesizes the semantic-role palette per theme x scheme with WCAG contrast
// enforced by construction (>=4.6 ink-on-fill, >=3 stroke-on-canvas), emitting
// the table for shared/diagram-roles.js. Rerun when tuning hues: adjust the
// ARCH anchors or theme tokens, run, and paste the emitted JSON through the
// same formatting as the existing table. The contrast regression in
// test/regressions.mjs re-verifies whatever lands there.
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const parse = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const CANVAS = { light: parse('#fdfdfc'), dark: parse('#16191d') };
const INK = { light: parse('#1a1c1f'), dark: parse('#f2f3f5') };

// Theme tokens copied from shared/render.js THEMES.
const THEMES = {
  slate:      { light: { ok: '#147a63', danger: '#c03546', warning: '#92600c', accent: '#a04e24' }, dark: { ok: '#4cc2a4', danger: '#ee6a79', warning: '#d4a437', accent: '#e0855a' } },
  manuscript: { light: { ok: '#4a7c2a', danger: '#b03a2e', warning: '#8a6a00', accent: '#8a4f2d' }, dark: { ok: '#8fb960', danger: '#e07856', warning: '#d9a93d', accent: '#d9a066' } },
  iris:       { light: { ok: '#2b7a4b', danger: '#c42b5f', warning: '#96640a', accent: '#5a51c9' }, dark: { ok: '#58bd83', danger: '#f16292', warning: '#d3a53a', accent: '#928af0' } },
  classic:    { light: { ok: '#1a7f37', danger: '#cf222e', warning: '#9a6700', accent: '#0969da' }, dark: { ok: '#3fb950', danger: '#f85149', warning: '#d29922', accent: '#58a6ff' } },
};

// Architecture hue anchors (scheme-shared base; themes may override later).
const ARCH = {
  person:   { light: '#7c4dbe', dark: '#b79ce8' },
  client:   { light: '#0d6bbd', dark: '#7fbcf2' },
  service:  { light: '#0f766e', dark: '#6cd3c2' },
  store:    { light: '#a16207', dark: '#e3b341' },
  queue:    { light: '#be3a72', dark: '#f091bd' },
  external: { light: '#57606e', dark: '#a8b3bf' },
};
const TOKEN_ROLES = { positive: 'ok', negative: 'danger', caution: 'warning', gate: 'accent', milestone: 'accent', new: 'ok', changed: 'warning', removed: 'danger' };

// Build one role entry: fill = anchor tinted toward canvas until ink hits
// >=4.5 on it; stroke = anchor darkened/lightened until >=3 on canvas.
const build = (anchorHex, scheme) => {
  const anchor = parse(anchorHex);
  const canvas = CANVAS[scheme];
  const ink = INK[scheme];
  let fill;
  for (let t = 0.82; t >= 0; t -= 0.02) {
    fill = mix(anchor, canvas, t);
    if (ratio(ink, fill) >= 4.6) { /* keep the strongest tint that still reads */ break; }
  }
  // walk back up to the most saturated fill that still passes
  for (let t = 0; t <= 0.95; t += 0.01) {
    const candidate = mix(anchor, canvas, t);
    if (ratio(ink, candidate) >= 4.6) { fill = candidate; break; }
  }
  let stroke = anchor;
  const target = scheme === 'light' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  for (let t = 0; t <= 1.001; t += 0.02) {
    stroke = mix(anchor, target, t);
    if (ratio(stroke, canvas) >= 3.05) break;
  }
  return { fill: hex(fill), stroke: hex(stroke), ink: hex(ink) };
};

const palettes = {};
for (const [theme, tokens] of Object.entries(THEMES)) {
  palettes[theme] = {};
  for (const scheme of ['light', 'dark']) {
    palettes[theme][scheme] = {};
    for (const [role, anchors] of Object.entries(ARCH)) palettes[theme][scheme][role] = build(anchors[scheme], scheme);
    for (const [role, token] of Object.entries(TOKEN_ROLES)) palettes[theme][scheme][role] = build(tokens[scheme][token], scheme);
  }
}
// Verify every entry.
let worstFill = 99, worstStroke = 99;
for (const theme of Object.keys(palettes)) for (const scheme of ['light', 'dark']) for (const [role, c] of Object.entries(palettes[theme][scheme])) {
  const rf = ratio(parse(c.ink), parse(c.fill));
  const rs = ratio(parse(c.stroke), CANVAS[scheme]);
  worstFill = Math.min(worstFill, rf); worstStroke = Math.min(worstStroke, rs);
  if (rf < 4.5 || rs < 3) console.error('FAIL', theme, scheme, role, rf.toFixed(2), rs.toFixed(2));
}
console.log('worst ink-on-fill:', worstFill.toFixed(2), 'worst stroke-on-canvas:', worstStroke.toFixed(2));
console.log(JSON.stringify(palettes));
