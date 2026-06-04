// Persistent storage for rendered diagrams.
//
// Layout on disk:
//   <root>/store.json                # { id -> { code, createdAt, pinned, lastAccessedAt, sourceLength } }
//   <root>/blobs/<id>.svg            # the rendered SVG body
//   <root>/server.pid, server.log    # start/stop state (managed by bin/start.sh)
//
// Sweep policy: any entry where (now - createdAt) > TTL_MS_DEFAULT AND
// !pinned is removed. Sweep runs on load, on every put, and hourly.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TTL_DAYS_DEFAULT = 7;
const TTL_MS_DEFAULT = TTL_DAYS_DEFAULT * 24 * 60 * 60 * 1000;

export class Storage {
	constructor(root) {
		this.root = root;
		this.storePath = join(root, "store.json");
		this.blobsDir = join(root, "blobs");
		this.store = new Map();
	}

	async load() {
		await mkdir(this.blobsDir, { recursive: true });
		if (existsSync(this.storePath)) {
			try {
				const raw = await readFile(this.storePath, "utf-8");
				const obj = JSON.parse(raw);
				for (const [k, v] of Object.entries(obj)) {
					if (v && typeof v === "object" && typeof v.code === "string") this.store.set(k, v);
				}
			} catch {
				// corrupted; start fresh
			}
		}
		await this.sweep();
	}

	async save() {
		const obj = Object.fromEntries(this.store);
		await writeFile(this.storePath, JSON.stringify(obj, null, 2));
	}

	async sweep() {
		const now = Date.now();
		let removed = 0;
		for (const [id, entry] of [...this.store.entries()]) {
			if (!entry.pinned && now - entry.createdAt > TTL_MS_DEFAULT) {
				this.store.delete(id);
				const blobPath = join(this.blobsDir, `${id}.svg`);
				if (existsSync(blobPath)) {
					try {
						await unlink(blobPath);
					} catch {
						// best-effort
					}
				}
				removed++;
			}
		}
		if (removed > 0) await this.save();
		return removed;
	}

	async put(id, code, svg, sourceLength) {
		const entry = {
			code,
			createdAt: Date.now(),
			pinned: false,
			lastAccessedAt: Date.now(),
			sourceLength: typeof sourceLength === "number" ? sourceLength : code.length,
		};
		this.store.set(id, entry);
		await writeFile(join(this.blobsDir, `${id}.svg`), svg, "utf-8");
		await this.save();
	}

	has(id) {
		return this.store.has(id);
	}

	get(id) {
		const entry = this.store.get(id);
		if (!entry) return null;
		entry.lastAccessedAt = Date.now();
		return entry;
	}

	async readSvg(id) {
		try {
			return await readFile(join(this.blobsDir, `${id}.svg`), "utf-8");
		} catch {
			return null;
		}
	}

	async setPinned(id, pinned) {
		const entry = this.store.get(id);
		if (!entry) return false;
		entry.pinned = !!pinned;
		await this.save();
		return true;
	}

	/**
	 * Returns the entry if present and not expired. Removes + returns null
	 * if expired. Callers should treat null as 404.
	 */
	async pruneIfExpired(id) {
		const entry = this.store.get(id);
		if (!entry) return null;
		if (!entry.pinned && Date.now() - entry.createdAt > TTL_MS_DEFAULT) {
			this.store.delete(id);
			const blobPath = join(this.blobsDir, `${id}.svg`);
			if (existsSync(blobPath)) {
				try {
					await unlink(blobPath);
				} catch {
					// best-effort
				}
			}
			await this.save();
			return null;
		}
		entry.lastAccessedAt = Date.now();
		return entry;
	}

	stats() {
		let pinned = 0;
		for (const e of this.store.values()) if (e.pinned) pinned++;
		return { total: this.store.size, pinned, unpinned: this.store.size - pinned };
	}
}

export const TTL_DAYS = TTL_DAYS_DEFAULT;
