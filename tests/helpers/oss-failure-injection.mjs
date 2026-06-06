// tests/helpers/oss-failure-injection.mjs — fake S3-compatible HTTP server
// for runtime OSS failure injection (M003/S03/S01/T03 integration test).
//
// Purpose: provide a real S3-compatible HTTP endpoint that the mermaid
// server can point MERMAID_OSS_ENDPOINT at, with controllable failure
// behaviour. The mermaid server uses the real @aws-sdk/client-s3 client
// (no test seam to swap in a stub — the only test seam is
// __resetLastClientForTesting() in src/storage/OssStorage.mjs, which
// returns the constructed client but does not let tests inject a
// different one). So the "stub" lives at the network layer: a tiny HTTP
// server that speaks enough of the S3 XML protocol to drive the
// OssStorage happy-path, and can be flipped to return 500 InternalError
// on demand to simulate runtime OSS failure.
//
// Why a real S3 endpoint (not a stub client) is the right seam:
//   - The integration test goal is to lock the full production stack
//     (server.mjs boot → OssStorageFromEnv → S3Client → DegradableStorage
//     → /health surface) under a runtime-failure scenario. Stubbing the
//     S3 client would skip the SDK's serialization, signing, retry
//     layers — exactly the layers that are most likely to fail at
//     runtime in production. A fake S3 server exercises them.
//   - A 200-byte fake S3 handler is enough for the
//     HeadBucket/GetObject/PutObject/DeleteObject operations the
//     OssStorage surface uses. The S3 XML protocol only requires the
//     happy-path response shape; OssStorage does not parse the body
//     for anything other than the entry JSON in store.json.
//
// Two modes (toggled at runtime via the returned control surface):
//   - failMode:  every request gets 500 InternalError with an XML body
//     shaped like S3's <Error> envelope. The S3 SDK throws an
//     InternalError after maxAttempts retries; OssStorage classifies
//     this as "unknown" and throws StorageWriteError without retry;
//     DegradableStorage catches and bumps the breaker. The failure
//     bubbles up to the MCP render call as a successful fallback (the
//     fallback LocalFsStorage.put completes the call).
//   - okMode:    every request gets a real S3-shaped success response:
//     HeadBucket 200, PutObject 200 with ETag, GetObject 200 with the
//     stored body (or "{}" for store.json), DeleteObject 204. This is
//     the recovery path the half-open probe exercises.
//
// The mode is a single boolean on the FakeS3 instance — flipping it
// mid-test is safe (the server doesn't queue requests; the next
// incoming request observes the new mode).

import { createServer } from "node:http";
import { createServer as netCreateServer } from "node:net";

/** Build the standard S3 <Error> XML body. The shape mirrors what real
 *  S3 returns on InternalError so the S3 SDK's error parser does not
 *  crash and fall back to a generic UnknownError. */
function s3ErrorXml(code, message) {
	return `<?xml version="1.0" encoding="UTF-8"?>`
		+ `<Error><Code>${code}</Code><Message>${message}</Message>`
		+ `<RequestId>fake-s3</RequestId><HostId>fake-s3</HostId></Error>`;
}

/** Build the success body for GetObject. The OssStorage layer reads
 *  store.json as JSON and blobs/<id>.svg as raw SVG; everything else
 *  is a 404-shaped miss and OssStorage handles it. For the success
 *  mode the fake just returns `{}` for store.json and the body
 *  verbatim for blobs. */
function s3GetObjectBody(path) {
	if (path.endsWith("/store.json")) return "{}";
	// Blobs live under blobs/<id>.svg — empty SVG is valid and lets
	// the put/save round-trip complete.
	return "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
}

/** Pick a free port on 127.0.0.1 (mirrors getFreePort in
 *  tests/integration/http.test.mjs). */
async function pickFreePort() {
	return new Promise((resolve, reject) => {
		const srv = netCreateServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (!addr || typeof addr === "string") {
				srv.close();
				reject(new Error("could not get free port"));
				return;
			}
			const { port } = addr;
			srv.close(() => resolve(port));
		});
	});
}

