// tests/unit/errors.test.mjs — unit tests for src/errors.mjs.
//
// R020 contract (extended by S03): the inner CallToolResult payload uses
// a stable code set (-32602, -32001..-32009) and a small set of classifier
// helpers. These tests pin the codes, the retryable flags, the classifier
// behavior, and the wire shape produced by renderError() so future
// refactors don't silently drift the public error contract.
//
// Per S01 follow-up "S03 must not pollute unit-test silence", no real
// stderr / stdout / filesystem is touched. Pure module, pure tests.

import { describe, expect, it } from "vitest";

import {
	ErrorCode,
	RenderTimeoutError,
	RenderFailedError,
	JsdomInitError,
	StorageReadError,
	PortInUseError,
	McpProtocolError,
	classifyZodError,
	classifyDomainError,
	renderError,
} from "../../src/errors.mjs";
import { NotFoundError } from "../../src/tools.mjs";

describe("ErrorCode (R020 namespace)", () => {
	it("freezes the enum — assignment to a key throws (or silently fails in non-strict mode)", () => {
		// Object.freeze is a no-op in non-strict mode for plain assignment,
		// but in ESM the test file runs in strict mode, so the assignment
		// throws TypeError. Either outcome proves the enum is locked.
		try {
			ErrorCode.RenderTimeout = 0;
		} catch (e) {
			expect(e).toBeInstanceOf(TypeError);
		}
		expect(ErrorCode.RenderTimeout).toBe(-32001);
	});

	it("all 8 documented codes are present with the correct numeric values", () => {
		expect(ErrorCode.InvalidParams).toBe(-32602);
		expect(ErrorCode.RenderTimeout).toBe(-32001);
		expect(ErrorCode.RenderFailed).toBe(-32002);
		expect(ErrorCode.JsdomInitFailed).toBe(-32003);
		expect(ErrorCode.StorageWriteFailed).toBe(-32004);
		expect(ErrorCode.StorageReadFailed).toBe(-32005);
		expect(ErrorCode.PortInUse).toBe(-32008);
		expect(ErrorCode.McpProtocolViolation).toBe(-32009);
	});
});

describe("tagged error classes", () => {
	it("RenderTimeoutError extends Error and exposes code=-32001, retryable=true, name='RenderTimeoutError'", () => {
		const e = new RenderTimeoutError("render exceeded 10s");
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe(-32001);
		expect(e.retryable).toBe(true);
		expect(e.name).toBe("RenderTimeoutError");
		expect(e.message).toBe("render exceeded 10s");
	});

	it("RenderFailedError: code=-32002, retryable=false", () => {
		const e = new RenderFailedError("mermaid parse error: bad token");
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe(-32002);
		expect(e.retryable).toBe(false);
		expect(e.name).toBe("RenderFailedError");
	});

	it("JsdomInitError: code=-32003, retryable=true", () => {
		const e = new JsdomInitError("jsdom init failed twice");
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe(-32003);
		expect(e.retryable).toBe(true);
		expect(e.name).toBe("JsdomInitError");
	});

	it("StorageReadError is retryable:true (distinct from NotFoundError which is retryable:false — both -32005)", () => {
		// The locked assertion from the slice plan: both classes share the
		// code -32005 but have opposite retryable flags. Documenting this
		// here so a future "unify the flags" refactor fails loudly.
		const read = new StorageReadError("read timeout 5s");
		const nf = new NotFoundError("diagram not found: m123");
		expect(read.code).toBe(-32005);
		expect(nf.code).toBe(-32005);
		expect(read.retryable).toBe(true);
		expect(nf.retryable).toBe(false);
		// And of course they're different classes (so `instanceof` is meaningful).
		expect(read).toBeInstanceOf(StorageReadError);
		expect(nf).toBeInstanceOf(NotFoundError);
		expect(read).not.toBeInstanceOf(NotFoundError);
		expect(nf).not.toBeInstanceOf(StorageReadError);
	});

	it("PortInUseError: code=-32008, retryable=true", () => {
		const e = new PortInUseError("5300, 5301, 5302 all in use");
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe(-32008);
		expect(e.retryable).toBe(true);
		expect(e.name).toBe("PortInUseError");
	});

	it("McpProtocolError: code=-32009, retryable=false", () => {
		const e = new McpProtocolError("missing arguments object");
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe(-32009);
		expect(e.retryable).toBe(false);
		expect(e.name).toBe("McpProtocolError");
	});
});

