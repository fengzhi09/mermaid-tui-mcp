// tests/integration/theme-switch.test.mjs — M003 S02 T04
//
// Verifies the ~25-line theme-switch JS appended at the end of
// public/view.html's <script> block: applies a saved theme on load,
// reacts to .theme-btn clicks, and persists the choice to localStorage.
//
// We do NOT use vitest's jsdom environment. Decision D020 (M004) removed
// jsdom as a project dependency; the project's testing convention is
// "real servers / real child processes / vi.spyOn", not a DOM testing
// library. Adding jsdom back just for this one test would regress the
// M004 architectural decision. Instead we build a minimal document /
// localStorage surface in plain JS and execute the extracted theme-switch
// code via `new Function`. The "integration" aspect is preserved by
// reading the actual code from public/view.html (not duplicating it),
// so if someone changes the inlined code the test follows.

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEW_HTML_PATH = resolve(__dirname, "..", "..", "public", "view.html");

/**
 * Minimal localStorage mock. Backed by a plain Map so the test asserts
 * on a real key-value surface; the only "real" browser behavior we
 * approximate is `getItem` returning null for missing keys (not
 * undefined), `setItem` stringifying non-strings, and `length` being
 * reactive.
 */
function makeLocalStorage() {
	const store = new Map();
	return {
		getItem(key) {
			return store.has(key) ? store.get(key) : null;
		},
		setItem(key, value) {
			store.set(key, String(value));
		},
		removeItem(key) {
			store.delete(key);
		},
		clear() {
			store.clear();
		},
		key(i) {
			return Array.from(store.keys())[i] ?? null;
		},
		get length() {
			return store.size;
		},
	};
}

/**
 * Build a mock `<button class="theme-btn" data-theme="…">` element.
 * Captures listeners so tests can dispatch click events, and tracks
 * data-active toggles.
 */
function makeThemeButton(theme) {
	const attrs = new Map();
	const listeners = new Map();
	return {
		dataset: { theme },
		classList: {
			contains: () => false,
		},
		toggleAttribute(name, force) {
			// Mirror the DOM spec: with-arg sets the boolean state;
			// without-arg flips. The theme-switch code passes an
			// explicit boolean so we only need the with-arg form.
			if (force === undefined) {
				const next = !attrs.has(name);
				if (!next) attrs.delete(name);
				else attrs.set(name, "");
				return next;
			}
			if (force) attrs.set(name, "");
			else attrs.delete(name);
			return force;
		},
		hasAttribute(name) {
			return attrs.has(name);
		},
		getAttribute(name) {
			return attrs.has(name) ? attrs.get(name) : null;
		},
		addEventListener(type, fn) {
			const arr = listeners.get(type) || [];
			arr.push(fn);
			listeners.set(type, arr);
		},
		dispatchEvent(type) {
			const arr = listeners.get(type) || [];
			for (const fn of arr) fn();
		},
		// Test introspection:
		_isActive() {
			return attrs.has("data-active");
		},
	};
}

/**
 * Build a fresh mock DOM holding the 4 theme buttons and a fake
 * documentElement with a setAttribute spy.
 */
function makeMockDocument() {
	const buttons = ["light", "dark", "warm", "care"].map(makeThemeButton);
	const setAttrCalls = [];
	const root = {
		setAttribute(name, value) {
			setAttrCalls.push([name, value]);
			this[`__${name}`] = value;
		},
		removeAttribute(name) {
			setAttrCalls.push([name, null]);
			delete this[`__${name}`];
		},
		getAttribute(name) {
			return this[`__${name}`] ?? null;
		},
	};
	return {
		documentElement: root,
		querySelectorAll(selector) {
			if (selector === ".theme-btn") return buttons;
			return [];
		},
		// Test introspection:
		__buttons: buttons,
		__setAttrCalls: setAttrCalls,
		__getThemeAttr() {
			return root.getAttribute("data-theme");
		},
	};
}

/**
 * Pull the theme-switch JS out of public/view.html by finding the
 * `const THEME_KEY = 'mermaid-viewer-theme';` marker and slicing from
 * there to the end of the surrounding <script> block. The marker
 * string is the same one the task plan mandates, so a typo in the
 * inlined code will surface as a test-load failure rather than a
 * silent test-of-stale-code.
 */
