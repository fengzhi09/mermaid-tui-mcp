// tests/helpers/render-fixture.mjs — shared Mermaid source strings used
// across unit and eval tests. Centralised so a tweak in one place keeps
// the contract in one spot.

export const VALID_GRAPH = "graph TD\n  A-->B";

export const VALID_GANTT = "gantt\n  title A\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2026-01-01, 5d";

// Intentionally invalid: `graph XYZ` is not a direction the parser accepts
// (only LR / TD / TB / RL / BT are valid). The mermaid 11 fixture was
// `graph TD\n  A-->>B` (extra `>`) which mermaid 11 rejected, but
// beautiful-mermaid's parser is more lenient on arrow shapes and accepts
// `A-->>B` as a node label. The header check, by contrast, is strict and
// throws "Invalid mermaid header: 'graph XYZ'. Expected 'graph TD',
// 'flowchart LR', ..." — which our render() wraps in the
// "mermaid parse error:" prefix. Fixed during M004.
export const MALFORMED = "graph XYZ\n  A-->B";

/**
 * Build a string of exactly n ASCII chars. The default (200_001) is one
 * over the renderer's 200_000 limit, so callers can assert that the
 * "too long" branch fires without spinning up a real render.
 *
 * @param {number} [n=200_001]
 * @returns {string}
 */
export function oversizedCode(n = 200_001) {
	// Use 'a' so the string passes the type check (non-empty string) and is
	// guaranteed to be n chars long.
	return "a".repeat(n);
}