describe("classifyZodError()", () => {
	it("joins a multi-issue zod error with '; ' separator and returns code=-32602, retryable=false", () => {
		const zodErr = {
			issues: [
				{ path: ["code"], message: "String must contain at least 1 character" },
				{ path: ["title"], message: "String must contain at most 200 characters" },
			],
		};
		const out = classifyZodError(zodErr);
		expect(out.code).toBe(-32602);
		expect(out.retryable).toBe(false);
		expect(out.message).toBe(
			"code: String must contain at least 1 character; title: String must contain at most 200 characters",
		);
	});

	it("falls back to a generic 'invalid input' message for an empty issues array", () => {
		const out = classifyZodError({ issues: [] });
		expect(out.code).toBe(-32602);
		expect(out.retryable).toBe(false);
		expect(out.message).toBe("invalid input");
	});

	it("tolerates a null / undefined / non-zod input without throwing", () => {
		expect(() => classifyZodError(null)).not.toThrow();
		expect(() => classifyZodError(undefined)).not.toThrow();
		expect(() => classifyZodError({})).not.toThrow();
		const out = classifyZodError(null);
		expect(out.code).toBe(-32602);
		expect(out.retryable).toBe(false);
	});
});

describe("classifyDomainError()", () => {
	it("preserves the code on a tagged error (RenderTimeoutError → -32001)", () => {
		// The locked assertion: an error that already carries `.code` is
		// passed through unchanged (so the registerTools wrapper can rely
		// on classifyDomainError for both tagged and un-tagged errors).
		const e = new RenderTimeoutError("10s budget exceeded");
		const out = classifyDomainError(e);
		expect(out.code).toBe(-32001);
		expect(out.message).toBe("10s budget exceeded");
		expect(out.retryable).toBe(true); // inherits from the tagged class
	});

	it("preserves the code on a NotFoundError (S02 tagged class, -32005, retryable:false)", () => {
		const e = new NotFoundError("diagram not found: m123");
		const out = classifyDomainError(e);
		expect(out.code).toBe(-32005);
		expect(out.retryable).toBe(false);
		expect(out.message).toBe("diagram not found: m123");
	});

	it("maps 'mermaid parse error: ...' (src/render.mjs throw site) to -32002 (RenderFailed)", () => {
		// This is one of the 3 known prefixes from src/render.mjs. We
		// match on the message substring (NOT a `code` property) so
		// render.mjs stays a pure renderer with no dependency on this
		// module. Preserves the original message text so the 9 existing
		// eval tests' substring assertions still pass.
		const err = new Error("mermaid parse error: Lexical error on line 3");
		const out = classifyDomainError(err);
		expect(out.code).toBe(-32002);
		expect(out.retryable).toBe(false);
		expect(out.message).toBe("mermaid parse error: Lexical error on line 3");
	});

	it("maps 'mermaid source too long (200001 chars, max 200000)' (eval-07 surface) to -32602 (InvalidParams)", () => {
		// eval-07 asserts on this exact message text. We MUST NOT rewrite
		// the message — only pick the right code. The wrapper will see
		// retryable:false and isError:true, and the client can render the
		// "too long" hint without trying to shorten the input for the user.
		const err = new Error("mermaid source too long (200001 chars, max 200000)");
		const out = classifyDomainError(err);
		expect(out.code).toBe(-32602);
		expect(out.retryable).toBe(false);
		expect(out.message).toBe("mermaid source too long (200001 chars, max 200000)");
	});

	it("maps 'empty mermaid source' (src/render.mjs throw site) to -32602 (InvalidParams)", () => {
		const err = new Error("empty mermaid source");
		const out = classifyDomainError(err);
		expect(out.code).toBe(-32602);
		expect(out.retryable).toBe(false);
		expect(out.message).toBe("empty mermaid source");
	});

	it("falls back to -32603 (InternalError) for an unrecognized error message", () => {
		// The default branch surfaces as JSON-RPC -32603 via the
		// registerTools wrapper re-throw, but classifyDomainError itself
		// returns a structured shape so direct callers (unit tests) don't
		// crash on unexpected errors.
		const out = classifyDomainError(new Error("something exotic blew up"));
		expect(out.code).toBe(-32603);
		expect(out.retryable).toBe(false);
		expect(out.message).toBe("something exotic blew up");
	});

	it("handles non-Error throws (string, number, null) without throwing", () => {
		expect(() => classifyDomainError("oops")).not.toThrow();
		expect(() => classifyDomainError(42)).not.toThrow();
		expect(() => classifyDomainError(null)).not.toThrow();
		expect(() => classifyDomainError(undefined)).not.toThrow();
		const out = classifyDomainError("oops");
		expect(out.code).toBe(-32603);
		expect(out.message).toBe("oops");
	});
});

