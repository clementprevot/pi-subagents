# SSH foreground delegation

Keep Pi, model authentication, configuration and session files on your computer while reading and running commands in a remote POSIX project. The remote host needs OpenSSH access, Bash, `dd`, `base64` and `tr`—not Pi, Node, a service or synchronization software.

This entry is intentionally narrower than ordinary pi-subagents: **fresh, single, native foreground children only**. It does not close the broader SSH execution request in #2047.

## Start a session

Use an npm-installed Pi 0.85.1 or newer and Node 22.22 or newer. Install the package's command if it is not already on PATH:

```sh
npm install -g pi-subagents
```

Create an explicitly selected local agent document, for example `ssh-worker.md`:

```markdown
---
name: ssh-worker
description: Work in the bound remote project
tools: read,bash
async: false
defaultContext: fresh
systemPromptMode: append
---
Complete the assigned task. Verify changes with remote commands and report evidence.
```

Then start the stock local Pi CLI:

```sh
pi-subagents-ssh --target user@host --project /srv/project --agent /absolute/local/ssh-worker.md
```

On Windows, the agent path is an absolute Windows path such as `C:\Users\you\agents\ssh-worker.md`; `/srv/project` is always a remote POSIX path. The launcher uses Node and the installed Pi JavaScript entry, not shell-interpolated commands or a `.cmd` shell wrapper. Native Windows terminal behavior still requires platform validation; the automated cross-platform command test verifies argv construction, not a Windows terminal session.

Add trusted local provider extensions or selected skill documents explicitly:

```sh
pi-subagents-ssh --target host-alias --project /srv/project --agent /absolute/ssh-worker.md --extension /absolute/provider.ts --skill /absolute/SKILL.md
```

`--extension` and `--skill` may repeat. Optional startup controls are `--provider`, `--model`, `--mode text|json|rpc`, `--prompt` and `--offline`. There is no arbitrary forwarding of Pi flags. Local `@file` arguments, session/cwd switches, builtin/tool overrides and loading the ordinary subagent entry alongside this entry are rejected.

Ask Pi to delegate to the selected agent with `async:false` and `context:fresh`. The same public structured delegation API remains available. The parent has remote `read`, remote `bash`, and the bounded `subagent` tool. Parent `!` commands use the same remote command operation.

## Resources and identity

- HOME, the normal Pi agent directory, credentials and global model settings stay local. SSH uses your normal OpenSSH configuration/authentication with batch mode, strict host-key checking, no agent/X11/port forwarding and no `SendEnv` forwarding. Establish host trust separately; this command does not disable verification or prompt for passwords.
- The launcher preflights an empty, package-owned `ssh-control` directory under the normal agent directory before stock Pi can run cwd migrations or read cwd settings. Do not put project files there. It refuses a contaminated or symlinked control directory rather than cleaning it.
- Project settings, packages, extensions, skills, SYSTEM/APPEND_SYSTEM and unrelated local project AGENTS files are not substituted for remote project resources. Automatic global extension/skill/prompt-template activation is also disabled; use explicit selections.
- Intended global agent-directory context is restored explicitly. Remote AGENTS/CLAUDE candidates are read root-to-project in Pi's candidate order. Remote `.pi` configuration/executable resource discovery is unsupported. Symlinked project-directory identity is rejected; specify its physical POSIX path.
- Agent and selected skill Markdown are bounded immutable local snapshots, not directory grants or stock `/skill:` commands. `read` defaults to the remote project. `scope: "local-resource"` reads only the exact path of a selected Markdown snapshot; it does not expose helpers, assets, neighboring files or credentials. Relative links do not grant access.
- Child sessions and results remain local. Remote target identity contributes to the launch binding digest. A registered SSH session cannot silently launch an ordinary local child.

## Supported profile and refusals

Selected agents may specify name, description, model/thinking, read/bash tools, foreground/fresh defaults, timeout/tool timeout and the supported context settings. Use `systemPromptMode: append`; project/global context remains enabled and skills are explicitly selected rather than automatically inherited. Other frontmatter requirements are rejected, not dropped.

The following are unsupported and rejected: workflows/chains/parallel scripts, background/detach, fork/resume/recovery, nested delegation, managed worktrees and hooks, local Git/acceptance checks, explicit output/progress files, structured-output contracts, project management and resource reload/session replacement. Models may retry within their initialized session, but automatic fresh-session/retained-session relaunch is disabled.

**`/reload` terminates this opted-in SSH CLI with an error message.** Stock Pi has no cancellable pre-reload hook; exiting in the owned shutdown hook prevents rebuilding resources/tools without the SSH owner. Restart through the launcher for a fresh session. Existing persisted sessions are not deleted, but resuming them is not supported. Remote completion/cleanup may be uncertain. Ordinary non-SSH Pi reload is unchanged.

Conflicting configured worktrees, forced async, permission contracts, budgets, intercom/control automation, proactive skills, Orca observers, schedules, missions, custom child session directories and project-local artifact placement are rejected before initialization. Existing capability ceilings, depth limits and session spawn budgets still constrain admission. This first profile supplies inline results without an acceptance-command contract; it does not claim that successful command output proves an acceptance review.

An explicitly enabled global subagent watchdog is also unsupported: this entry rejects that policy rather than silently turning it off. The ordinary local watchdog is not constructed for remote projects, because its settings/Git readers operate locally.

`write`, `edit`, `grep`, `find`, `ls`, PowerShell and image/binary reads are not provided. Search/edit/build/test can be performed through remote Bash. Trusted provider extensions are still trusted local code; this is execution routing, **not a sandbox**.

## Bounds and cancellation

Context initialization happens before joining the common child-open queue, so a stalled SSH prefetch does not hold up an ordinary local child. Context files are limited to 64 KiB each, at most 32 ancestor levels, with bounded aggregate transport output. Text reads are UTF-8 only, limited to 256 KiB per file, paged by line offset/limit. Larger inspection can use bounded remote Bash. Tool output truncation is reported.

Transport defaults to 30 seconds; Bash accepts a timeout up to 300 seconds. Child delegation has a bounded overall deadline. Transport failure, overflow, invalid context or failed tool initialization never becomes local fallback.

Cancellation kills the owned **local SSH transport**. Remote descendants can survive or finish after a disconnect; completion and cleanup may be uncertain. This does not support unattended remote background jobs or guarantee remote process-tree termination.

## Validation boundary

Automated tests use the actual installed Pi 0.85.1 CLI/SDK, synthetic local identity and mocked SSH/network seams. They exercise public delegation and model-generated read/bash calls, first-request context, distinct targets, stalled-prefetch independence, resource selection and fail-closed errors. They do not connect to a real host. Native Windows terminal/signal testing and an operator's real SSH configuration remain separate validation gates.
