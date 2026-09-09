import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { devNull } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSshEntrySelection, validateSshEntrySelection, sshStockCliArgs } from "../../src/runs/shared/ssh-cli-entry.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpRoot = path.join(repo, "tmp");
const sdkRoot = process.env.PI_SUBAGENTS_REAL_SDK_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const available = fs.existsSync(path.join(sdkRoot, "dist/bundle/cli.js"));

function createRepoTempDir(prefix: string): string {
	fs.mkdirSync(tmpRoot, { recursive: true });
	return fs.mkdtempSync(path.join(tmpRoot, prefix));
}

function importHref(file: string): string {
	return JSON.stringify(pathToFileURL(file).href);
}

test("npm-installed SSH launcher loads TypeScript without NODE_OPTIONS", { timeout: 60_000 }, () => {
	const root = createRepoTempDir("ssh-installed-");
	const installed = path.join(root, "node_modules/pi-subagents");
	const home = path.join(root, "home"), agentDir = path.join(home, ".pi/agent");
	fs.mkdirSync(home, { recursive: true });
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
	for (const key of Object.keys(env)) {
		if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(key) || /^(?:NODE_OPTIONS|NODE_PATH|JITI_|PI_SUBAGENT_|PI_SUBAGENTS_|npm_config_)/iu.test(key)) delete env[key];
	}
	// Materialize the actual npm file list, not a virtual loader URL or source symlink.
	// Dependencies resolve from the checkout's node_modules as in a hoisted install.
	const packed = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--ignore-scripts", "--offline", `--userconfig=${devNull}`, "--json"], {
		cwd: repo, env, encoding: "utf8", timeout: 30_000, shell: process.platform === "win32", maxBuffer: 1024 * 1024,
	});
	assert.equal(packed.status, 0, packed.stderr);
	const manifest = JSON.parse(packed.stdout)[0] as { files: Array<{ path: string; mode: number }> };
	for (const file of manifest.files) {
		const destination = path.join(installed, file.path);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(path.join(repo, file.path), destination);
		fs.chmodSync(destination, file.mode);
	}
	const launcher = path.join(installed, "ssh-launch.mjs");
	const refused = spawnSync(process.execPath, [launcher, "--unsupported"], { env, encoding: "utf8", timeout: 15_000 });
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /SSH entry refused:/);
	assert.doesNotMatch(refused.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
	// A real child executable is the stock-CLI I/O seam; actual Pi behavior stays
	// owned by the integration test below. This smoke never invokes SSH.
	const cli = path.join(root, "cli.mjs"), agent = path.join(root, "agent.md");
	fs.writeFileSync(cli, "#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),agentDir:process.env.PI_CODING_AGENT_DIR,nodeOptions:process.env.NODE_OPTIONS}));\n", { mode: 0o755 });
	fs.writeFileSync(agent, "---\nname: smoke\n---\nSmoke only.\n");
	const started = spawnSync(process.execPath, [launcher, "--target", "unused-host", "--project", "/remote", "--agent", agent], {
		env: { ...env, PI_SUBAGENT_PI_BINARY: cli }, encoding: "utf8", timeout: 15_000,
	});
	assert.equal(started.status, 0, started.stderr);
	const receipt = JSON.parse(started.stdout);
	assert.equal(receipt.cwd, fs.realpathSync(path.join(agentDir, "ssh-control")));
	assert.equal(receipt.agentDir, fs.realpathSync(agentDir));
	assert.equal(receipt.nodeOptions, undefined);
	assert(receipt.args.includes(path.join(installed, "ssh-entry.ts")));
	assert(receipt.args.some((arg: string) => arg.startsWith("--ssh-bootstrap=")));
});

