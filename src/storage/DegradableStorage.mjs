// src/storage/DegradableStorage.mjs — D017 优雅降级包装 (S03 T03).
//
// 为什么需要这个:
//   OssStorage 是 optional 集成 (D017), 它的 init 错误已经在 boot 路径降级
//   到 local (T01). 但运行时 S3 抖动/凭据过期/网络分区等错误是 boot 后才发生
//   的, 原 OssStorage 会让每个 render_mermaid 调用阻塞 5s+ 等 S3 超时, 然
//   后返回 -32004/-32005 错误给 LLM. 频繁失败时 LLM 会持续看到失败, 比
//   "悄悄写本地"更糟.
//
// 设计 (S03 T03, 新):
//   - 包装任意 primary StorageBackend (典型为 OssStorage) + 一个 fallback
//     StorageBackend (LocalFsStorage). T02 把熔断器状态机 (recordFailure /
//     canAttempt / recordSuccess) 装到了 OssStorage.breaker 上, 本 wrapper 直
//     接驱动这个状态机, 不再持有独立的 degraded/failureCount 状态 — 单一真源.
//   - 同步方法 (stats/search/getMetadata/has) 仅在 degraded (即
//     !primary.canAttempt()) 时走 fallback, 其它情况直代理. 不计失败 (它们
//     不触网, 计失败没意义).
//   - 异步方法 (load/save/sweep/put/readSvg/setPinned/remove/list/
//     pruneIfExpired):
//       1. 先看 primary.canAttempt() — false 直接走 fallback.
//       2. true 则 await primary.method(...), 成功 → primary.recordSuccess()
//          + 若此前是 open 状态, emit breaker_close (level=info).
//       3. 失败 → primary.recordFailure(err). 若 r.opened === true (真正的状
//          态翻转), emit breaker_open (level=warn) + counter
//          breaker_trips_count++. 后续用 fallback 兜底完成.
//   - 半开探测: canAttempt() 在 open + 超过 halfOpenAfterMs 时返 true, 此时
//     调一次 primary. 成功 → breaker 关闭, 继续 primary. 失败 →
//     recordFailure (r.opened=false, breaker 已经在 open), 失败探测只刷新
//     cool-down, 不重复 emit breaker_open (避免日志风暴).
//   - root 返 fallback.root (M003/S03/T03 决定): 降级后用户应感知到走 local,
//     /health 仍可通过 health().primary_root 看到原 bucket 名.
//
// D018: 阈值 N=3 (默认) 凭 M002 实测 — S3 偶发 1-2 次 timeout 常见, 第 3 次仍
// 失败才认为 "OSS 不可用", 太敏感会导致正常网络抖动被误判. 阈值/半开窗
// 都是 constructor opts, 测试可注入, 生产默认 3 / 60s.
//
// 事件 (M003/S03 slice 的 3 个新增 stderr event 之一, 另两个由 T01 装上):
//   - breaker_open   level=warn   熔断器从 closed 切到 open
//   - breaker_close  level=info   熔断器从 open 切到 closed (半开探测成功)
//
// 不做什么 (out of scope, 留给 future slice):
//   - 持久化熔断器状态. server 重启即重置 (与 health-state 一致).
//   - /health.backend 字段 (T04). /health.last_oss_failure (T04).
//   - 同步方法 (stats/search) 自身的"降级记数" — 它们不触网.

/**
 * @typedef {import("./Backend.mjs").StorageBackend} StorageBackend
 * @typedef {import("../counters.mjs").Counters} Counters
 *
 * @typedef {{
 *   state: "closed" | "open",
 *   failureCount: number,
 *   lastFailure: { message: string, at: number, code: number | string | null } | null,
 *   openedAt: number | null,
 *   threshold: number,
 *   halfOpenAfterMs: number,
 * }} BreakerState
 *
 * @typedef {StorageBackend & {
 *   breaker: BreakerState,
 *   canAttempt(): boolean,
 *   recordFailure(err: unknown): { state: string, failureCount: number, opened: boolean },
 *   recordSuccess(): { state: string, failureCount: number },
 * }} BreakerBackedStorage
 */

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_HALF_OPEN_AFTER_MS = 60_000;