describe("renderError()", () => {
	it("produces the {isError:true, content:[{type:'text', text:JSON.stringify({error:{...}})}]} wire shape", () => {
		const out = renderError({ code: -32001, message: "render timed out", retryable: true });
		expect(out.isError).toBe(true);
		expect(Array.isArray(out.content)).toBe(true);
		expect(out.content).toHaveLength(1);
		const c0 = out.content[0];
		expect(c0.type).toBe("text");
		// text is a JSON-encoded object with an `error` key.
		const parsed = JSON.parse(c0.text);
		expect(parsed).toEqual({ error: { code: -32001, message: "render timed out", retryable: true } });
	});

	it("preserves extra fields (e.g. port, host) inside the inner error object", () => {
		// T05's port-fallback path will call renderError({code:-32008, message,
		// retryable:true, port:5300, host:'127.0.0.1'}). The wire shape must
		// keep those diagnostic fields in the inner object so the /health
		// last_errors ring and structured logs have something useful to read.
		const out = renderError({
			code: -32008,
			message: "all ports in use",
			retryable: true,
			port: 5300,
			host: "127.0.0.1",
		});
		const parsed = JSON.parse(out.content[0].text);
		expect(parsed.error).toEqual({
			code: -32008,
			message: "all ports in use",
			retryable: true,
			port: 5300,
			host: "127.0.0.1",
		});
		// Stable field order: code, message, retryable, then the rest in
		// insertion order. Locks the wire shape so log shippers and
		// downstream parsers can rely on key position.
		const keys = Object.keys(parsed.error);
		expect(keys[0]).toBe("code");
		expect(keys[1]).toBe("message");
		expect(keys[2]).toBe("retryable");
		expect(keys.slice(3)).toEqual(["port", "host"]);
	});
});

describe("re-exports from src/tools.mjs (the historical single seam)", () => {
	it("the 6 new error classes + classifiers + ErrorCode are importable from src/tools.mjs", async () => {
		// S02 callers have always imported error classes from src/tools.mjs.
		// S03 preserves that surface: everything new in src/errors.mjs is
		// re-exported so the import site does not need to change.
		const tools = await import("../../src/tools.mjs");
		expect(tools.RenderTimeoutError).toBe(RenderTimeoutError);
		expect(tools.RenderFailedError).toBe(RenderFailedError);
		expect(tools.JsdomInitError).toBe(JsdomInitError);
		expect(tools.StorageReadError).toBe(StorageReadError);
		expect(tools.PortInUseError).toBe(PortInUseError);
		expect(tools.McpProtocolError).toBe(McpProtocolError);
		expect(tools.classifyDomainError).toBe(classifyDomainError);
		expect(tools.classifyZodError).toBe(classifyZodError);
		expect(tools.ErrorCode).toBe(ErrorCode);
		// And the 2 S02 classes still live in src/tools.mjs.
		expect(tools.NotFoundError).toBe(NotFoundError);
	});
});
