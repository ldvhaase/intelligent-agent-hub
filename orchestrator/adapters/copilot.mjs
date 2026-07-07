#!/usr/bin/env node
// GitHub Copilot CLI adapter for the orchestrator's cmd runner.
//
// Wire it once in agent-hub.config.yaml:
//   runner: { type: cmd, cmd: node orchestrator/adapters/copilot.mjs }
//
// Per task, the runner provides env vars (TASK_AGENT, TASK_PROMPT_PATH, ...).
// This adapter maps the orchestrator agent to its Copilot custom agent
// (orchestrator/config.yaml -> agents.<id>.copilotAgent, defined in
// .github/agents/) and invokes:
//
//   copilot --agent=<name> -p "<instruction pointing at the briefing file>" --allow-all
//
// The instruction stays short on purpose: the briefing (task + handoffs +
// context pack) can exceed OS argv limits, and Copilot's custom agents have
// file tools — so we tell it to READ the briefing file rather than inlining it.
//
// Deliberately NOT written: $TASK_RESULT_PATH. The Copilot CLI does not
// report which underlying model served a request nor token usage in
// programmatic mode, and fabricating either would defeat the model-swap and
// budget layers. Leaving the result file absent makes the runner (a) estimate
// usage and charge the full reserved ceiling — pessimistic — and (b) record
// modelVerified: false in the ledger, which is the honest state.
//
// `--check` prints the resolved invocation without calling Copilot.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { copilotSettings } from "../../lib/project-config.mjs";
import { loadConfig } from "../config.mjs";

function fail(msg) {
  console.error(`copilot-adapter error: ${msg}`);
  process.exit(1);
}

const checkOnly = process.argv.includes("--check");
const agentId = process.env.TASK_AGENT ?? "implementer";
const promptPath = process.env.TASK_PROMPT_PATH;
if (!promptPath && !checkOnly) fail("TASK_PROMPT_PATH not set (this adapter is meant to be launched by the orchestrator's cmd runner)");
if (promptPath && !existsSync(promptPath)) fail(`briefing not found: ${promptPath}`);

const config = loadConfig();
const copilotAgent = config.agents[agentId]?.copilotAgent ?? agentId;
const { bin, extraArgs } = copilotSettings();

// No double quotes in this string — it must survive Windows shell quoting.
const instruction =
  `You are running as the agent-hub ${copilotAgent} agent. ` +
  `Read the task briefing file at ${resolve(promptPath ?? "<TASK_PROMPT_PATH>")} and complete the task it describes, ` +
  `following your agent instructions in .github/agents/${copilotAgent}.agent.md. ` +
  `When finished, print your structured summary (files touched, Decision:/Contract:/TODO: lines) as your final output.`;

const args = [`--agent=${copilotAgent}`, "-p", instruction, ...extraArgs];

if (checkOnly) {
  console.log(`bin:   ${bin}`);
  console.log(`agent: ${agentId} -> --agent=${copilotAgent}`);
  console.log(`args:  ${JSON.stringify(args)}`);
  process.exit(0);
}

// npm-installed CLIs are .cmd shims on Windows, which Node only runs through
// a shell; quote args ourselves since spawnSync does not when shell: true.
const result =
  process.platform === "win32"
    ? spawnSync([bin, ...args.map((a) => `"${a.replace(/"/g, '\\"')}"`)].join(" "), { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
    : spawnSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

if (result.error) fail(`failed to launch ${bin}: ${result.error.message} (is the Copilot CLI installed and on PATH?)`);
process.stdout.write(result.stdout ?? "");
process.exit(result.status ?? 1);