function extractThemeSwitchJs() {
	const html = readFileSync(VIEW_HTML_PATH, "utf-8");
	const marker = "const THEME_KEY = 'mermaid-viewer-theme';";
	const markerIdx = html.indexOf(marker);
	if (markerIdx < 0) {
		throw new Error(
			`theme-switch marker not found in public/view.html: ${marker}`,
		);
	}
	// Slice from the marker to the end of the script block. The
	// inlined JS is plain (no further template placeholders) so no
	// substitution is needed.
	const scriptEnd = html.indexOf("</script>", markerIdx);
	if (scriptEnd < 0) {
		throw new Error("theme-switch JS not followed by </script> — malformed view.html");
	}
	return html.slice(markerIdx, scriptEnd);
}

describe("theme switcher (M003 S02 T04)", () => {
	let mockDoc;
	let mockLs;
	let themeSwitchJs;

	beforeEach(() => {
		mockDoc = makeMockDocument();
		mockLs = makeLocalStorage();
		// Cache the extracted JS once per test file; reading the file
		// in every beforeEach would be wasteful.
		if (!themeSwitchJs) themeSwitchJs = extractThemeSwitchJs();
	});

	function runThemeSwitch() {
		// Execute the extracted JS in a controlled scope. Pass our
		// mocks as the only `document` / `localStorage` bindings the
		// script can see, so it cannot accidentally reach a real
		// global (none exists in node, but this keeps the seam
		// explicit).
		const fn = new Function("document", "localStorage", themeSwitchJs);
		fn(mockDoc, mockLs);
	}

	it("applies saved theme from localStorage on load", () => {
		mockLs.setItem("mermaid-viewer-theme", "dark");
		runThemeSwitch();

		// 1. data-theme attribute on <html> reflects localStorage
		expect(mockDoc.__getThemeAttr()).toBe("dark");

		// 2. The matching button is active, others are not
		const buttons = mockDoc.__buttons;
		expect(buttons.find((b) => b.dataset.theme === "dark")._isActive()).toBe(true);
		expect(buttons.find((b) => b.dataset.theme === "light")._isActive()).toBe(false);
		expect(buttons.find((b) => b.dataset.theme === "warm")._isActive()).toBe(false);
		expect(buttons.find((b) => b.dataset.theme === "care")._isActive()).toBe(false);
	});

	it("clicking a theme button updates data-theme and persists to localStorage", () => {
		// Start clean — no saved theme, defaults to 'light'
		runThemeSwitch();
		expect(mockDoc.__getThemeAttr()).toBe("light");
		expect(mockLs.getItem("mermaid-viewer-theme")).toBe("light");

		// Click the dark button
		const darkBtn = mockDoc.__buttons.find((b) => b.dataset.theme === "dark");
		darkBtn.dispatchEvent("click");

		// data-theme updates
		expect(mockDoc.__getThemeAttr()).toBe("dark");
		// localStorage persists the choice (the load-bearing assertion
		// for "F5 refresh retains the selection" — on next load, the
		// first test above will read this value and re-apply it)
		expect(mockLs.getItem("mermaid-viewer-theme")).toBe("dark");
		// And the active marker follows the click
		expect(darkBtn._isActive()).toBe(true);
		expect(mockDoc.__buttons.find((b) => b.dataset.theme === "light")._isActive()).toBe(false);
	});

	it("clicking the care button applies the care theme and persists it", () => {
		runThemeSwitch();
		const careBtn = mockDoc.__buttons.find((b) => b.dataset.theme === "care");
		careBtn.dispatchEvent("click");

		expect(mockDoc.__getThemeAttr()).toBe("care");
		expect(mockLs.getItem("mermaid-viewer-theme")).toBe("care");
		expect(careBtn._isActive()).toBe(true);
		// Sanity: the previously-active (light) button is no longer active
		expect(mockDoc.__buttons.find((b) => b.dataset.theme === "light")._isActive()).toBe(false);
	});
});
