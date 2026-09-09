import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {} from "./src/types/pi-runtime-compat.d.ts";

const registerParentExtension = process.env.PI_SUBAGENT_CHILD === "1"
	? undefined
	: (await import("./src/extension/index.ts")).default;

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	const args = process.argv.slice(2), end = args.indexOf("--");
	if (args.slice(0, end < 0 ? args.length : end).some(arg => arg === "--ssh-bootstrap" || arg.startsWith("--ssh-bootstrap="))) throw new Error("Ordinary subagent root cannot be loaded alongside the owned SSH entry.");
	registerParentExtension?.(pi);
}
