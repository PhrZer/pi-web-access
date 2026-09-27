import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const realPiUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const webToolNames = ["web_search", "source_check", "fetch_content", "get_search_content"];

// Issue #428 and #444: a managed install can leave an older `@earendil-works/*` copy
// beside the extension. Static imports resolve to that copy before the host's loader
// aliases apply, so the gate must read the running installation instead.
function stalePiImportHook(version) {
	return `
		import { registerHooks } from "node:module";
		const realPi = ${JSON.stringify(realPiUrl)};
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === "@earendil-works/pi-coding-agent") {
					return { url: "stale:pi-coding-agent", shortCircuit: true };
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url === "stale:pi-coding-agent") {
					return {
						format: "module",
						shortCircuit: true,
						source: 'export * from ' + JSON.stringify(realPi) + '; export const VERSION = ' + JSON.stringify(${JSON.stringify(version)}) + ';',
					};
				}
				return nextLoad(url, context);
			},
		});
	`;
}

function fakeHostPackage(version) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-host-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
	return root;
}

function childScript({ messages, hook, compiledHost }) {
	return `
		${hook ?? ""}
		${compiledHost ? `
		process.versions.bun = "1.9.9";
		Object.defineProperty(process, "execPath", { value: ${JSON.stringify(compiledHost.execPath)}, configurable: true, writable: true });
		` : ""}
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (...args) => warnings.push(args.map(String).join(" "));
		const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
		const tools = new Map();
		const handlers = new Map();
		let active = ["read"];
		const pi = {
			registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
			registerCommand() {}, registerShortcut() {},
			on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
			getAllTools() { return [...tools.values()]; },
			getActiveTools() { return [...active]; },
			setActiveTools(names) { active = [...names]; },
		};
		initializeExtension(pi);
		const entries = ${JSON.stringify(messages)}.map((message, index) => ({
			type: "message", id: "message-" + index, parentId: index ? "message-" + (index - 1) : null,
			timestamp: new Date(index).toISOString(), message,
		}));
		const ctx = { sessionManager: { getBranch: () => entries } };
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		await new Promise(resolve => setTimeout(resolve, 0));
		console.warn = originalWarn;
		console.log(JSON.stringify({ active, warnings, registered: [...tools.keys()] }));
	`;
}

function run({ messages = [], hook = "", compiledHost, hostVersion, entryPointVersion } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-version-"));
	writeFileSync(join(root, "web-search.json"), JSON.stringify({}), "utf8");
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: root,
		XDG_CONFIG_HOME: "",
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
	};
	if (hostVersion) env.PI_PACKAGE_DIR = fakeHostPackage(hostVersion);
	else delete env.PI_PACKAGE_DIR;
	const script = childScript({ messages, hook, compiledHost });
	let child;
	if (entryPointVersion) {
		// Run from inside a fake Pi installation so process.argv[1] identifies the host.
		const installRoot = mkdtempSync(join(tmpdir(), "pi-web-access-install-"));
		mkdirSync(join(installRoot, "dist", "bundle"), { recursive: true });
		writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: entryPointVersion, type: "module" }));
		const entry = join(installRoot, "dist", "bundle", "cli.js");
		writeFileSync(entry, script);
		child = spawnSync(process.execPath, [entry], { encoding: "utf8", env });
	} else {
		child = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env });
	}
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

test("the running installation decides the version floor", () => {
	const supported = run({ entryPointVersion: "0.87.1" });
	assert.deepEqual(supported.warnings, []);
	assert.ok(supported.active.includes("web_enable"), `expected web_enable, got ${supported.active.join(", ")}`);
	assert.deepEqual(supported.active.filter(name => webToolNames.includes(name)), [], `web tools should stay dormant, got ${supported.active.join(", ")}`);

	const unsupported = run({ entryPointVersion: "0.86.0" });
	assert.equal(unsupported.warnings.length, 1);
	assert.match(unsupported.warnings[0], /running 0\.86\.0/);
	assert.equal(unsupported.active.includes("web_enable"), false);
	assert.ok(unsupported.active.includes("web_search"), `expected eager web_search, got ${unsupported.active.join(", ")}`);
});

