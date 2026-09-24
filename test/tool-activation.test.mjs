import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { versionAtLeast } from "../tool-activation.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
// The repository's own Pi SDK stands in for a running installation by default.
const sdkPackageDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));

function childScript(options) {
	return `
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			const options = ${JSON.stringify(options)};
			const warnings = [];
			console.warn = (...args) => warnings.push(args.join(" "));
			if (options.stalePiAi) {
				const { registerHooks } = await import("node:module");
				registerHooks({
					resolve(specifier, context, nextResolve) {
						if (specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/")) {
							const error = new Error("Cannot find module '" + specifier + "'");
							error.code = "ERR_MODULE_NOT_FOUND";
							throw error;
						}
						return nextResolve(specifier, context);
					},
				});
			}
			const tools = new Map();
			const handlers = new Map();
			let active = ["read", "foreign_tool"];
			const pi = {
				registerTool(tool) { tools.set(tool.name, tool); if (!options.unavailable?.includes(tool.name)) active.push(tool.name); },
				registerCommand() {}, registerShortcut() {},
				on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
				getAllTools() { return [...tools.values()].filter(tool => !options.unavailable?.includes(tool.name)); },
				getActiveTools() { return [...active]; },
				setActiveTools(names) {
					if (options.throwOnSet) throw new Error("set failed");
					active = options.dropOnReadback ? names.filter(name => name !== options.dropOnReadback) : [...names];
				},
			};
			initializeExtension(pi);
			const entries = (options.messages ?? []).map((message, index) => ({
				type: "message", id: "message-" + index, parentId: index ? "message-" + (index - 1) : null,
				timestamp: new Date(index).toISOString(), message,
			}));
			const ctx = { sessionManager: { getBranch: () => entries } };
			for (const handler of handlers.get(options.event ?? "session_start") ?? []) await handler(options.eventPayload ?? {}, ctx);
			const before = [...active];
			let result;
			if (options.activate && tools.has("web_enable")) result = await tools.get("web_enable").execute("call", {}, new AbortController().signal, () => {}, ctx);
			if (options.secondActivation && tools.has("web_enable")) await tools.get("web_enable").execute("call2", {}, new AbortController().signal, () => {}, ctx);
			const loader = tools.get("web_enable");
			console.log(JSON.stringify({
				registered: [...tools.keys()], before, after: active, result,
				loader: loader && { description: loader.description, promptSnippet: loader.promptSnippet, parameters: loader.parameters },
				definitions: [...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
				warnings,
			}));
	`;
}

function run(config = {}, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-activation-"));
	writeFileSync(join(root, "web-search.json"), JSON.stringify(config), "utf8");
	const env = { ...process.env, PI_CODING_AGENT_DIR: root, XDG_CONFIG_HOME: "", HOME: join(root, "home"), USERPROFILE: join(root, "home") };
	if (options.hostPackageDir === null || options.hostVersion !== undefined) delete env.PI_PACKAGE_DIR;
	else env.PI_PACKAGE_DIR = options.hostPackageDir ?? sdkPackageDir;
	let child;
	if (options.hostVersion !== undefined) {
		// Run from inside a fake Pi installation so the entry point decides the version.
		const hostRoot = mkdtempSync(join(tmpdir(), "pi-web-access-host-"));
		mkdirSync(join(hostRoot, "dist", "bundle"), { recursive: true });
		writeFileSync(join(hostRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: options.hostVersion, type: "module" }));
		const entry = join(hostRoot, "dist", "bundle", "cli.js");
		writeFileSync(entry, childScript(options));
		child = spawnSync(process.execPath, [entry], { encoding: "utf8", env });
	} else {
		child = spawnSync(process.execPath, ["--input-type=module"], { input: childScript(options), encoding: "utf8", env });
	}
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

const defaultNames = ["web_search", "source_check", "fetch_content", "get_search_content"];

test("fresh sessions expose compact configured guidance and keep web tools registered but dormant", () => {
	const state = run();
	assert.deepEqual(state.registered, [...defaultNames, "web_enable"]);
	assert.deepEqual(state.before.filter(name => defaultNames.includes(name)), []);
	assert.ok(state.before.includes("web_enable"));
	assert.match(state.loader.description, /next model request/i);
	for (const capability of ["search", "source checking", "content fetching", "stored-result retrieval"]) {
		assert.match(state.loader.promptSnippet, new RegExp(capability, "i"));
	}
	assert.deepEqual(state.loader.parameters, { type: "object", properties: {}, additionalProperties: false });
});

test("activation enables every configured name once without removing unrelated tools", () => {
	const names = ["research_web", "verify_sources", "grab_content", "open_content"];
	const state = run({ toolNames: { webSearch: names[0], sourceCheck: names[1], fetchContent: names[2], getSearchContent: names[3] } }, { activate: true, secondActivation: true });
	assert.deepEqual(state.before, ["read", "foreign_tool", "web_enable"]);
	assert.deepEqual(state.after, ["read", "foreign_tool", "web_enable", ...names]);
	assert.equal(state.result.isError, undefined);
	assert.deepEqual(state.result.details.enabled, names);
});

test("disabled capabilities are neither registered nor advertised", () => {
	const state = run({ tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } });
	assert.deepEqual(state.registered, ["fetch_content", "web_enable"]);
	assert.match(state.loader.promptSnippet, /content fetching/i);
	assert.doesNotMatch(state.loader.promptSnippet, /source checking|stored-result retrieval|web search/i);
});

