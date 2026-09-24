import { buildSessionContext, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";

export type WebCapability = "search" | "source-check" | "fetch" | "stored-content";

export interface WebActivationTool {
	name: string;
	capability: WebCapability;
}

const LOADER_NAME = "web_enable";
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MINIMUM_DYNAMIC_TOOLS_VERSION = [0, 86, 1] as const;
const CAPABILITY_LABELS: Record<WebCapability, string> = {
	search: "web search",
	"source-check": "source checking",
	fetch: "content fetching",
	"stored-content": "stored-result retrieval",
};

export function versionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]*)?$/.exec(version.trim());
	if (!match) return false;
	const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
	for (let index = 0; index < 3; index += 1) {
		if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
	}
	// Build metadata does not affect precedence; a prerelease sorts below its release.
	return match[4]?.startsWith("-") !== true;
}

function piVersionFrom(root: string | undefined): string | undefined {
	if (!root) return undefined;
	try {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return manifest?.name === PI_PACKAGE_NAME && typeof manifest.version === "string" ? manifest.version : undefined;
	} catch {
		return undefined;
	}
}

declare const PI_BUNDLED_NODE: boolean | undefined;

/** Compiled and bundled Pi hosts provide the Pi API as an in-memory module. */
function hostApiInMemory(): boolean {
	if (typeof (process.versions as { bun?: string }).bun === "string") return true;
	if ((process as { features?: { sea?: boolean } }).features?.sea === true) return true;
	return typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE === true;
}

/**
 * Version of the Pi installation running this extension. The package installed next
 * to this extension is not authoritative: a managed install can keep an older
 * `@earendil-works/*` peer beside it, and both `import.meta.resolve` and the
 * `VERSION` export then read that copy. Walk up from the running entry point
 * instead, and accept `VERSION` only from an in-memory host module, where it cannot
 * belong to a package sitting on disk.
 */
function runningPiVersion(): string | undefined {
	const entry = process.argv[1];
	if (entry) {
		try {
			let directory = dirname(realpathSync(entry));
			while (directory !== dirname(directory)) {
				if (existsSync(join(directory, "package.json"))) {
					const version = piVersionFrom(directory);
					if (version) return version;
				}
				directory = dirname(directory);
			}
		} catch {
			// Compiled hosts run a virtual entry point; the in-memory module covers them.
		}
	}
	const override = piVersionFrom(process.env.PI_PACKAGE_DIR?.trim());
	if (override) return override;
	// A plain Node host whose entry point cannot be identified stays unverified
	// rather than reading a version from the package beside the extension.
	return hostApiInMemory() && typeof VERSION === "string" ? VERSION : undefined;
}

function unsupportedDynamicToolsReason(pi: ExtensionAPI): string | undefined {
	if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
		return "requires Pi 0.86.1 or newer";
	}
	// The tool-selection methods exist since 0.85, so their presence is necessary but
	// not sufficient: restoring a transcript's recorded selection needs the 0.86.1
	// tool deltas. Only the running installation can confirm that.
	const version = runningPiVersion();
	if (version === undefined) return "could not verify the running Pi installation";
	return versionAtLeast(version, MINIMUM_DYNAMIC_TOOLS_VERSION) ? undefined : `requires Pi 0.86.1 or newer (running ${version})`;
}

function hasToolDeclarations(messages: unknown[]): boolean {
	return messages.some(message => message && typeof message === "object" && (
		"toolsAdded" in message || "toolsRemoved" in message
	));
}

type ToolSelectionMessage = {
	role?: unknown;
	toolsAdded?: readonly { name: string }[];
	toolsRemoved?: readonly { name: string }[];
};

/**
 * Replay the transcript's native tool-selection deltas locally. The
 * `@earendil-works/pi-ai` transcript helper is not authoritative here: it resolves
 * to the package installed next to this extension, which can predate the
 * tool-selection API and would then fail to restore the recorded selection.
 */
function transcriptToolNames(messages: unknown[]): string[] {
	const tools = new Map<string, { name: string }>();
	for (const message of messages) {
		if (!message || typeof message !== "object" || (message as ToolSelectionMessage).role !== "system") continue;
		const system = message as ToolSelectionMessage;
		for (const tool of system.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of system.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.keys()];
}

export function registerWebToolActivation(pi: ExtensionAPI, tools: ReadonlyArray<WebActivationTool>): void {
	if (tools.length === 0) return;
	const unsupportedReason = unsupportedDynamicToolsReason(pi);
	if (unsupportedReason) {
		console.warn(`[pi-web-access] Dynamic tool activation ${unsupportedReason}; web tools remain eagerly available.`);
		return;
	}
	const names = tools.map(tool => tool.name);
	const capabilities = tools.map(tool => CAPABILITY_LABELS[tool.capability]).join(", ");

	const parameters = Type.Object({}, { additionalProperties: false });
	pi.registerTool<typeof parameters, Record<string, unknown>>({
		name: LOADER_NAME,
		label: "Enable Web Access",
		description: "Enable configured pi-web-access tools for web research and content retrieval. Does not search or fetch. Enabled tools are available on the next model request; disabled capabilities remain unavailable.",
		promptSnippet: `pi-web-access is configured for ${capabilities}. Call web_enable to activate these tools; use them on the next model request.`,
		parameters,
		async execute() {
			const registered = new Set(pi.getAllTools().map(tool => tool.name));
			const unavailable = names.filter(name => !registered.has(name));
			if (unavailable.length > 0) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: `Cannot enable unavailable tools: ${unavailable.join(", ")}.` }],
					details: { unavailable },
				};
			}

			try {
				pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					isError: true,
					content: [{ type: "text" as const, text: `Activation failed: ${message}.` }],
					details: { error: message },
				};
			}

			const active = new Set(pi.getActiveTools());
			const missing = names.filter(name => !active.has(name));
			return missing.length > 0
				? {
					isError: true,
					content: [{ type: "text" as const, text: `Tools still inactive after activation: ${missing.join(", ")}.` }],
					details: { missing },
				}
				: {
					content: [{ type: "text" as const, text: `Enabled: ${names.join(", ")}.` }],
					details: { enabled: names },
				};
		},
	});

	function loaderAvailable(): boolean {
		return pi.getAllTools().some(tool => tool.name === LOADER_NAME);
	}

	let warned = false;
	function selectFromSession(ctx: ExtensionContext): void {
		if (!loaderAvailable()) return;
		try {
			const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
			const recorded = hasToolDeclarations(messages)
				? new Set(transcriptToolNames(messages))
				: messages.length > 0
					? new Set(names)
					: new Set<string>();
			const heavy = new Set(names);
			const active = pi.getActiveTools().filter(name => !heavy.has(name));
			for (const name of names) if (recorded.has(name)) active.push(name);
			pi.setActiveTools([...new Set([...active, LOADER_NAME])]);
		} catch (error) {
			if (!warned) {
				warned = true;
				console.warn(`[pi-web-access] Keeping web tools eagerly available because activation setup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	pi.on("session_start", (_event, ctx) => selectFromSession(ctx));
	pi.on("session_tree", (_event, ctx) => selectFromSession(ctx));
	pi.on("before_agent_start", () => {
		if (!loaderAvailable() || pi.getActiveTools().includes(LOADER_NAME)) return;
		try {
			pi.setActiveTools([...pi.getActiveTools(), LOADER_NAME]);
		} catch {
			// Best effort: preserve the current selection if Pi rejects the update.
		}
	});
}
