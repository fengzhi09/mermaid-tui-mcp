// tests/helpers/render-fixture.mjs — shared Mermaid source strings used
// across unit and eval tests. Centralised so a tweak in one place keeps
// the contract in one spot.

export const VALID_GRAPH = "graph TD\n  A-->B";

export const VALID_GANTT = "gantt\n  title A\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2026-01-01, 5d";

// Intentionally invalid: `A-->>B` uses an arrow type that mermaid 11's parser
// rejects with a clear "Expecting 'AMP', 'COLON'" parse error. (The previous
// fixture `A -->|label| B` rendered cleanly in mermaid 11, so the test no
// longer exercised the parse-error path — fixed during T02.)
export const MALFORMED = "graph TD\n  A-->>B";

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