export class DegradableStorage {
	/**
	 * @param {BreakerBackedStorage} primary   优先 backend (OssStorage). 必须暴露 breaker + canAttempt/recordFailure/recordSuccess.
	 * @param {StorageBackend} fallback        兜底 backend (LocalFsStorage)
	 * @param {{
	 *   counters?: Counters | null,
	 *   logger?: { log: Function } | null,
	 *   threshold?: number,
	 *   halfOpenAfterMs?: number,
	 * }} [opts]
	 */
	constructor(primary, fallback, opts = {}) {
		if (!primary) throw new Error("DegradableStorage: primary backend is required");
		if (!fallback) throw new Error("DegradableStorage: fallback backend is required");
		// Type-guard: the breaker interface is what lets the wrapper do
		// graceful runtime degradation. A primary without it (e.g. a raw
		// plain-object test stub) is a programming error, not a runtime
		// condition — we fail loudly so the test author catches it
		// before shipping.
		if (!primary.breaker
			|| typeof primary.canAttempt !== "function"
			|| typeof primary.recordFailure !== "function"
			|| typeof primary.recordSuccess !== "function") {
			throw new TypeError(
				"DegradableStorage: primary must expose breaker {state, failureCount, openedAt, threshold, halfOpenAfterMs} "
				+ "and methods canAttempt / recordFailure / recordSuccess (OssStorage satisfies this)",
			);
		}
		this.primary = primary;
		this.fallback = fallback;
		this.counters = opts.counters ?? null;
		this.logger = opts.logger ?? null;

		// Apply the wrapper's breaker tuning to the primary. The production
		// default (3 / 60s) and the env-driven overrides (T01 builds the
		// threshold; T03 adds halfOpenAfterMs) all land here. We do NOT
		// reset state / failureCount / lastFailure / openedAt — the
		// breaker's runtime history belongs to the primary (OssStorage
		// starts fresh per its own constructor contract, so on the
		// production path the wrapper always sees a closed/0/null
		// breaker). Tests that pre-seed a tripped state on a stub will
		// see their seeded state preserved — the wrapper drives the
		// transitions, it does not own the initial state.
		const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0
			? Math.floor(opts.threshold)
			: DEFAULT_FAILURE_THRESHOLD;
		const halfOpenAfterMs = Number.isFinite(opts.halfOpenAfterMs) && opts.halfOpenAfterMs > 0
			? Math.floor(opts.halfOpenAfterMs)
			: DEFAULT_HALF_OPEN_AFTER_MS;

		this.primary.breaker.threshold = threshold;
		this.primary.breaker.halfOpenAfterMs = halfOpenAfterMs;
	}

	get root() {
		// M003/S03/T03 决定: root 走 fallback. 降级后用户应感知到"我现在的数据
		// 在本地", 不再被 OSS bucket 名误导. 原 bucket 名仍可通过
		// health().primary_root 看到, 与 fallback_root 并列.
		return this.fallback.root;
	}

	/**
	 * /health 子集. 任何时刻可读, 无副作用. 字段名是 snake_case 跟随
	 * R008/R009 的 log line 命名惯例, /health 的最终 consumer (T04) 会
	 * 直接 spread 这个对象.
	 * @returns {{
	 *   degraded: boolean,
	 *   breaker_state: "closed" | "open",
	 *   consecutive_failures: number,
	 *   failure_threshold: number,
	 *   half_open_after_ms: number,
	 *   opened_at: number | null,
	 *   last_failure: { message: string, at: number, code: number | string | null } | null,
	 *   primary_root: string,
	 *   fallback_root: string,
	 * }}
	 */
	health() {
		const b = this.primary.breaker;
		return {
			degraded: !this.primary.canAttempt(),
			breaker_state: b.state,
			consecutive_failures: b.failureCount,
			failure_threshold: b.threshold,
			half_open_after_ms: b.halfOpenAfterMs,
			opened_at: b.openedAt,
			last_failure: b.lastFailure,
			primary_root: this.primary.root,
			fallback_root: this.fallback.root,
		};
	}

