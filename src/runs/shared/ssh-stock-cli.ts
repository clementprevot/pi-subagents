import { spawn } from "node:child_process";

/** Run the stock CLI with the same terminal streams on Node, including Windows.
 * No shell/cmd parsing, detached process, model loop or agent runner is involved.
 */
export async function runStockPiCli(command: string, args: string[], cwd: string, agentDir: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: "inherit", shell: false });
		const forwardInterrupt = () => { child.kill("SIGINT"); };
		const forwardTermination = () => { child.kill("SIGTERM"); };
		const cleanup = () => {
			process.removeListener("SIGINT", forwardInterrupt);
			process.removeListener("SIGTERM", forwardTermination);
		};
		process.on("SIGINT", forwardInterrupt);
		process.on("SIGTERM", forwardTermination);
		child.once("error", error => { cleanup(); reject(error); });
		child.once("exit", (code, signal) => { cleanup(); resolve({ code, signal }); });
	});
}
