// tests/unit/sanity.test.mjs — proves vitest is wired correctly before we
// write any real assertions. If this ever fails, the framework config is
// broken; fix vitest setup first.

import { describe, it, expect } from "vitest";

describe("vitest sanity", () => {
	it("arithmetic works", () => {
		expect(1 + 1).toBe(2);
	});
});
