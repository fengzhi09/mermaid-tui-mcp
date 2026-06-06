// src/storage/DegradableStorage.mjs — D017 优雅降级包装.
//
// 为什么需要这个:
//   OssStorage 是 optional 集成 (D017), 它的任何 init 错误已经在 boot 路径降级
//   到 local. 但运行时 S3 抖动/凭据过期/网络分区等错误是 boot 后才发生的,
//   原 OssStorage 会让每个 render_mermaid 调用阻塞 5s+ 等 S3 超时,
//   然后返回 -32004/-32005 错误给 LLM. 频繁失败时 LLM 会持续看到失败,
//   比"悄悄写本地"更糟.
//
// 设计:
//   - 包装任意 primary StorageBackend + 一个 fallback StorageBackend (local).
//   - 同步方法 (stats/search/getMetadata) 直接代理, 不计失败 (它们不触网).
//   - 异步方法 (put/readSvg/setPinned/remove/list/save/load/sweep/pruneIfExpired)
//     先试 primary, 失败 → 用 fallback 完成 + 记一次连续失败.
//   - 连续 N 次失败后 (默认 3) 切 degraded 模式, 后续直接走 fallback.
//   - degraded 状态进程内, server 重启归零 (与 health-state 一致).
//   - 提供 health() 给 /health 暴露 degraded + consecutive_failures + reason.
//
// 不做什么 (out of scope, 留给 future slice):
//   - 半开探测 / 自动恢复. 简单: 重启即 reset, 运维可控.
//   - 持久化熔断器状态. 失败历史留在 stderr 日志流里.
//   - 同步方法降级. 它们不会触网, 没意义.
//
// D018: 阈值 N=3 是凭 M002 实测 — S3 偶发 1-2 次 timeout 是常见, 第 3 次仍失败
// 才认为 "OSS 不可用", 太敏感会导致正常网络抖动被误判. 阈值是
// buildStorageFromEnv 构造参数, 测试可注入, 生产默认 3.

/**
 * @typedef {import("./Backend.mjs").StorageBackend} StorageBackend
 */

const DEFAULT_FAILURE_THRESHOLD = 3;

export class DegradableStorage {
	/**
	 * @param {StorageBackend} primary       优先 backend (OssStorage)
	 * @param {StorageBackend} fallback      兜底 backend (LocalFsStorage)
	 * @param {{threshold?: number, logger?: {log?: Function}|null}} [opts]
	 */
	constructor(primary, fallback, opts = {}) {
		if (!primary) throw new Error("DegradableStorage: primary backend is required");
		if (!fallback) throw new Error("DegradableStorage: fallback backend is required");
		this.primary = primary;
		this.fallback = fallback;
		this.threshold = Number.isFinite(opts.threshold) && opts.threshold > 0
			? Math.floor(opts.threshold)
			: DEFAULT_FAILURE_THRESHOLD;
		this.logger = opts.logger ?? null;
		this.failureCount = 0;
		this.degraded = false;
		this.degradedSince = null;
		this.degradedReason = null;
		this.lastFailure = null; // {op, error, at}
	}

	get root() {
		// /health 暴露: 报告 primary 的 root 是因为 OSS bucket 才是 source of truth,
		// 在 degraded 模式下 "实际写入位置" 是 fallback.root, 通过 health() 额外暴露.
		return this.primary.root;
	}

	/**
	 * /health 子集. 任何时刻可读, 无副作用.
	 * @returns {{
	 *   degraded: boolean,
	 *   degraded_reason: string|null,
	 *   degraded_since: number|null,
	 *   consecutive_failures: number,
	 *   failure_threshold: number,
	 *   last_failure: {op: string, error: string, at: number}|null,
	 *   primary_root: string,
	 *   fallback_root: string,
	 * }}
	 */
	health() {
		return {
			degraded: this.degraded,
			degraded_reason: this.degradedReason,
			degraded_since: this.degradedSince,
			consecutive_failures: this.failureCount,
			failure_threshold: this.threshold,
			last_failure: this.lastFailure,
			primary_root: this.primary.root,
			fallback_root: this.fallback.root,
		};
	}

	// ---- 同步方法 (不触网, 不计失败, 直接代理) ---------------------------

	stats() {
		if (this.degraded) return this.fallback.stats();
		return this.primary.stats();
	}

