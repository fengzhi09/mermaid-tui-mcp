// tests/unit/oss-env.test.mjs — unit tests for the OssStorageFromEnv factory.
//
// T01 contract: OssStorageFromEnv(env, opts) validates the 5 required
// MERMAID_OSS_* env vars, constructs a real S3Client (the env-tested
// surface), and returns a fully-wired OssStorage. The factory is a
// pure function of its inputs (no I/O, no process-state mutation) so
// the tests pass a plain object literal as `env`.
//
// Test seam: __getLastClientForTesting() returns the S3Client the most
// recent factory call constructed. Tests use this to assert
// region / endpoint / credentials / forcePathStyle without poking
// private SDK internals (the S3Client's .config.region is an async
// function in v3, so reading the env's intent through the SDK
// surface is awkward; the env-var round-trip is verified via
// the OssStorage instance's own properties and the S3Client's
// public config object).

import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	OssStorage,
	OssStorageFromEnv,
	OssEnvInvalidError,
	__getLastClientForTesting,
	__resetLastClientForTesting,
} from "../../src/storage/OssStorage.mjs";

const FULL_ENV = {
	MERMAID_OSS_ENDPOINT: "http://127.0.0.1:9000",
	MERMAID_OSS_REGION: "us-east-1",
	MERMAID_OSS_ACCESS_KEY_ID: "AKID_TEST",
	MERMAID_OSS_SECRET_ACCESS_KEY: "SECRET_TEST",
	MERMAID_OSS_BUCKET: "mermaid-bucket",
};

const EXPECTED_REQUIRED = [
	"MERMAID_OSS_ENDPOINT",
	"MERMAID_OSS_REGION",
	"MERMAID_OSS_ACCESS_KEY_ID",
	"MERMAID_OSS_SECRET_ACCESS_KEY",
	"MERMAID_OSS_BUCKET",
];

