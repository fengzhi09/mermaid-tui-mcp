// tests/evals/eval-07-oversized.test.mjs
//
// From evals.xml <eval id="7">:
//   <question>Try to render a 250 KB Mermaid source. (The user pastes a
//   very long script.)</question>
//   <expected>The tool rejects the input with "mermaid source too long
//   (X chars, max 200000)". The assistant tells the user the size limit
//   and asks for a smaller diagram or suggests splitting it.</expected>
//
// Contract under test:
//   - render(oversizedCode(200_001)) throws an Error whose message
//     contains both "mermaid source too long" and "200001". The exact
//     char count is included so the assistant can echo the offending
//     size to the user.
import { describe, expect, it } from "vitest";

import { oversizedCode } from "../helpers/render-fixture.mjs";
import { render } from "../../src/render.mjs";

describe("eval-07: 200_001-char mermaid source is rejected with size in the error message", () => {
	it("throws an error containing 'mermaid source too long' and '200001'", async () => {
		const code = oversizedCode(200_001);
		let caught;
		try {
			await render(code);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught.message).toContain("mermaid source too long");
		expect(caught.message).toContain("200001");
	});
});
