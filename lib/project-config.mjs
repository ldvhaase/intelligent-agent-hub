// Central project configuration.
//
// One committed file — agent-hub.config.yaml at the repo root — holds the
// per-team knobs (wiki location, service checkout root, default runner) so a
// team adopting agent-hub edits one file instead of exporting env vars in
// every shell. Precedence, highest first:
//
//   1. environment variable        (per-invocation override)
//   2. agent-hub.config.yaml       (committed team default)
//   3. built-in default            (sibling-directory convention)
//
// AGENT_HUB_CONFIG can point at an alternate config file (useful for CI and
// for teams layering a local override on top of the committed one).

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const AGENT_HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let cached = null;
let cachedPath = null;

function configFilePath() {
  return process.env.AGENT_HUB_CONFIG
    ? resolve(process.env.AGENT_HUB_CONFIG)
    : join(AGENT_HUB_ROOT, "agent-hub.config.yaml");
}

export function projectConfig({ reload = false } = {}) {
  const path = configFilePath();
  if (cached && cachedPath === path && !reload) return cached;
  cached = existsSync(path) ? YAML.parse(readFileSync(path, "utf8")) ?? {} : {};
  cachedPath = path;
  return cached;
}

// Relative paths in the config are relative to the agent-hub root, not the
// caller's cwd, so commands behave the same from any directory.
export function resolveFromRoot(p) {
  return isAbsolute(p) ? p : resolve(AGENT_HUB_ROOT, p);
}

export function knowledgeWikiPath() {
  const p =
    process.env.KNOWLEDGE_WIKI_PATH ??
    projectConfig().knowledgeWikiPath ??
    join(AGENT_HUB_ROOT, "..", "knowledge-network");
  return resolveFromRoot(p);
}

export function reposRoot() {
  const p = process.env.AGENT_HUB_REPOS_ROOT ?? projectConfig().reposRoot ?? join(AGENT_HUB_ROOT, "..");
  return resolveFromRoot(p);
}

// Default runner for orchestrate/eval-gate when --runner/--cmd flags are not
// given. Teams wire their agent CLI here once (e.g. the Copilot adapter).
export function runnerDefaults() {
  const r = projectConfig().runner ?? {};
  return { type: r.type ?? "dry-run", cmd: r.cmd ?? null };
}

export function copilotSettings() {
  const c = projectConfig().copilot ?? {};
  return {
    bin: process.env.COPILOT_CLI_BIN ?? c.bin ?? "copilot",
    // --allow-all is required for unattended runs; scope it down with
    // per-tool allowlists once your Copilot policy supports them.
    extraArgs: c.extraArgs ?? ["--allow-all"],
  };
}
