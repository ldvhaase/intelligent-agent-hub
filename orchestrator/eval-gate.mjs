#!/usr/bin/env node
// Model-swap regression gate. Run it from CI on a schedule, not just on
// code pushes: the thing it watches — which model the platform actually
// answers with per agent — changes without any commit landing.
//
// Usage:
//   node orchestrator/eval-gate.mjs [--runner dry-run|cmd] [--cmd "..."]
//                                   [--agent <id>] [--record] [--accept]
//
// Per agent with probes under evals/probes/:
//   1. run every probe through the runner, note the OBSERVED model id
//   2. score outputs against the probe checks (deterministic)
//   3. compare (agent, model) against evals/baselines.json
//      - same model, score holds          -> pass
//      - same model, score dropped        -> FAIL (prompt/harness regression)
//      - observed != pinned model         -> the silent swap. FAIL until a
//        human reviews and re-pins (--accept), even if quality holds
//        (config onModelSwap: fail). Quality drop vs the pin's baseline
//        always fails.
//   --record   establish pin + baseline for whatever answered (first run)
//   --accept   approve a detected swap: re-pin + baseline the new model
//
// Exit codes: 0 pass, 1 gate failed.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { AGENT_HUB_ROOT, BASELINES_PATH, PROBES_DIR, loadConfig, getAgent } from "./config.mjs";
import { assessDrift, baselineKey, loadBaselines, saveBaselines, scoreOutput } from "./model-registry.mjs";
import { createRunner } from "./runner.mjs";

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const vals = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) vals.push(args[j]);
  return vals.join(" ") || null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const config = loadConfig();
const record = hasFlag("record");
const accept = hasFlag("accept");
const agentFilter = flag("agent");
const runner = createRunner({ type: flag("runner") ?? "dry-run", cmd: flag("cmd") });

if (!existsSync(PROBES_DIR)) fail(`no probes directory at ${PROBES_DIR}`);
const probeFiles = readdirSync(PROBES_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
if (!probeFiles.length) fail("no probe files under evals/probes/");

const baselines = loadBaselines(BASELINES_PATH);
const workDir = join(AGENT_HUB_ROOT, "evals", "work");
const results = [];

for (const file of probeFiles) {
  const doc = YAML.parse(readFileSync(join(PROBES_DIR, file), "utf8"));
  const agentId = doc.agent;
  if (agentFilter && agentId !== agentFilter) continue;
  const agent = getAgent(config, agentId);
  const pin = baselines.pins[agentId] ?? agent.pinnedModel;

  const probeResults = [];
  const observedModels = new Set();
  for (const probe of doc.probes) {
    const r = await runner({ taskId: `probe-${agentId}-${probe.id}`, agentId, agent: { ...agent, pinnedModel: pin }, prompt: probe.prompt, workDir });
    if (r.model) observedModels.add(r.model);
    const { score, results: checks } = scoreOutput(r.output, probe.checks);
    probeResults.push({ id: probe.id, score, checks, model: r.model });
  }

  const modelVerified = observedModels.size > 0;
  if (observedModels.size > 1) fail(`${agentId}: probes answered by multiple models in one run: ${[...observedModels].join(", ")}`);
  const observedModel = modelVerified ? [...observedModels][0] : pin;
  const score = Math.round((probeResults.reduce((a, p) => a + p.score, 0) / probeResults.length) * 1000) / 1000;

  let assessment = assessDrift({
    agentId,
    pin,
    observedModel,
    score,
    baselines: baselines.baselines,
    driftThreshold: config.driftThreshold ?? 0.05,
    failOnSwap: (config.onModelSwap ?? "fail") === "fail",
  });

  const wantsWrite = record || (accept && assessment.swapped);
  if (wantsWrite) {
    baselines.pins[agentId] = observedModel;
    baselines.baselines[baselineKey(agentId, observedModel)] = {
      score,
      probeScores: Object.fromEntries(probeResults.map((p) => [p.id, p.score])),
      recordedAt: new Date().toISOString(),
      probes: probeResults.length,
    };
    assessment = { ...assessment, status: assessment.swapped ? "swap-accepted" : "recorded", gate: false, reason: `pin + baseline written for ${baselineKey(agentId, observedModel)}` };
  }

  results.push({ agentId, pin, observedModel, modelVerified, score, probeResults, assessment });
}

if (!results.length) fail(agentFilter ? `no probes found for agent ${agentFilter}` : "no probes matched");
if (record || results.some((r) => r.assessment.status === "swap-accepted")) saveBaselines(BASELINES_PATH, baselines);

// --- Report -----------------------------------------------------------------------
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const lines = [`# Eval gate report ${ts}`, ""];
lines.push(`| Agent | Pinned | Observed | Score | Baseline | Delta | Status |`);
lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
for (const r of results) {
  const a = r.assessment;
  lines.push(`| ${r.agentId} | ${r.pin} | ${r.observedModel}${r.modelVerified ? "" : " (unverified)"} | ${r.score} | ${a.baselineScore ?? "—"} | ${a.delta ?? "—"} | ${a.status} |`);
}
lines.push("");
for (const r of results) {
  lines.push(`## ${r.agentId}`);
  lines.push("");
  lines.push(`- ${r.assessment.reason}`);
  for (const p of r.probeResults) {
    lines.push(`- probe \`${p.id}\`: ${p.score}${p.score < 1 ? ` (failed: ${p.checks.filter((c) => !c.pass).map((c) => `${c.type} ${JSON.stringify(c.value)}`).join("; ")})` : ""}`);
  }
  lines.push("");
}
const reportDir = join(AGENT_HUB_ROOT, "evals", "reports");
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, `${ts}.md`);
writeFileSync(reportPath, lines.join("\n"));

for (const r of results) {
  const mark = r.assessment.gate ? "FAIL" : "ok  ";
  console.log(`${mark} ${r.agentId.padEnd(12)} pin=${r.pin} observed=${r.observedModel} score=${r.score} -> ${r.assessment.status}`);
  if (r.assessment.gate || r.assessment.swapped) console.log(`     ${r.assessment.reason}`);
}
console.log(`report: ${reportPath}`);

if (results.some((r) => r.assessment.gate)) {
  console.error("\neval gate FAILED — see reasons above");
  process.exit(1);
}
