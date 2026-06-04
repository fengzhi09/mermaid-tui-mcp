// tests/evals/eval-09-pin-tool.test.mjs
//
// From evals.xml <eval id="9">:
//   <question>Pin the diagram we just rendered (id=mabc123) so it doesn't
//   get cleaned up after 7 days.</question>
//   <expected>This is HTTP-only. The stdio MCP path does not expose a pin
//   tool. The assistant tells the user that pinning requires the
//   standalone HTTP daemon (bin/start.sh) and that the fileLink still
//   works in the meantime. If the daemon is running, the assistant
//   explains how to use the view page's pin button (or calls the HTTP
//   /pin endpoint via exec).</expected>
//
// S01 expected: stdio MCP exposes render_mermaid only. S02 will add
// pin_mermaid; replace this it.todo with a real assertion that
// pin_mermaid is in the tools/list response.
//
// Header note: this is a TDD placeholder, not a failure.
import { describe, it } from "vitest";

describe("eval-09: pin_mermaid over stdio MCP — S02 will replace this it.todo with a real assertion", () => {
	it.todo(
		"S01: stdio MCP tools/list only contains render_mermaid (no pin_mermaid yet). " +
			"S02 will add a pin_mermaid tool and flip this to: " +
			"expect(toolNames).toContain('pin_mermaid').",
	);
});
