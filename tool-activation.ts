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
const CAPABILITY_LABELS: Record<WebCapability, string> = {
	search: "web search",
	"source-check": "source checking",
	fetch: "content fetching",
	"stored-content": "stored-result retrieval",
};

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

/** Compiled and bundled hosts keep the Pi API in memory instead of on disk. */
function hostApiInMemory(): boolean {
	if (typeof (process.versions as { bun?: string }).bun === "string") return true;
	if ((process as { features?: { sea?: boolean } }).features?.sea === true) return true;
	return typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE === true;
}

/**
 * Version of the Pi installation running this extension. The package installed next to
 * this extension is not authoritative: a managed install can keep an older
 * `@earendil-works/*` peer beside it, and a static import resolves to that copy before
 * the host's loader aliases apply. Walk up from the running entry point instead, accept
 * the `PI_PACKAGE_DIR` override, and read `VERSION` only from an in-memory host module.
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
	// A plain Node host whose entry point cannot be identified stays unverified rather
	// than reading a version from the package beside the extension.
	return hostApiInMemory() && typeof VERSION === "string" ? VERSION : undefined;
}

function unsupportedDynamicToolsReason(pi: ExtensionAPI): string | undefined {
	if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
		return "requires Pi 0.86.1 or newer";
	}
	const version = runningPiVersion();
	if (version === undefined) return "could not verify the running Pi installation";
	const [major, minor, patch] = version.split(".").map(part => Number.parseInt(part, 10));
	return major > 0 || minor > 86 || minor === 86 && patch >= 1 ? undefined : `requires Pi 0.86.1 or newer (running ${version})`;
}

function hasToolDeclarations(messages: unknown[]): boolean {
	return messages.some(message => message && typeof message === "object" && (
		"toolsAdded" in message || "toolsRemoved" in message
	));
}

function currentTranscriptToolNames(messages: unknown[]): string[] {
	const tools = new Set<string>();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const declaration = message as { toolsAdded?: Array<{ name: string }>; toolsRemoved?: Array<{ name: string }> };
		for (const tool of declaration.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of declaration.toolsAdded ?? []) tools.add(tool.name);
	}
	return [...tools];
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
	async function selectFromSession(ctx: ExtensionContext): Promise<void> {
		if (!loaderAvailable()) return;
		try {
			const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
			const recorded = hasToolDeclarations(messages)
				? new Set(await currentTranscriptToolNames(messages))
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