test("stock CLI SSH foreground: first child model request, owned read/bash, public delegation, local identity", { skip: !available, timeout: 90_000 }, () => {
	const root = createRepoTempDir("ssh-full-");
	const home = path.join(root, "home"), agentDir = path.join(home, ".pi/agent"), unrelated = path.join(root, "unrelated");
	fs.mkdirSync(agentDir, { recursive: true }); fs.mkdirSync(unrelated);
	fs.writeFileSync(path.join(unrelated, "AGENTS.md"), "UNRELATED_LOCAL_PROJECT");
	fs.mkdirSync(path.join(unrelated, ".pi")); fs.writeFileSync(path.join(unrelated, ".pi/settings.json"), '{"defaultModel":"UNRELATED"}');
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "ssh-proof", defaultModel: "proof-model" }));
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "ssh-proof": { type: "api_key", key: "SYNTHETIC_TEST_ONLY" } }));
	fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "INTENDED_GLOBAL_CONTEXT");
	const agent = path.join(root, "agent.md"), skill = path.join(root, "skill.md"), provider = path.join(root, "provider.ts"), preload = path.join(root, "preload.mjs"), trace = path.join(root, "trace.jsonl"), response = path.join(root, "response.json");
	fs.writeFileSync(agent, "---\nname: ssh-worker\ndescription: SSH worker\ntools: read,bash\nasync: false\ndefaultContext: fresh\nsystemPromptMode: append\n---\nSELECTED_AGENT_PROMPT");
	fs.writeFileSync(skill, "---\nname: selected-skill\ndescription: Selected skill\n---\nSELECTED_SKILL_TEXT");
	fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import net from 'node:net';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {syncBuiltinESMExports} from 'node:module';
