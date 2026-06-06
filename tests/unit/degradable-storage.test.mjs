// tests/unit/degradable-storage.test.mjs — D018 单元测试.
import { describe, expect, it, vi } from "vitest";
import { DegradableStorage, __resetDegradableStateForTesting } from "../../src/storage/DegradableStorage.mjs";

function makeStubBackend(name, overrides = {}) {
	const stub = {
		name,
		root: "/stub/" + name,
		stats: vi.fn(() => ({ total: 0, pinned: 0, unpinned: 0 })),
		search: vi.fn(() => ({ items: [], nextCursor: null })),
		getMetadata: vi.fn(() => null),
		load: vi.fn(async () => {}),
		save: vi.fn(async () => {}),
		sweep: vi.fn(async () => 0),
		put: vi.fn(async (id, code, svg) => ({ id, code, svg, createdAt: 0, pinned: false, lastAccessedAt: 0, sourceLength: code.length, title: "" })),
		readSvg: vi.fn(async (id) => "<svg/>"),
		setPinned: vi.fn(async () => true),
		remove: vi.fn(async () => true),
		list: vi.fn(async () => ({ items: [], nextCursor: null })),
		pruneIfExpired: vi.fn(async () => null),
		...overrides,
	};
	return stub;
}

describe("DegradableStorage (D018)", () => {
	it("默认状态: not degraded, 0 失败, threshold=3", () => {
		const ds = new DegradableStorage(makeStubBackend("p"), makeStubBackend("f"));
		expect(ds.degraded).toBe(false);
		expect(ds.failureCount).toBe(0);
		expect(ds.threshold).toBe(3);
		const h = ds.health();
		expect(h.degraded).toBe(false);
		expect(h.degraded_reason).toBeNull();
		expect(h.consecutive_failures).toBe(0);
		expect(h.failure_threshold).toBe(3);
		expect(h.primary_root).toBe("/stub/p");
		expect(h.fallback_root).toBe("/stub/f");
		expect(h.last_failure).toBeNull();
	});

	it("正常调用走 primary", async () => {
		const primary = makeStubBackend("p");
		const ds = new DegradableStorage(primary, makeStubBackend("f"));
		await ds.put("i1", "code", "<svg/>", 4);
		expect(primary.put).toHaveBeenCalledWith("i1", "code", "<svg/>", 4, undefined);
		expect(ds.failureCount).toBe(0);
	});

	it("primary 一次失败 → 走 fallback + failureCount=1", async () => {
		const logger = { log: vi.fn() };
		const primary = makeStubBackend("p", { put: vi.fn(async () => { throw new Error("S3 timeout"); }) });
		const fallback = makeStubBackend("f");
		const ds = new DegradableStorage(primary, fallback, { logger });
		await ds.put("i1", "code", "<svg/>", 4);
		expect(fallback.put).toHaveBeenCalledWith("i1", "code", "<svg/>", 4, undefined);
		expect(ds.failureCount).toBe(1);
		expect(ds.degraded).toBe(false);
		expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
			level: "warn", event: "oss_call_failed", op: "put", consecutive: 1,
		}));
	});

	it("连续 N=3 失败 → degraded=true, 后续不再试 primary", async () => {
		const primary = makeStubBackend("p", { put: vi.fn(async () => { throw new Error("S3 down"); }) });
		const fallback = makeStubBackend("f");
		const ds = new DegradableStorage(primary, fallback, { logger: { log: vi.fn() } });
		await ds.put("i1", "c", "s", 1);
		await ds.put("i2", "c", "s", 1);
		await ds.put("i3", "c", "s", 1);
		expect(ds.failureCount).toBe(3);
		expect(ds.degraded).toBe(true);
		expect(ds.degradedReason).toContain("3 consecutive put failures");
		const callsBefore = primary.put.mock.calls.length;
		await ds.put("i4", "c", "s", 1);
		expect(primary.put.mock.calls.length).toBe(callsBefore);
		expect(fallback.put).toHaveBeenCalledTimes(4);
	});

	it("成功后计数器归零 (degraded 不自动恢复)", async () => {
		const primary = makeStubBackend("p", {
			put: vi.fn()
				.mockRejectedValueOnce(new Error("flaky1"))
				.mockRejectedValueOnce(new Error("flaky2"))
				.mockResolvedValueOnce({ id: "i3", code: "c", svg: "s", createdAt: 0, pinned: false, lastAccessedAt: 0, sourceLength: 1, title: "" }),
		});
		const ds = new DegradableStorage(primary, makeStubBackend("f"), { logger: { log: vi.fn() } });
		await ds.put("i1", "c", "s", 1);
		await ds.put("i2", "c", "s", 1);
		await ds.put("i3", "c", "s", 1);
		expect(ds.failureCount).toBe(0);
		expect(ds.degraded).toBe(false);
	});

	it("同步方法直接代理, 不计失败", () => {
		const primary = makeStubBackend("p");
		const fallback = makeStubBackend("f");
		const ds = new DegradableStorage(primary, fallback);
		ds.stats();
		ds.getMetadata("any");
		ds.search("q");
		expect(primary.stats).toHaveBeenCalled();
		expect(primary.getMetadata).toHaveBeenCalled();
		expect(primary.search).toHaveBeenCalled();
		expect(fallback.stats).not.toHaveBeenCalled();
	});

	it("degraded 模式下同步方法走 fallback", () => {
		const primary = makeStubBackend("p", { stats: vi.fn(() => ({ total: 5, pinned: 0, unpinned: 5 })) });
		const fallback = makeStubBackend("f", { stats: vi.fn(() => ({ total: 1, pinned: 0, unpinned: 1 })) });
		const ds = new DegradableStorage(primary, fallback);
		__resetDegradableStateForTesting(ds);
		ds.degraded = true;
		expect(ds.stats()).toEqual({ total: 1, pinned: 0, unpinned: 1 });
		expect(primary.stats).not.toHaveBeenCalled();
	});

	it("opts.threshold 覆盖默认", async () => {
		const primary = makeStubBackend("p", { put: vi.fn(async () => { throw new Error("x"); }) });
		const ds = new DegradableStorage(primary, makeStubBackend("f"), { threshold: 2 });
		expect(ds.threshold).toBe(2);
		await ds.put("i1", "c", "s", 1);
		await ds.put("i2", "c", "s", 1);
		expect(ds.degraded).toBe(true);
	});

	it("logger 抛错不会破坏 storage 流程", async () => {
		const badLogger = { log: vi.fn(() => { throw new Error("logger broke"); }) };
		const primary = makeStubBackend("p", { put: vi.fn(async () => { throw new Error("S3"); }) });
		const ds = new DegradableStorage(primary, makeStubBackend("f"), { logger: badLogger });
		await expect(ds.put("i1", "c", "s", 1)).resolves.toBeTruthy();
	});

	it("missing primary or fallback throws", () => {
		expect(() => new DegradableStorage(null, {})).toThrow(/primary backend is required/);
		expect(() => new DegradableStorage({}, null)).toThrow(/fallback backend is required/);
	});

	it("health() 在失败后填充 last_failure 字段", async () => {
		const primary = makeStubBackend("p", { put: vi.fn(async () => { throw new Error("S3 timeout"); }) });
		const ds = new DegradableStorage(primary, makeStubBackend("f"));
		await ds.put("i1", "c", "s", 1);
		const h = ds.health();
		expect(h.last_failure).toEqual(expect.objectContaining({ op: "put", error: "S3 timeout" }));
		expect(typeof h.last_failure.at).toBe("number");
	});
});