/**
 * Start a fake S3 server on 127.0.0.1:<free-port>. Returns a control
 * object with:
 *   - endpoint:        "http://127.0.0.1:<port>" (paste into MERMAID_OSS_ENDPOINT)
 *   - requestCount:    total HTTP requests received (any method/path)
 *   - putObjectCount:  PUT requests only (PutObject + DeleteObject are
 *                      writes; DegradableStorage's failure path does
 *                      not call primary once breaker is open, so this
 *                      count should FREEZE after the breaker opens)
 *   - startFailing():  switch to failMode (500 on every request)
 *   - startSucceeding(): switch to okMode (valid S3 responses)
 *   - stop():          close the HTTP server
 *   - port:            the port number (for diagnostic logging)
 *
 * The default mode is `startFailing()` — the integration test is
 * "runtime OSS failure", so the boot path's load() call should fail
 * immediately. startSucceeding() is the recovery path the half-open
 * probe needs.
 *
 * @returns {Promise<{
 *   endpoint: string,
 *   port: number,
 *   requestCount: number,
 *   putObjectCount: number,
 *   startFailing: () => void,
 *   startSucceeding: () => void,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function startFakeS3Server() {
	const port = await pickFreePort();
	const state = {
		// 'fail' returns 500 for everything; 'ok' returns valid S3
		// responses. The control methods flip this. The S3 SDK
		// observes the new mode on the next request that comes in.
		mode: "fail",
		requestCount: 0,
		putObjectCount: 0,
	};
	const server = createServer(async (req, res) => {
		state.requestCount += 1;
		const method = (req.method || "GET").toUpperCase();
		const url = req.url || "/";
		if (method === "PUT" || method === "DELETE") {
			state.putObjectCount += 1;
		}
		// Drain the request body so the socket can be reused.
		// The OssStorage path sends a small body (<= a few KB) for
		// PutObject; consuming it via a for-await loop is enough.
		for await (const _chunk of req) { /* drain */ }

		if (state.mode === "fail") {
			// 500 InternalError with the S3 XML envelope — the SDK
			// parses this and throws InternalError after maxAttempts
			// retries. OssStorage's _classifyWriteError maps
			// InternalError to "unknown" → no retry → StorageWriteError
			// → DegradableStorage records the failure. The breaker
			// counts once per primary call (not per S3 HTTP call).
			res.writeHead(500, { "Content-Type": "application/xml" });
			res.end(s3ErrorXml("InternalError", "fake s3: forced failure for test"));
			return;
		}

		// okMode — dispatch by method/path.
		const parsed = new URL(url, `http://127.0.0.1:${port}`);
		if (method === "HEAD") {
			// HeadBucket — the bucket exists.
			res.writeHead(200, { "x-amz-bucket-region": "us-east-1" });
			res.end();
			return;
		}
		if (method === "PUT") {
			// PutObject — store the ETag (OssStorage doesn't read it).
			res.writeHead(200, { ETag: "\"fake-s3-etag\"" });
			res.end();
			return;
		}
		if (method === "GET") {
			// GetObject — return a real-looking body. OssStorage reads
			// the body via body.transformToString("utf-8"); the
			// @aws-sdk/node-http-handler in v3 wraps any string body
			// in a stream that exposes transformToString, so returning
			// a plain string from a Node http handler works.
			const body = s3GetObjectBody(parsed.pathname);
			res.writeHead(200, {
				"Content-Type": parsed.pathname.endsWith("/store.json")
					? "application/json"
					: "image/svg+xml",
				"Content-Length": String(Buffer.byteLength(body)),
			});
			res.end(body);
			return;
		}
		if (method === "DELETE") {
			res.writeHead(204);
			res.end();
			return;
		}
		res.writeHead(405, { "Content-Type": "application/xml" });
		res.end(s3ErrorXml("MethodNotAllowed", "fake s3: method not allowed"));
	});
	await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
	return {
		endpoint: `http://127.0.0.1:${port}`,
		port,
		get requestCount() { return state.requestCount; },
		get putObjectCount() { return state.putObjectCount; },
		startFailing() { state.mode = "fail"; },
		startSucceeding() { state.mode = "ok"; },
		stop() {
			return new Promise((resolveClose) => {
				server.close(() => resolveClose());
				// Force-close idle keep-alive connections so the test
				// harness does not hang on close.
				server.closeAllConnections && server.closeAllConnections();
			});
		},
	};
}