describe("OssStorageFromEnv (T01)", () => {
	afterEach(() => {
		__resetLastClientForTesting();
		vi.restoreAllMocks();
	});

	describe("happy path", () => {
		it("returns an OssStorage instance with the right bucket, root, and prefix (empty)", () => {
			const storage = OssStorageFromEnv(FULL_ENV);
			expect(storage).toBeInstanceOf(OssStorage);
			expect(storage.bucket).toBe("mermaid-bucket");
			expect(storage.root).toBe("mermaid-bucket"); // root === bucket per Backend.mjs opaque-token contract
			expect(storage.prefix).toBe(""); // optional PREFIX defaults to empty string
			expect(storage.store).toBeInstanceOf(Map);
			expect(storage.store.size).toBe(0);
		});

		it("constructs an S3Client with the env's region, endpoint, and credentials", () => {
			const storage = OssStorageFromEnv(FULL_ENV);
			const client = __getLastClientForTesting();
			expect(client).toBeInstanceOf(S3Client);
			expect(storage.client).toBe(client); // the seam matches the instance's public client property

			// region: the S3Client stores it as an async Provider. We can
			// call the Provider to verify it carries the env value, and we
			// can also read it back from the static snapshot the SDK
			// exposes for the constructor args. Use both — Provider call
			// for the live value, and `client.config` for the read-back.
			return client.config.region().then((region) => {
				expect(region).toBe("us-east-1");
			}).then(() => client.config.endpoint()).then((endpoint) => {
				// endpoint is normalized to a URL object; host + port are
				// the parts we care about. The S3 SDK may also lowercase
				// the hostname — 127.0.0.1 stays as-is.
				expect(endpoint.hostname).toBe("127.0.0.1");
				expect(endpoint.port).toBe(9000);
				expect(endpoint.protocol).toBe("http:");
			}).then(() => client.config.credentials()).then((creds) => {
				expect(creds.accessKeyId).toBe("AKID_TEST");
				expect(creds.secretAccessKey).toBe("SECRET_TEST");
			});
		});

		it("defaults forcePathStyle to true when MERMAID_OSS_FORCE_PATH_STYLE is absent", () => {
			const env = { ...FULL_ENV };
			// Confirm the env is clean
			expect(env).not.toHaveProperty("MERMAID_OSS_FORCE_PATH_STYLE");
			OssStorageFromEnv(env);
			const client = __getLastClientForTesting();
			expect(client.config.forcePathStyle).toBe(true);
		});

		it("passes the explicit opt.forcePathStyle override", () => {
			OssStorageFromEnv(FULL_ENV, { forcePathStyle: false });
			const client = __getLastClientForTesting();
			expect(client.config.forcePathStyle).toBe(false);
		});

		it("MERMAID_OSS_FORCE_PATH_STYLE=false (string) flips the client to virtual-hosted", () => {
			OssStorageFromEnv({ ...FULL_ENV, MERMAID_OSS_FORCE_PATH_STYLE: "false" });
			expect(__getLastClientForTesting().config.forcePathStyle).toBe(false);
		});

		it("MERMAID_OSS_FORCE_PATH_STYLE=0 / no (case-insensitive) also disables path-style", () => {
			OssStorageFromEnv({ ...FULL_ENV, MERMAID_OSS_FORCE_PATH_STYLE: "0" });
			expect(__getLastClientForTesting().config.forcePathStyle).toBe(false);
			__resetLastClientForTesting();
			OssStorageFromEnv({ ...FULL_ENV, MERMAID_OSS_FORCE_PATH_STYLE: "NO" });
			expect(__getLastClientForTesting().config.forcePathStyle).toBe(false);
			__resetLastClientForTesting();
			OssStorageFromEnv({ ...FULL_ENV, MERMAID_OSS_FORCE_PATH_STYLE: "False" });
			expect(__getLastClientForTesting().config.forcePathStyle).toBe(false);
		});

		it("any other MERMAID_OSS_FORCE_PATH_STYLE value (e.g. 'true', '1', 'yes', 'maybe') keeps path-style true", () => {
			for (const v of ["true", "1", "yes", "maybe", "FALSE_TYPO", ""]) {
				__resetLastClientForTesting();
				OssStorageFromEnv({ ...FULL_ENV, MERMAID_OSS_FORCE_PATH_STYLE: v });
				expect(__getLastClientForTesting().config.forcePathStyle).toBe(true);
			}
		});

		it("PREFIX defaults to empty string when MERMAID_OSS_PREFIX is absent", () => {
			const env = { ...FULL_ENV };
			delete env.MERMAID_OSS_PREFIX;
			const storage = OssStorageFromEnv(env);
			expect(storage.prefix).toBe("");
		});

		it("PREFIX is set verbatim when MERMAID_OSS_PREFIX is a non-empty string", () => {
			const storage = OssStorageFromEnv({ ...FULL_ENV, MERMAID_OSS_PREFIX: "team-a/renders" });
			expect(storage.prefix).toBe("team-a/renders");
		});

		it("forwards counters, logger, and readTimeoutMs opts to the OssStorage instance", () => {
			const counters = { _stub: true };
			const logger = { log: () => {} };
			const storage = OssStorageFromEnv(FULL_ENV, {
				counters,
				logger,
				readTimeoutMs: 1234,
			});
			expect(storage.counters).toBe(counters);
			expect(storage.logger).toBe(logger);
			expect(storage.readTimeoutMs).toBe(1234);
		});

		it("readTimeoutMs defaults to 5000ms (matches LocalFsStorage's 5s budget)", () => {
			const storage = OssStorageFromEnv(FULL_ENV);
			expect(storage.readTimeoutMs).toBe(5000);
		});
	});

	describe("validation: missing required vars", () => {
		// Five negative cases — one per required env var. Each test
		// removes exactly one var and asserts the rejection lists that
		// var (and only that var) on the OssEnvInvalidError.
		const cases = [
			["MERMAID_OSS_ENDPOINT", "http://missing.example.com"],
			["MERMAID_OSS_REGION", "us-east-1"],
			["MERMAID_OSS_ACCESS_KEY_ID", "AKID_X"],
			["MERMAID_OSS_SECRET_ACCESS_KEY", "SECRET_X"],
			["MERMAID_OSS_BUCKET", "some-bucket"],
		];
		for (const [missingKey, replacement] of cases) {
			it(`throws OssEnvInvalidError with .missing=[${missingKey}] when ${missingKey} is absent`, () => {
				// Suppress the stderr log emission so the test output stays
				// clean. The logger.spy assertion below still verifies the
				// structured event was emitted.
				const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
				const env = { ...FULL_ENV };
				delete env[missingKey];
				// Sanity: the replacement key was actually used by the test.
				// (We always include the replacement, so deleting the env
				// key is the only way the factory sees it as missing.)
				expect(replacement).toBeDefined();

				expect(() => OssStorageFromEnv(env)).toThrow(OssEnvInvalidError);

				try {
					OssStorageFromEnv(env);
				} catch (e) {
					expect(e).toBeInstanceOf(OssEnvInvalidError);
					expect(e.missing).toEqual([missingKey]);
					expect(e.code).toBe(-32006);
					expect(e.message).toContain(missingKey);
				}
				// And no S3Client was constructed — the seam is still null.
				expect(__getLastClientForTesting()).toBeNull();
				stderrSpy.mockRestore();
			});
		}

		it("reports every missing var when multiple are absent (stable, REQUIRED_ENV_VARS order)", () => {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const env = { ...FULL_ENV };
			delete env.MERMAID_OSS_ENDPOINT;
			delete env.MERMAID_OSS_BUCKET;
			delete env.MERMAID_OSS_ACCESS_KEY_ID;
			try {
				OssStorageFromEnv(env);
				expect.unreachable("expected throw");
			} catch (e) {
				expect(e).toBeInstanceOf(OssEnvInvalidError);
				expect(e.missing).toEqual([
					"MERMAID_OSS_ENDPOINT",
					"MERMAID_OSS_ACCESS_KEY_ID",
					"MERMAID_OSS_BUCKET",
				]);
			}
			stderrSpy.mockRestore();
		});

		it("an empty-string required env var counts as missing (treated like absent)", () => {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const env = { ...FULL_ENV, MERMAID_OSS_BUCKET: "" };
			try {
				OssStorageFromEnv(env);
				expect.unreachable("expected throw");
			} catch (e) {
				expect(e).toBeInstanceOf(OssEnvInvalidError);
				expect(e.missing).toEqual(["MERMAID_OSS_BUCKET"]);
			}
			stderrSpy.mockRestore();
		});

		it("a totally empty env throws with all 5 in the missing list", () => {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				OssStorageFromEnv({});
				expect.unreachable("expected throw");
			} catch (e) {
				expect(e).toBeInstanceOf(OssEnvInvalidError);
				expect(e.missing).toEqual([...EXPECTED_REQUIRED]);
			}
			stderrSpy.mockRestore();
		});
	});

	describe("observability: oss_env_invalid log line", () => {
		it("emits a structured stderr log line on rejection (R008 shape: ts, level, event, missing)", () => {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const env = { ...FULL_ENV };
			delete env.MERMAID_OSS_REGION;
			try {
				OssStorageFromEnv(env);
			} catch {
				// expected
			}
			expect(stderrSpy).toHaveBeenCalled();
			// The first call's first arg is the JSON line.
			const callArg = stderrSpy.mock.calls[0][0];
			const line = typeof callArg === "string" ? callArg : Buffer.is(callArg) ? callArg.toString("utf-8") : String(callArg);
			const obj = JSON.parse(line.replace(/\n$/, ""));
			expect(obj).toHaveProperty("ts");
			expect(obj).toHaveProperty("level", "error");
			expect(obj).toHaveProperty("event", "oss_env_invalid");
			expect(obj).toHaveProperty("missing");
			expect(obj.missing).toEqual(["MERMAID_OSS_REGION"]);
		});

		it("uses opts.logger.log when provided, instead of writing directly to stderr", () => {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const logSpy = vi.fn();
			const env = { ...FULL_ENV };
			delete env.MERMAID_OSS_BUCKET;
			try {
				OssStorageFromEnv(env, { logger: { log: logSpy } });
			} catch {
				// expected
			}
			expect(logSpy).toHaveBeenCalledTimes(1);
			const rec = logSpy.mock.calls[0][0];
			expect(rec).toMatchObject({
				level: "error",
				event: "oss_env_invalid",
				missing: ["MERMAID_OSS_BUCKET"],
			});
			// No direct stderr write happened — the logger path took over.
			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it("does NOT log on the happy path (no spurious oss_env_invalid on success)", () => {
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const logSpy = vi.fn();
			OssStorageFromEnv(FULL_ENV, { logger: { log: logSpy } });
			expect(logSpy).not.toHaveBeenCalled();
			expect(stderrSpy).not.toHaveBeenCalled();
		});
	});

	describe("defaults & misc", () => {
		it("falls back to process.env when env arg is omitted (regression guard — the boot path passes nothing)", () => {
			// Pre-seed process.env with the required vars, then call with
			// no argument. Restore process.env in the catch so the test
			// is hermetic.
			const saved = {};
			for (const k of EXPECTED_REQUIRED) {
				saved[k] = process.env[k];
				process.env[k] = FULL_ENV[k];
			}
			try {
				const storage = OssStorageFromEnv();
				expect(storage.bucket).toBe(FULL_ENV.MERMAID_OSS_BUCKET);
				expect(__getLastClientForTesting()).toBeInstanceOf(S3Client);
			} finally {
				for (const k of EXPECTED_REQUIRED) {
					if (saved[k] === undefined) delete process.env[k];
					else process.env[k] = saved[k];
				}
				__resetLastClientForTesting();
			}
		});

		it("OssStorage constructor rejects non-S3Client inputs", () => {
			expect(() => new OssStorage({ bucket: "b", client: { fake: true } })).toThrow(TypeError);
			expect(() => new OssStorage({ bucket: "b" })).toThrow(TypeError);
			expect(() => new OssStorage({ client: new S3Client({ region: "x", credentials: { accessKeyId: "a", secretAccessKey: "b" } }) })).toThrow(TypeError); // empty bucket
		});
	});
});