	// ---- 同步方法 (不触网, 不计失败, 直接代理) ---------------------------
	//
	// has / stats / search / getMetadata 都不调 S3 — 它们的成本是 in-memory
	// Map 查询. 当 !primary.canAttempt() (即熔断器 open 且在 cool-down 内),
	// 把它们切到 fallback, 否则保持 primary — 这样在 open 状态下, LLM 看到
	// 的 stats/search 与 fallback 一致 (而不是一个被冻结的 OSS 状态). 在
	// closed 状态, primary 与 fallback 数据有可能不一致 (主写 OSS, 落
	// local), 我们故意让 primary 胜出 — 这是 graceful degradation 的语义:
	// "OSS 是 source of truth, OSS 坏了才用 local 兜底".

	has(id) {
		if (this._isDegraded()) return this.fallback.has(id);
		return this.primary.has(id);
	}

	stats() {
		if (this._isDegraded()) return this.fallback.stats();
		return this.primary.stats();
	}

	search(query, opts) {
		if (this._isDegraded()) return this.fallback.search(query, opts);
		return this.primary.search(query, opts);
	}

	getMetadata(id) {
		if (this._isDegraded()) return this.fallback.getMetadata(id);
		return this.primary.getMetadata(id);
	}

	// ---- 异步方法 (try primary, on failure use fallback) ------------------
	//
	// _tryAsync 是统一的"先 primary 后 fallback"驱动, 9 个异步方法都委托到
	// 这里. 同步方法不走这条路径 (它们没有 try/catch 的网络层). 公共字段:
	//   - op: 方法名 (如 "put" / "readSvg"). 用作日志的 op 字段 + fallback
	//         路由的函数名.
	//   - args: 传给 primary / fallback 的参数列表. 我们用 apply 而非把单个
	//           primaryFn 当 callback 传, 是因为 fallback 也要用同样的参数 —
	//           例如 put("id", "code", "svg", 4) 在 primary 失败时, fallback
	//           应该用完全一样的入参写本地.

	async load() {
		return this._tryAsync("load", []);
	}

	async save() {
		return this._tryAsync("save", []);
	}

	async sweep() {
		return this._tryAsync("sweep", []);
	}

	async put(id, code, svg, ascii, sourceLength, title) {
		return this._tryAsync("put", [id, code, svg, ascii, sourceLength, title]);
	}

	async readSvg(id) {
		return this._tryAsync("readSvg", [id]);
	}

	async setPinned(id, pinned) {
		return this._tryAsync("setPinned", [id, pinned]);
	}

	async remove(id) {
		return this._tryAsync("remove", [id]);
	}

	async list(opts) {
		return this._tryAsync("list", [opts]);
	}

	async pruneIfExpired(id) {
		return this._tryAsync("pruneIfExpired", [id]);
	}

	// ---- 内部 --------------------------------------------------------------

	_isDegraded() {
		// Degraded = breaker open + 还在 cool-down 内. 半开探测窗口 (open
		// + 超过 halfOpenAfterMs) 不算 degraded: 我们还能试 primary, 只
		// 是要小心一点. 这样 LLM 在 cool-down 期内看到 fallback 数据,
		// 在半开窗口内则可能看到 primary 数据 (如果探测成功).
		return !this.primary.canAttempt();
	}