test("all-disabled configuration registers no loader", () => {
	const disabled = Object.fromEntries(["webSearch", "sourceCheck", "fetchContent", "getSearchContent"].map(key => [key, { enabled: false }]));
	const state = run({ tools: disabled });
	assert.deepEqual(state.registered, []);
	assert.deepEqual(state.before, ["read", "foreign_tool"]);
});

test("excluded loader leaves permitted legacy tools active", () => {
	const state = run({}, { unavailable: ["web_enable"] });
	assert.deepEqual(state.before.filter(name => defaultNames.includes(name)), defaultNames);
	assert.equal(state.before.includes("web_enable"), false);
});

test("activation reports unavailable and failed readback without false success", () => {
	const unavailable = run({}, { activate: true, unavailable: ["source_check"] });
	assert.equal(unavailable.result.isError, true);
	assert.deepEqual(unavailable.result.details.unavailable, ["source_check"]);

	const readback = run({}, { activate: true, dropOnReadback: "fetch_content" });
	assert.equal(readback.result.isError, true);
	assert.deepEqual(readback.result.details.missing, ["fetch_content"]);
	assert.equal(readback.result.content[0].text, "Tools still inactive after activation: fetch_content.");

	const thrown = run({}, { activate: true, throwOnSet: true });
	assert.equal(thrown.result.isError, true);
	assert.match(thrown.result.details.error, /set failed/);
});

test("cold and warm native transcript selections survive start and tree lifecycle", () => {
	const coldMessages = [{ role: "system", content: "", toolsAdded: [{ name: "web_enable", description: "", parameters: { type: "object" } }], timestamp: 1 }];
	const cold = run({}, { messages: coldMessages });
	assert.deepEqual(cold.before.filter(name => defaultNames.includes(name)), []);

	const warmMessages = [{ role: "system", content: "", toolsAdded: [{ name: "web_enable", description: "", parameters: { type: "object" } }, { name: "web_search", description: "", parameters: { type: "object" } }], timestamp: 1 }];
	const warm = run({}, { messages: warmMessages, event: "session_tree" });
	assert.deepEqual(warm.before.filter(name => defaultNames.includes(name)), ["web_search"]);
	const reloaded = run({}, { messages: warmMessages, eventPayload: { type: "session_start", reason: "reload" } });
	assert.deepEqual(reloaded.before.filter(name => defaultNames.includes(name)), ["web_search"]);
});

test("recorded selections restore when the package-local pi-ai is stale or absent", () => {
	const added = [{ role: "system", content: "", toolsAdded: [{ name: "web_search", description: "", parameters: { type: "object" } }], timestamp: 1 }];
	const warm = run({}, { messages: added, event: "session_tree", stalePiAi: true });
	assert.deepEqual(warm.before.filter(name => defaultNames.includes(name)), ["web_search"]);
	assert.ok(warm.before.includes("web_enable"));

	assert.deepEqual(warm.warnings, []);

	const removed = [...added, { role: "system", content: "", toolsRemoved: [{ name: "web_search" }], timestamp: 2 }];
	const cold = run({}, { messages: removed, event: "session_tree", stalePiAi: true });
	assert.deepEqual(cold.before.filter(name => defaultNames.includes(name)), []);
});

test("the running installation decides the version floor, not the package beside the extension", () => {
	const unsupported = run({}, { hostVersion: "0.85.1" });
	assert.deepEqual(unsupported.registered, [...defaultNames]);
	assert.ok(unsupported.warnings.some(message => /running 0\.85\.1/.test(message)), JSON.stringify(unsupported.warnings));

	const supported = run({}, { hostVersion: "0.87.1" });
	assert.deepEqual(supported.registered, [...defaultNames, "web_enable"]);
	assert.deepEqual(supported.warnings, []);
});

test("an unverifiable host keeps web tools eager instead of trusting the package beside the extension", () => {
	const state = run({}, { hostPackageDir: null });
	assert.deepEqual(state.registered, [...defaultNames]);
	assert.ok(state.warnings.some(message => /could not verify the running Pi installation/.test(message)), JSON.stringify(state.warnings));
});

test("versionAtLeast rejects unparsable versions and prereleases of the floor", () => {
	const floor = [0, 86, 1];
	for (const version of ["0.86.1", "0.86.2", "0.87.0", "1.0.0", "0.87.1-rc.1", "0.86.1+build.5", " 0.86.1 "]) {
		assert.equal(versionAtLeast(version, floor), true, version);
	}
	for (const version of ["0.86.0", "0.85.9", "0.86", "v0.87.1", "0.86.1-rc.1", "0.86.1garbage", ""]) {
		assert.equal(versionAtLeast(version, floor), false, version);
	}
});

test("legacy conversation without tool declarations preserves eager web tools", () => {
	const state = run({}, { messages: [{ role: "user", content: [{ type: "text", text: "old session" }], timestamp: 1 }] });
	assert.deepEqual(state.before.filter(name => defaultNames.includes(name)), defaultNames);
	assert.ok(state.before.includes("web_enable"));
});

test("provider-facing cold and activated schemas stay within budget", () => {
	const cold = run();
	const coldCharacters = cold.definitions.filter(tool => cold.before.includes(tool.name))
		.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
	assert.ok(coldCharacters <= 700, `cold schema is ${coldCharacters} characters`);

	const activated = run({}, { activate: true });
	const activatedCharacters = activated.definitions.filter(tool => activated.after.includes(tool.name))
		.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
	assert.ok(activatedCharacters <= 11_924, `activated schema is ${activatedCharacters} characters`);
});
