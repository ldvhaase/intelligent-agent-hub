// Shared config loader for the orchestration layer.
// Config lives in orchestrator/config.yaml (agents, pricing, budgets,
// thresholds) and is committed — changing a pin or a cap is a reviewable diff.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const AGENT_HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = join(AGENT_HUB_ROOT, "orchestrator", "config.yaml");
export const BASELINES_PATH = join(AGENT_HUB_ROOT, "evals", "baselines.json");
export const PROBES_DIR = join(AGENT_HUB_ROOT, "evals", "probes");

export function loadConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) throw new Error(`orchestrator config not found: ${path}`);
  const cfg = YAML.parse(readFileSync(path, "utf8"));
  for (const key of ["agents", "pricing", "budget"]) {
    if (!cfg[key]) throw new Error(`config.yaml missing required section: ${key}`);
  }
  if (!cfg.pricing.default) throw new Error("config.yaml pricing must include a default entry");
  return cfg;
}

export function getAgent(config, agentId) {
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`unknown agent: ${agentId} (known: ${Object.keys(config.agents).join(", ")})`);
  return agent;
}