test("the PI_PACKAGE_DIR override identifies the running installation", () => {
	const supported = run({ hostVersion: "0.87.1" });
	assert.deepEqual(supported.warnings, []);
	assert.ok(supported.active.includes("web_enable"), `expected web_enable, got ${supported.active.join(", ")}`);

	const unsupported = run({ hostVersion: "0.86.0" });
	assert.match(unsupported.warnings[0], /running 0\.86\.0/);
	assert.equal(unsupported.active.includes("web_enable"), false);
});

test("a stale package-local Pi copy cannot satisfy the gate", () => {
	// The extension's own Pi import reports the 0.85.1 peer while the running entry is 0.87.1.
	const state = run({ entryPointVersion: "0.87.1", hook: stalePiImportHook("0.85.1") });
	assert.deepEqual(state.warnings, []);
	assert.ok(state.active.includes("web_enable"), `expected web_enable, got ${state.active.join(", ")}`);
});

test("an unverifiable host keeps web tools eager", () => {
	const state = run();
	assert.equal(state.active.includes("web_enable"), false, `expected no web_enable, got ${state.active.join(", ")}`);
	assert.ok(state.warnings.some(message => /could not verify the running Pi installation/.test(message)), JSON.stringify(state.warnings));
});

test("compiled hosts read the Pi manifest shipped beside the executable", () => {
	const adjacent = mkdtempSync(join(tmpdir(), "pi-web-access-image-"));
	writeFileSync(join(adjacent, "pi"), "");
	writeFileSync(join(adjacent, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1" }));
	const supported = run({ compiledHost: { execPath: join(adjacent, "pi") } });
	assert.deepEqual(supported.warnings, []);
	assert.ok(supported.active.includes("web_enable"), `expected web_enable, got ${supported.active.join(", ")}`);

	const shared = mkdtempSync(join(tmpdir(), "pi-web-access-image-"));
	const imageDir = join(shared, "bin");
	mkdirSync(imageDir, { recursive: true });
	writeFileSync(join(imageDir, "pi"), "");
	const shareDir = join(shared, "share", "pi-coding-agent");
	mkdirSync(shareDir, { recursive: true });
	writeFileSync(join(shareDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.86.0" }));
	const unsupported = run({ compiledHost: { execPath: join(imageDir, "pi") } });
	assert.equal(unsupported.active.includes("web_enable"), false);
	assert.match(unsupported.warnings[0], /running 0\.86\.0/);
});

test("a compiled host without a shipped manifest stays unverified", () => {
	const bare = mkdtempSync(join(tmpdir(), "pi-web-access-image-"));
	writeFileSync(join(bare, "pi"), "");
	const state = run({ compiledHost: { execPath: join(bare, "pi") } });
	assert.equal(state.active.includes("web_enable"), false, `expected no web_enable, got ${state.active.join(", ")}`);
	assert.ok(state.warnings.some(message => /could not verify the running Pi installation/.test(message)), JSON.stringify(state.warnings));
});

test("a warm session restores exactly the tools it recorded", () => {
	const messages = [
		{ role: "system", content: "", toolsAdded: [{ name: "web_search", description: "", parameters: { type: "object" } }], timestamp: 1 },
		{ role: "system", content: "", toolsRemoved: [{ name: "source_check" }], timestamp: 2 },
	];
	const state = run({ messages, hostVersion: "0.87.1" });
	assert.deepEqual(state.warnings, []);
	assert.ok(state.active.includes("web_search"), `expected restored web_search, got ${state.active.join(", ")}`);
	assert.equal(state.active.includes("fetch_content"), false, `fetch_content was never recorded, got ${state.active.join(", ")}`);
});