	/**
	 * @param {string} op    委托的方法名 ("put" / "readSvg" / ...)
	 * @param {any[]} args   传给该方法的参数
	 */
	async _tryAsync(op, args) {
		// Fast path: 熔断器开着且还在 cool-down 内 → 直接走 fallback, 不会
		// 触发 recordFailure (避免 cool-down 期内重复刷 openedAt).
		if (!this.primary.canAttempt()) {
			return this._callFallback(op, args);
		}

		// Slow path: 试 primary. 记一下"进入这次调用前 breaker 是否已
		// 经是 open" — 如果是, 这次就是半开探测, 成功就要发 breaker_close.
		const wasOpen = this.primary.breaker.state === "open";

		let result;
		try {
			result = await this._callPrimary(op, args);
		} catch (primaryErr) {
			const r = this.primary.recordFailure(primaryErr);
			// r.opened === true 表示这是从 closed → open 的真状态翻转.
			// 在已 open 状态下, 失败的探测只刷 openedAt (recordFailure 内
			// 部行为), r.opened === false — 这时不要再发 breaker_open
			// (避免日志风暴), 只在 fallback 兜底后让请求方继续.
			if (r.opened) {
				await this._emitBreakerOpen(op, primaryErr);
			}
			return this._callFallback(op, args);
		}

		// Success path: 记录一次成功. 若这是半开探测成功, breaker 关闭,
		// 发 breaker_close 让运维知道"OSS 恢复了". 注意: 我们必须在
		// recordSuccess() 之前抓 openedAt 的值, 因为 recordSuccess 会把它
		// 置 null, _emitBreakerClose 就读不到"OSS 震了多久"了.
		const openedAtSnapshot = wasOpen ? this.primary.breaker.openedAt : null;
		this.primary.recordSuccess();
		if (wasOpen) {
			this._emitBreakerClose(op, openedAtSnapshot);
		}
		return result;
	}

	async _callPrimary(op, args) {
		const fn = this.primary[op];
		if (typeof fn !== "function") {
			throw new Error(`DegradableStorage: primary backend has no method '${op}'`);
		}
		return await fn.apply(this.primary, args);
	}

	async _callFallback(op, args) {
		const fn = this.fallback[op];
		if (typeof fn !== "function") {
			throw new Error(`DegradableStorage: fallback backend has no method '${op}'`);
		}
		return await fn.apply(this.fallback, args);
	}

	/**
	 * Emit `breaker_open` (level=warn) + bump `breaker_trips_count`.
	 * Logger / counter failures are swallowed — observability must not
	 * break the storage path. This mirrors the OssStorage
	 * `_logOp` / `_writeWithRetry` defensive pattern.
	 *
	 * @param {string} op
	 * @param {unknown} err
	 */
	async _emitBreakerOpen(op, err) {
		const message = err && typeof err === "object" && typeof err.message === "string"
			? err.message
			: String(err);
		const breaker = this.primary.breaker;
		this._log({
			level: "warn",
			event: "breaker_open",
			op,
			error: message,
			consecutive: breaker.failureCount,
			threshold: breaker.threshold,
			opened_at: breaker.openedAt,
			fallback: "local",
		});
		if (this.counters) {
			try {
				await this.counters.increment("breaker_trips_count");
			} catch {
				// best-effort
			}
		}
	}

	/**
	 * Emit `breaker_close` (level=info). Counter bump is NOT done — we
	 * count OPEN transitions, not CLOSE transitions, because the SLO
	 * ("OSS 抖动多少次需要切 local") is measured on the open side. A
	 * close is just recovery confirmation, not a metric.
	 *
	 * @param {string} op
	 * @param {number | null} openedAt  the openedAt timestamp captured
	 *   BEFORE recordSuccess() (which resets openedAt to null). Allows
	 *   the close event to carry recovered_after_ms without re-reading
	 *   a value that has already been zeroed.
	 */
	_emitBreakerClose(op, openedAt) {
		this._log({
			level: "info",
			event: "breaker_close",
			op,
			recovered_after_ms: openedAt == null ? null : Date.now() - openedAt,
		});
	}

	_log(entry) {
		if (this.logger && typeof this.logger.log === "function") {
			try { this.logger.log(entry); } catch { /* swallow — logger failure must not break storage */ }
		}
	}
}
