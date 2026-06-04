// tests/evals/eval-04-malformed.test.mjs
//
// From evals.xml <eval id="4">:
//   <question>Render this Mermaid: graph TD\n  A--&gt;|wrong syntax here| B</question>
//   <expected>Mermaid rejects the input. The tool returns isError=true with
//   "mermaid parse error: ..." and the assistant shows the error to the
//   user, suggests a fix (e.g. "missing `&gt;` for arrow direction, or use
//   `A--&gt;|label|B`"), and either retries with the fix or asks the user
//   to confirm the corrected diagram.</expected>
//
// Contract under test:
//   - Passing MALFORMED to render() throws an Error whose message starts
//     with "mermaid parse error:". The renderer wraps the underlying
//     mermaid throw in a distinct prefix so the gsd-pi extension can
//     show a useful user-facing message.
import { describe, expect, it } from "vitest";

import { MALFORMED } from "../helpers/render-fixture.mjs";
import { render } from "../../src/render.mjs";

describe("eval-04: malformed mermaid source throws a 'mermaid parse error:' Error", () => {
	it("rejects MALFORMED with an error message that starts with 'mermaid parse error:'", async () => {
		await expect(render(MALFORMED)).rejects.toThrow(/^mermaid parse error:/);
	});
});
