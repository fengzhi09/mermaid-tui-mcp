// tests/evals/eval-02-three-flows.test.mjs
//
// From evals.xml <eval id="2">:
//   <question>I need to compare three auth flows: OAuth2 authorization-code,
//   OAuth2 client-credentials, and OIDC implicit. Render a single Mermaid
//   diagram showing all three side by side.</question>
//   <expected>The assistant calls render_mermaid once (not three times) with
//   a single diagram that contains all three flows. After the ASCII +
//   fileLink are returned, the assistant presents them as the answer.</expected>
//
// Contract under test:
//   - A single call to render() against a flowchart containing three
//     subgraphs (OAuth2 auth-code, OAuth2 client-creds, OIDC implicit)
//     succeeds, returns exactly one id, and produces non-empty output.
import { describe, expect, it } from "vitest";

import { render } from "../../src/render.mjs";

const THREE_FLOWS = [
	"flowchart TD",
	'  subgraph AuthCode["OAuth2 Authorization Code"]',
	"    direction TB",
	"    U1[User] --> RP1[Relying Party]",
	"    RP1 --> AS1[Auth Server]",
	"    AS1 --> U1",
	"    AS1 --> RP1",
	"    RP1 --> AS1",
	"    AS1 --> RP1",
	"  end",
	'  subgraph ClientCreds["OAuth2 Client Credentials"]',
	"    direction TB",
	"    S1[Service] --> AS2[Auth Server]",
	"    AS2 --> S1",
	"  end",
	'  subgraph Implicit["OIDC Implicit"]',
	"    direction TB",
	"    U2[User] --> RP2[Relying Party]",
	"    RP2 --> AS3[Auth Server]",
	"    AS3 --> U2",
	"    AS3 --> RP2",
	"  end",
].join("\n");

describe("eval-02: three auth flows render in a single call (one id, one diagram)", () => {
	it("returns a single { id, svg, ascii, sourceLength } for a 3-subgraph flowchart", async () => {
		const result = await render(THREE_FLOWS);

		// exactly one id (one call -> one diagram)
		expect(typeof result.id).toBe("string");
		expect(result.id.length).toBeGreaterThan(0);
		expect(result.id).toMatch(/^m[a-z0-9]+$/);

		// both representations are populated (svg for the file:// viewer,
		// ascii for the terminal fallback)
		expect(typeof result.svg).toBe("string");
		expect(result.svg.length).toBeGreaterThan(0);
		expect(result.svg).toContain("<svg");
		expect(typeof result.ascii).toBe("string");
		expect(result.ascii.length).toBeGreaterThan(0);

		// sourceLength reflects the input the caller actually sent
		expect(result.sourceLength).toBe(THREE_FLOWS.length);
	});
});