	search(query, opts) {
		if (this.degraded) return this.fallback.search(query, opts);
		return this.primary.search(query, opts);
	}

	getMetadata(id) {
		if (this.degraded) return this.fallback.getMetadata(id);
		return this.primary.getMetadata(id);
	}

	// ---- 异步方法 (try primary, on failure use fallback) ------------------

	async load() {
		if (!this.degraded) {
			try {
				await this.primary.load();
				this._recordSuccess();
				return;
			} catch (e) {
				this._recordFailure("load", e);
			}
		}
		return this.fallback.load();
	}

	async save() {
		if (!this.degraded) {
			try {
				await this.primary.save();
				this._recordSuccess();
				return;
			} catch (e) {
				this._recordFailure("save", e);
			}
		}
		return this.fallback.save();
	}

	async sweep() {
		if (!this.degraded) {
			try {
				const n = await this.primary.sweep();
				this._recordSuccess();
				return n;
			} catch (e) {
				this._recordFailure("sweep", e);
			}
		}
		return this.fallback.sweep();
	}

	async put(id, code, svg, sourceLength, title) {
		if (!this.degraded) {
			try {
				const entry = await this.primary.put(id, code, svg, sourceLength, title);
				this._recordSuccess();
				return entry;
			} catch (e) {
				this._recordFailure("put", e);
			}
		}
		return this.fallback.put(id, code, svg, sourceLength, title);
	}

	async readSvg(id) {
		if (!this.degraded) {
			try {
				const svg = await this.primary.readSvg(id);
				// 读 null 不算失败 (entry 不存在) — 不重置计数器, 也不增加.
				return svg;
			} catch (e) {
				this._recordFailure("readSvg", e);
			}
		}
		return this.fallback.readSvg(id);
	}

	async setPinned(id, pinned) {
		if (!this.degraded) {
			try {
				const ok = await this.primary.setPinned(id, pinned);
				this._recordSuccess();
				return ok;
			} catch (e) {
				this._recordFailure("setPinned", e);
			}
		}
		return this.fallback.setPinned(id, pinned);
	}

	async remove(id) {
		if (!this.degraded) {
			try {
				const ok = await this.primary.remove(id);
				this._recordSuccess();
				return ok;
			} catch (e) {
				this._recordFailure("remove", e);
			}
		}
		return this.fallback.remove(id);
	}

	async list(opts) {
		if (!this.degraded) {
			try {
				const r = await this.primary.list(opts);
				this._recordSuccess();
				return r;
			} catch (e) {
				this._recordFailure("list", e);
			}
		}
		return this.fallback.list(opts);
	}

	async pruneIfExpired(id) {
		if (!this.degraded) {
			try {
				const e = await this.primary.pruneIfExpired(id);
				this._recordSuccess();
				return e;
			} catch (err) {
				this._recordFailure("pruneIfExpired", err);
			}
		}
		return this.fallback.pruneIfExpired(id);
	}

	// ---- 内部 --------------------------------------------------------------

	_recordSuccess() {
		if (this.failureCount > 0) {
			this._log({ level: "info", event: "oss_recovered",
				previous_failures: this.failureCount });
		}
		this.failureCount = 0;
		this.lastFailure = null;
	}

	_recordFailure(op, err) {
		this.failureCount += 1;
		const errorText = String(err?.message ?? err);
		this.lastFailure = { op, error: errorText, at: Date.now() };
		this._log({
			level: "warn",
			event: "oss_call_failed",
			op,
			error: errorText,
			consecutive: this.failureCount,
			threshold: this.threshold,
		});
		if (!this.degraded && this.failureCount >= this.threshold) {
			this.degraded = true;
			this.degradedSince = Date.now();
			this.degradedReason = `${this.failureCount} consecutive ${op} failures`;
			this._log({
				level: "warn",
				event: "oss_degraded",
				reason: this.degradedReason,
				threshold: this.threshold,
				fallback: "local",
			});
		}
	}

	_log(entry) {
		if (this.logger?.log) {
			try { this.logger.log(entry); } catch { /* swallow — logger failure must not break storage */ }
		}
	}
}

/** @internal — tests reset state without recreating the instance. */
export function __resetDegradableStateForTesting(storage) {
	if (storage && typeof storage === "object") {
		storage.failureCount = 0;
		storage.degraded = false;
		storage.degradedSince = null;
		storage.degradedReason = null;
		storage.lastFailure = null;
	}
}
