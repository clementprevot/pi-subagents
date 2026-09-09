#!/usr/bin/env node
// Strict stock-Pi SSH project entry; no SDK host or separate agent runner.
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

try {
	if (process.env.PI_SUBAGENT_CHILD === "1") throw new Error("Nested SSH entry is unsupported");
	// Node cannot strip TypeScript inside an npm installation's node_modules.
	const jiti = createJiti(import.meta.url);
	const { parseSshEntrySelection, validateSshEntrySelection, localAgentDir, assertCleanSshControl, sshStockCliArgs } = await jiti.import("./src/runs/shared/ssh-cli-entry.ts");
	const { getPiSpawnCommand } = await jiti.import("./src/runs/shared/pi-spawn.ts");
	const { runStockPiCli } = await jiti.import("./src/runs/shared/ssh-stock-cli.ts");
	const { snapshotSshProjectBootstrap } = await jiti.import("./src/runs/shared/ssh-project-bootstrap.ts");
	const input = parseSshEntrySelection(process.argv.slice(2));
	const agentDir = localAgentDir();
	const cwd = path.join(agentDir, "ssh-control");
	const { selection, profile } = validateSshEntrySelection(input, cwd, agentDir);
	// All user options/resources are validated before creating the control directory.
	fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
	assertCleanSshControl(cwd);
	const controlCwd = fs.realpathSync(cwd), runtimeDir = fs.realpathSync(agentDir);
	const canonicalProfile = snapshotSshProjectBootstrap({ ...profile, localRuntime: { ...profile.localRuntime, cwd: controlCwd, agentDir: runtimeDir } });
	// Existing resolver uses the installed package's JS bin with Node on Windows,
	// avoiding npm .cmd wrappers and shell interpolation entirely.
	const pi = getPiSpawnCommand(sshStockCliArgs(selection, canonicalProfile));
	const result = await runStockPiCli(pi.command, pi.args, controlCwd, runtimeDir);
	if (result.signal && process.platform !== "win32") process.kill(process.pid, result.signal);
	else process.exitCode = result.code ?? (result.signal === "SIGINT" ? 130 : 143);
} catch {
	// Never echo argv, bootstrap, selected document text, or credential environment.
	console.error("SSH entry refused: unsupported arguments, resources, control directory, or runtime. No local fallback was started.");
	process.exitCode = 1;
}