const append=fs.appendFileSync;const log=(kind,value)=>append(${JSON.stringify(trace)},JSON.stringify({kind,value})+'\\n');
for(const key of ['readFileSync','openSync','readdirSync']){const old=fs[key];fs[key]=function(file,...args){if(String(file).startsWith(${JSON.stringify(unrelated)}))log('UNRELATED',String(file));if(process.env.SSH_PROOF_RELOAD==='1'&&String(file)===${JSON.stringify(path.join(agentDir, "settings.json"))})log('SETTINGS_READ',String(file));return old.call(this,file,...args)}}
const realSpawn=cp.spawn;cp.spawn=function(command,args,options){
 if(process.argv[1]===${JSON.stringify(path.join(repo, "ssh-launch.mjs"))} && command===process.execPath)return realSpawn(command,args,options);
 if(command!=='ssh'){log('PROCESS',String(command));throw new Error('Unexpected local process')}
 log('SSH',args);const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{queueMicrotask(()=>child.emit('close',null));return true};let script='';child.stdin.on('data',x=>script+=x);child.stdin.on('finish',()=>{log('SCRIPT',script);const target=args[args.indexOf('--')+1];if(target==='stall')return;if(target==='fail'){queueMicrotask(()=>child.emit('close',255));return}const output=script.includes('for p in')?'/srv/project/AGENTS.md\\n'+Buffer.from(target+'_REMOTE_CONTEXT').toString('base64')+'\\n':script.includes('dd if=')?Buffer.from(target+'_REMOTE_FILE').toString('base64'):'REMOTE_BASH_OUTPUT';queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(output));child.emit('close',0)})});return child;
};for(const key of ['spawnSync','exec','execSync','execFile','execFileSync'])cp[key]=(...args)=>{log('PROCESS',{key,args,stack:new Error().stack});throw new Error('Unexpected local process')};
globalThis.fetch=async()=>{log('NETWORK','fetch');throw new Error('Network denied')};net.Socket.prototype.connect=function(){log('NETWORK','socket');throw new Error('Network denied')};syncBuiltinESMExports();`);
	fs.writeFileSync(provider, `import fs from 'node:fs';import {registerSubagentCapabilityCeiling} from ${importHref(path.join(repo, "src/api/capability-ceiling.ts"))};import {createAssistantMessageEventStream} from ${importHref(path.join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"))};
export default function(pi){const key=Symbol.for('proof.provider.loads');if(process.env.SSH_PROOF_RELOAD==='1'){globalThis[key]=(globalThis[key]||0)+1;fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({kind:'FACTORY'})+'\\n')}
pi.on('session_start',(_,ctx)=>{if(process.env.SSH_PROOF_CEILING==='1')registerSubagentCapabilityCeiling({sessionId:ctx.sessionManager.getSessionId(),source:'proof',ceiling:{allowedTools:['read']}})});
pi.on('session_start',()=>{fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({kind:'SKILL_COMMANDS',value:pi.getCommands().filter(command=>command.source==='skill').map(command=>command.name)})+'\\n')});
pi.registerCommand('proof-reload',{description:'Proof reload',handler:async(_args,ctx)=>{fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({kind:'BEFORE_RELOAD'})+'\\n');await ctx.reload();fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({kind:'AFTER_RELOAD'})+'\\n')}});
if(process.env.SSH_PROOF_CONFLICT==='1'||globalThis[key]>1)pi.registerTool({name:'read',label:'read',description:'Forbidden provider fallback',parameters:{type:'object',properties:{}},async execute(){throw new Error('PROVIDER_LOCAL_FALLBACK')}});
pi.registerProvider('ssh-proof',{baseUrl:'http://127.0.0.1:1',api:'openai-completions',models:[{id:'proof-model',name:'Proof',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:512}],streamSimple(model,context){
 const parent=context.tools?.some(t=>t.name==='subagent')||context.tools?.length===0;fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({kind:parent?'PARENT_MODEL':'MODEL',value:{prompt:context.systemPrompt,tools:context.tools?.map(t=>t.name),messages:context.messages}})+'\\n');
 const stream=createAssistantMessageEventStream();const results=context.messages.filter(m=>m.role==='toolResult');const content=parent?(results.length===0&&context.tools?.length?[{type:'toolCall',id:'parent-read',name:'read',arguments:{path:${JSON.stringify(skill)},scope:'local-resource'}}]:[{type:'text',text:'PARENT_DONE'}]):results.length===0?[{type:'toolCall',id:'r',name:'read',arguments:{path:'AGENTS.md'}}]:results.length===1?[{type:'toolCall',id:'b',name:'bash',arguments:{command:'printf remote'}}]:[{type:'text',text:'REMOTE_CHILD_DONE'}];
 const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,stopReason:content[0].type==='toolCall'?'toolUse':'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end()});return stream;}});
 pi.on('before_agent_start',async(_,ctx)=>{if(!pi.getActiveTools().includes('subagent'))return;
 await new Promise(resolve=>{pi.events.on('prompt-template:subagent:response',result=>{fs.writeFileSync(${JSON.stringify(response)},JSON.stringify(result));resolve()});
 pi.events.emit('prompt-template:subagent:request',{requestId:'proof',ownerRunId:'proof-owner',nodeId:'proof-node',agent:'ssh-worker',task:'Read the project and run the command',context:'fresh',cwd:ctx.cwd,model:'ssh-proof/proof-model',result:{kind:'text'}});});
 });}`);
	const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: sdkRoot, NODE_OPTIONS: `--experimental-strip-types --import ${pathToFileURL(preload).href}` };
	for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_") || /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(key)) delete env[key as keyof typeof env];
	for (const target of ["target-A", "target-B"]) {
		fs.writeFileSync(trace, ""); fs.rmSync(response, { force: true });
		const result = spawnSync(process.execPath, [path.join(repo, "ssh-launch.mjs"), "--target", target, "--project", "/srv/project", "--agent", agent, "--skill", skill, "--extension", provider, "--mode", "json", "--prompt", "Delegate now", "--offline"], { cwd: unrelated, env, input: "", encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, JSON.stringify({ error: String(result.error), stderr: result.stderr, stdout: result.stdout }));
		assert(fs.existsSync(response), `No delegation response: ${result.stderr}`);
		const terminal = JSON.parse(fs.readFileSync(response, "utf8")); assert.equal(terminal.status, "completed", JSON.stringify(terminal)); assert.equal(terminal.result.text, "REMOTE_CHILD_DONE");
		const events = fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
		assert(!events.some(e => ["UNRELATED", "PROCESS", "NETWORK"].includes(e.kind)), JSON.stringify(events));
		const skillCommands = events.filter(e => e.kind === "SKILL_COMMANDS");
		assert(skillCommands.length > 0);
		assert(skillCommands.every(e => e.value.length === 0), "Selected Markdown must not activate stock skill commands that reread local files.");
		const models = events.filter(e => e.kind === "MODEL"); assert.equal(models.length, 3);
		assert(models[0].value.prompt.includes(`${target}_REMOTE_CONTEXT`)); assert(models[0].value.prompt.includes("INTENDED_GLOBAL_CONTEXT")); assert(models[0].value.prompt.includes("SELECTED_SKILL_TEXT")); assert(models[0].value.prompt.includes("SELECTED_AGENT_PROMPT"));
		assert.deepEqual(models[0].value.tools.sort(), ["bash", "read"]);
		assert(JSON.stringify(models[1]).includes(`${target}_REMOTE_FILE`)); assert(JSON.stringify(models[2]).includes("REMOTE_BASH_OUTPUT"));
		const parentModels = events.filter(e => e.kind === "PARENT_MODEL");
		const selectedRead = parentModels.at(-1).value.messages.find((message: { role: string }) => message.role === "toolResult");
		assert.equal(selectedRead.isError, false); assert(JSON.stringify(selectedRead).includes("SELECTED_SKILL_TEXT"));
	}
	// Actual factory/SDK behavior: a stalled remote fetch cannot occupy the common
	// open queue. The unrelated ordinary local child reaches its model first.
	const probe = path.join(root, "queue.mjs");
	fs.writeFileSync(probe, `import assert from 'node:assert/strict';import * as sdk from ${importHref(path.join(sdkRoot, "dist/index.js"))};import {createDefaultChildSessionFactory} from ${importHref(path.join(repo, "src/runs/shared/child-session.ts"))};
const factory=createDefaultChildSessionFactory({loadPiCodingAgent:async()=>sdk});const launch={cwd:${JSON.stringify(path.join(agentDir, "ssh-control"))},storage:{kind:'memory'},model:'ssh-proof/proof-model',tools:[],extensionPaths:[${JSON.stringify(provider)}],ambientExtensions:false,hooks:[],noSkills:true,noContextFiles:true,runtime:{fanoutChild:false,depth:1,fast:false,waitTool:{enabled:false}}};
const controller=new AbortController();const stalled=factory.create({...launch,sshProject:{target:'stall',projectDir:'/srv/project',childProfile:'fresh-native-read-bash',localRuntime:{cwd:launch.cwd,agentDir:${JSON.stringify(agentDir)},projectTrusted:false,noContextFiles:true,projectDiscovery:'disabled'}},sshSignal:controller.signal}).then(()=>{throw new Error('Unexpected stalled readiness')},error=>error);
const local=await factory.create(launch);await local.prompt('LOCAL_QUEUE_PROOF');controller.abort();assert.match(String(await stalled),/uncertain/);
const remote=target=>({...launch,tools:['read','bash'],sshProject:{target,projectDir:'/srv/project',childProfile:'fresh-native-read-bash',extensions:[${JSON.stringify(provider)}],localRuntime:{cwd:launch.cwd,agentDir:${JSON.stringify(agentDir)},projectTrusted:false,noContextFiles:true,projectDiscovery:'disabled'}}});
const [a,b]=await Promise.all([factory.create(remote('concurrent-A')),factory.create(remote('concurrent-B'))]);await Promise.all([a.prompt('A'),b.prompt('B')]);assert(JSON.stringify(a.messages).includes('concurrent-A_REMOTE_FILE'));assert(!JSON.stringify(a.messages).includes('concurrent-B_REMOTE_FILE'));assert(JSON.stringify(b.messages).includes('concurrent-B_REMOTE_FILE'));await factory.dispose();console.log('LOCAL_MODEL_BEFORE_STALLED_PREFETCH;CONCURRENT_TARGETS_ISOLATED');`);
	const queue = spawnSync(process.execPath, [probe], { cwd: path.join(agentDir, "ssh-control"), env, encoding: "utf8", timeout: 15_000 });
	assert.equal(queue.status, 0, `${queue.stderr}\n${queue.stdout}`); assert(queue.stdout.includes("LOCAL_MODEL_BEFORE_STALLED_PREFETCH"));
	fs.writeFileSync(trace, "");
	const failure = spawnSync(process.execPath, [path.join(repo, "ssh-launch.mjs"), "--target", "fail", "--project", "/srv/project", "--agent", agent, "--extension", provider, "--mode", "json", "--prompt", "Never prompt", "--offline"], { cwd: unrelated, env, input: "", encoding: "utf8", timeout: 15_000 });
	assert.equal(failure.status, 1); assert.match(failure.stderr, /Failed to load extension/);
	assert(!fs.readFileSync(trace, "utf8").includes('"MODEL"')); assert(!fs.readFileSync(trace, "utf8").includes('"PARENT_MODEL"'));
	const selectedText = fs.readFileSync(agent, "utf8");
	for (const unsupported of [selectedText.replace("async: false", "async: true"), selectedText.replace("defaultContext: fresh", "defaultContext: fork"), selectedText.replace("tools: read,bash", "tools: read,write"), selectedText.replace("systemPromptMode: append", "acceptance: true\nsystemPromptMode: append")]) {
		fs.writeFileSync(agent, unsupported); fs.writeFileSync(trace, "");
		const rejected = spawnSync(process.execPath, [path.join(repo, "ssh-launch.mjs"), "--target", "target-A", "--project", "/srv/project", "--agent", agent, "--extension", provider, "--mode", "json", "--prompt", "Never prompt", "--offline"], { cwd: unrelated, env, input: "", encoding: "utf8", timeout: 15_000 });
		assert.equal(rejected.status, 1); assert(!fs.readFileSync(trace, "utf8").includes('"SSH"')); assert(!fs.readFileSync(trace, "utf8").includes('"MODEL"'));
	}
	fs.writeFileSync(agent, selectedText);
	const config = path.join(agentDir, "extensions/subagent/config.json"); fs.mkdirSync(path.dirname(config), { recursive: true });
	for (const defaults of [{ worktree: true }, { forceTopLevelAsync: true }, { toolBudget: { hard: 2 } }, { permissions: { rules: { read: "deny" } } }, { maxSubagentDepth: 0 }]) {
		fs.writeFileSync(config, JSON.stringify(defaults)); fs.writeFileSync(trace, ""); fs.rmSync(response, { force: true });
		const rejected = spawnSync(process.execPath, [path.join(repo, "ssh-launch.mjs"), "--target", "target-A", "--project", "/srv/project", "--agent", agent, "--skill", skill, "--extension", provider, "--mode", "json", "--prompt", "Reject child defaults", "--offline"], { cwd: unrelated, env, input: "", encoding: "utf8", timeout: 15_000 });
		if ("maxSubagentDepth" in defaults) { assert.equal(rejected.status, 0, rejected.stderr); assert.equal(JSON.parse(fs.readFileSync(response, "utf8")).status, "failed"); }
		else { assert.equal(rejected.status, 1, rejected.stderr); assert(!fs.existsSync(response)); }
		const events = fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
		assert.equal(events.filter(e => e.kind === "SSH").length, "maxSubagentDepth" in defaults ? 1 : 0); // no child preparation
		assert(!events.some(e => ["MODEL", "PROCESS", "UNRELATED", "NETWORK"].includes(e.kind)));
	}
	fs.writeFileSync(config, "{}");
	fs.writeFileSync(trace, "");
	const userBash = spawnSync(process.execPath, [path.join(repo, "ssh-launch.mjs"), "--target", "target-A", "--project", "/srv/project", "--agent", agent, "--extension", provider, "--mode", "rpc", "--offline"], { cwd: unrelated, env, input: JSON.stringify({ type: "bash", id: "proof-bash", command: "printf remote" }) + "\n", encoding: "utf8", timeout: 15_000 });
	assert.equal(userBash.status, 0, userBash.stderr); assert(userBash.stdout.includes("REMOTE_BASH_OUTPUT"), userBash.stdout);
	const bashEvents = fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
	assert.equal(bashEvents.filter(event => event.kind === "SSH").length, 2);
	assert(!bashEvents.some(event => ["MODEL", "PARENT_MODEL", "PROCESS", "UNRELATED", "NETWORK"].includes(event.kind)));
	fs.writeFileSync(trace, "");
	const reload = spawnSync(process.execPath, [path.join(repo, "ssh-launch.mjs"), "--target", "target-A", "--project", "/srv/project", "--agent", agent, "--extension", provider, "--mode", "json", "--prompt", "/proof-reload", "--offline"], { cwd: unrelated, env: { ...env, SSH_PROOF_RELOAD: "1" }, input: "", encoding: "utf8", timeout: 15_000 });
	assert.equal(reload.status, 1); assert.match(reload.stderr, /SSH mode cannot safely reload; restart/);
	const reloadEvents = fs.readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(reloadEvents.filter(event => event.kind === "FACTORY").length, 1);
	assert(!reloadEvents.some(event => ["AFTER_RELOAD", "MODEL", "PARENT_MODEL", "PROCESS", "UNRELATED", "NETWORK"].includes(event.kind)));
	const reloadBoundary = reloadEvents.findIndex(event => event.kind === "BEFORE_RELOAD"); assert(reloadBoundary >= 0);
	assert(!reloadEvents.slice(reloadBoundary + 1).some(event => event.kind === "SETTINGS_READ"));
	const good = ["--target", "target-A", "--project", "/srv/project", "--agent", agent, "--extension", provider, "--mode", "json", "--prompt", "Do not prompt", "--offline"];
	fs.writeFileSync(trace, ""); fs.rmSync(response, { force: true });
	const narrowed = spawnSync(process.execPath, [path.join(repo, "ssh-launch.mjs"), ...good], { cwd: unrelated, env: { ...env, SSH_PROOF_CEILING: "1" }, input: "", encoding: "utf8", timeout: 15_000 });
	assert.equal(narrowed.status, 0, narrowed.stderr); assert.equal(JSON.parse(fs.readFileSync(response, "utf8")).status, "failed");
	assert(!fs.readFileSync(trace, "utf8").includes('"MODEL"'));
	fs.writeFileSync(trace, "");
	const conflicting = spawnSync(process.execPath, [path.join(repo, "ssh-launch.mjs"), ...good], { cwd: unrelated, env: { ...env, SSH_PROOF_CONFLICT: "1" }, input: "", encoding: "utf8", timeout: 15_000 });
	assert.equal(conflicting.status, 1); assert.match(conflicting.stderr, /Tool "read" conflicts/);
	assert(!fs.readFileSync(trace, "utf8").includes('"MODEL"')); assert(!fs.readFileSync(trace, "utf8").includes('"PARENT_MODEL"'));
	for (const hostile of [["--cwd", unrelated], ["--resume"], ["--session", "session.jsonl"], ["--session-dir", unrelated], [`@${path.join(unrelated, "AGENTS.md")}`], ["--tools", "read,write"], ["--extension", path.join(repo, "index.ts")], ["--ssh-bootstrap=bad"]]) {
		fs.writeFileSync(trace, "");
		const result = spawnSync(process.execPath, [path.join(repo, "ssh-launch.mjs"), ...good, ...hostile], { cwd: unrelated, env, input: "", encoding: "utf8", timeout: 15_000 });
		assert.equal(result.status, 1); assert.equal(fs.readFileSync(trace, "utf8"), "");
	}
	const prepared = validateSshEntrySelection(parseSshEntrySelection(good), path.join(agentDir, "ssh-control"), agentDir);
	const args = sshStockCliArgs(prepared.selection, prepared.profile), bootstrap = args.find(arg => arg.startsWith("--ssh-bootstrap="))!;
	const withFlags = (...extra: string[]) => [...args.slice(0, args.indexOf("--")), ...extra, ...args.slice(args.indexOf("--"))];
	for (const invalid of [args.filter(arg => arg !== bootstrap), withFlags(bootstrap), args.map(arg => arg === bootstrap ? "--ssh-bootstrap=bad" : arg), withFlags("-e", path.join(repo, "index.ts"))]) {
		fs.writeFileSync(trace, "");
		const result = spawnSync(process.execPath, [path.join(sdkRoot, "dist/bundle/cli.js"), ...invalid], { cwd: path.join(agentDir, "ssh-control"), env, input: "", encoding: "utf8", timeout: 15_000 });
		assert.equal(result.status, 1); assert.match(result.stderr, /Failed to load extension/); assert.equal(fs.readFileSync(trace, "utf8"), "");
	}
});
