// tests/helpers/oss-fixture.mjs — TCP probe + bucket provisioning helpers
// for the real-MinIO integration test (M002/S01/T04).
//
// Why this lives in helpers/ rather than inline in the test:
//   - The TCP probe is reused by the boot regression test
//     (oss-backend-boot.test.mjs) if it ever needs an "is the env
//     wired up" precondition. Centralising the connect logic keeps
//     the test config and the probe in one spot.
//   - The bucket provisioning helper is also reusable for future
//     tests (e.g. an http.test.mjs-style "view the rendered diagram
//     from the HTTP path when backend=oss" integration test) without
//     duplicating the S3 SDK call sequence.
//
// The probe is deliberately a raw net.Socket connect — we don't want
// to drag @aws-sdk/client-s3 into the probe path (the SDK's first
// request to a bad endpoint does a longer-then-shorter retry dance
// and would time out the test). A 1s TCP probe is what the S01 demo
// needs: "is anything listening on the endpoint, yes/no".
//
// All functions are pure (no I/O side-effects) except ensureOssBucket
// (which calls CreateBucket) and the S3 client passed in.

import { connect as netConnect } from "node:net";
import {
	CreateBucketCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

/**
 * Parse an S3 endpoint URL into {host, port}. Accepts http://, https://,
 * and bare host:port (the last form is rare but useful for tests that
 * hard-code 127.0.0.1:9000).
 *
 * @param {string} endpoint
 * @returns {{host: string, port: number}}
 */
export function parseOssEndpoint(endpoint) {
	if (typeof endpoint !== "string" || endpoint.length === 0) {
		throw new TypeError("parseOssEndpoint: endpoint must be a non-empty string");
	}
	let url;
	try {
		url = new URL(endpoint);
	} catch {
		// fall back to host:port (no scheme) — `new URL("127.0.0.1:9000")` throws
		const m = endpoint.match(/^([^:]+):(\d+)$/);
		if (!m) throw new TypeError(`parseOssEndpoint: cannot parse "${endpoint}"`);
		return { host: m[1], port: Number.parseInt(m[2], 10) };
	}
	const port = url.port
		? Number.parseInt(url.port, 10)
		: url.protocol === "https:"
			? 443
			: 80;
	return { host: url.hostname, port };
}

/**
 * Probe an S3 endpoint with a 1s TCP connect. Returns true on a clean
 * connect, false on ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EHOSTUNREACH
 * / EAI_AGAIN. Any other error is also mapped to false (defensive —
 * we want a fast "is the daemon up" answer, not a full backtrace).
 *
 * @param {string} endpoint   e.g. "http://127.0.0.1:9000"
 * @param {number} [timeoutMs=1000]
 * @returns {Promise<boolean>}
 */
export function probeOssEndpoint(endpoint, timeoutMs = 1000) {
	const { host, port } = parseOssEndpoint(endpoint);
	return new Promise((resolveProbe) => {
		const sock = netConnect({ host, port });
		let settled = false;
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* best-effort */ }
			resolveProbe(ok);
		};
		sock.setTimeout(timeoutMs);
		sock.once("connect", () => finish(true));
		sock.once("timeout", () => finish(false));
		sock.once("error", () => finish(false));
		sock.once("close", () => finish(false));
	});
}

/**
 * Probe an endpoint and return its reachability + a human-readable
 * reason. The reason is included in the vitest skip message so an
 * operator running `npm test -- --reporter=verbose` sees exactly
 * why the test file was skipped (was it MERMAID_OSS_ENDPOINT unset?
 * Was the host unreachable?).
 *
 * @param {string|undefined} endpoint
 * @param {number} [timeoutMs]
 * @returns {Promise<{reachable: boolean, reason: string}>}
 */
export async function probeForSkip(endpoint, timeoutMs = 1000) {
	if (!endpoint) {
		return { reachable: false, reason: "MERMAID_OSS_ENDPOINT env is unset" };
	}
	const ok = await probeOssEndpoint(endpoint, timeoutMs);
	if (ok) {
		return { reachable: true, reason: `endpoint ${endpoint} reachable` };
	}
	return { reachable: false, reason: `endpoint ${endpoint} did not accept a TCP connect within ${timeoutMs}ms` };
}

/**
 * Ensure the bucket exists. Calls HeadBucket, and if it returns
 * NoSuchBucket AND the `create` argument is true, calls CreateBucket
 * and returns. On any other HeadBucket error, re-throws (preserves
 * the "bucket exists but is not accessible" surface — the test should
 * fail loudly rather than silently create a fresh bucket).
 *
 * The `create` argument defaults to MERMAID_OSS_CREATE_BUCKET env
 * when undefined, then to false in production posture. Tests should
 * pass `true` (the per-test createBucket is opt-in to keep the
 * prod default conservative).
 *
 * @param {{
 *   send: (cmd: unknown) => Promise<unknown>,
 * }} client
 * @param {string} bucket
 * @param {boolean} [create=false]
 * @returns {Promise<{created: boolean, exists: boolean}>}
 */
export async function ensureOssBucket(client, bucket, create = false) {
	try {
		await client.send(new HeadBucketCommand({ Bucket: bucket }));
		return { created: false, exists: true };
	} catch (e) {
		const name = e && typeof e === "object" ? /** @type {any} */ (e).name : null;
		if (name !== "NoSuchBucket") {
			throw e;
		}
		if (!create) {
			// Caller did not opt in — surface the miss as a non-recoverable
			// error so the test fails loudly with the real reason.
			const err = new Error(`bucket "${bucket}" does not exist and create=false`);
			err.name = "NoSuchBucket";
			throw err;
		}
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
		return { created: true, exists: true };
	}
}

/**
 * Sweep all objects under a prefix. Lists everything (paginated),
 * batches deletes in chunks of 1000 (the S3 limit per
 * DeleteObjects request), and returns the count deleted. Used by
 * the test's afterEach to keep the bucket clean for parallel
 * reruns and to keep cost bounded.
 *
 * @param {{
 *   send: (cmd: unknown) => Promise<unknown>,
 * }} client
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Promise<number>}  count of objects deleted
 */
export async function sweepOssPrefix(client, bucket, prefix) {
	let totalDeleted = 0;
	let continuationToken;
	do {
		/** @type {any} */
		const list = await client.send(new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: prefix,
			ContinuationToken: continuationToken,
		}));
		const objects = (list && Array.isArray(list.Contents)) ? list.Contents : [];
		if (objects.length === 0) {
			continuationToken = list && list.NextContinuationToken ? list.NextContinuationToken : null;
			continue;
		}
		const keys = objects
			.map((o) => o && typeof o.Key === "string" ? o.Key : null)
			.filter((k) => typeof k === "string");
		if (keys.length > 0) {
			// S3's DeleteObjects limits batches to 1000 — chunk defensively.
			for (let i = 0; i < keys.length; i += 1000) {
				const chunk = keys.slice(i, i + 1000);
				/** @type {any} */
				const del = await client.send(new DeleteObjectsCommand({
					Bucket: bucket,
					Delete: { Objects: chunk.map((Key) => ({ Key })) },
				}));
				const deleted = del && Array.isArray(del.Deleted) ? del.Deleted.length : chunk.length;
				totalDeleted += deleted;
			}
		}
		continuationToken = list && list.NextContinuationToken ? list.NextContinuationToken : null;
	} while (continuationToken);
	return totalDeleted;
}
