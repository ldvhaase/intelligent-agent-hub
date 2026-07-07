#!/usr/bin/env node
// Orchestrator: runs a planned story's APPROVED tasks as a parallel DAG of
// agent dispatches, with four control layers around every dispatch:
//
//   budget    reserve the per-task ceiling BEFORE the call; settle + credit
//             back after. A wave that cannot be fully reserved never starts.
//   ledger    every dispatch/completion/handoff/budget movement is a
//             hash-chained entry with evidence, confidence and causal links.
//   handoff   downstream tasks receive compacted structured summaries of
//             their dependencies' outputs, not full transcripts.
//   model     the observed model per dispatch is checked against the agent's
//             pin; a silent platform swap halts the run (policy: onModelSwap).
//
// Usage:
//   node orchestrator/orchestrate.mjs --story <slug>
//     [--runner dry-run|cmd] [--cmd "..."] [--max-parallel N]
//     [--budget-usd X] [--on-swap fail|warn]
//
// Approval gate is inherited from the planner: only tasks with
// approved: true in service-tasks.yaml are dispatched.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { createBudget, costUsd, estimateCeilingUsd, BudgetExceededError } from "./budget.mjs";
import { AGENT_HUB_ROOT, loadConfig, getAgent, BASELINES_PATH } from "./config.mjs";
import { computeWaves, blockedBy, mapLimit } from "./dag.mjs";
import { compactHandoff } from "./handoff.mjs";
import { openLedger } from "./ledger.mjs";
import { loadBaselines } from "./model-registry.mjs";
import { createRunner } from "./runner.mjs";
import { runnerDefaults } from "../lib/project-config.mjs";

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// --- Args -----------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const vals = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) vals.push(args[j]);
  return vals.join(" ") || null;
}

const storyArg = flag("story");
if (!storyArg) fail("usage: orchestrate --story <slug> [--runner dry-run|cmd] [--cmd ...] [--max-parallel N] [--budget-usd X] [--on-swap fail|warn]");
const storyDir = existsSync(join(storyArg, "story.yaml")) ? storyArg : join(AGENT_HUB_ROOT, "stories", storyArg);
if (!existsSync(join(storyDir, "story.yaml"))) fail(`story not found: ${storyDir} (run plan-story first)`);

const config = loadConfig();
const maxParallel = Number(flag("max-parallel") ?? 4);
const capUsd = Number(flag("budget-usd") ?? config.budget.runCapUsd);
const onSwap = flag("on-swap") ?? config.onModelSwap ?? "fail";
if (!["fail", "warn"].includes(onSwap)) fail(`--on-swap must be fail or warn`);
const runnerCfg = runnerDefaults();
const runnerType = flag("runner") ?? runnerCfg.type;
const runner = createRunner({ type: runnerType, cmd: flag("cmd") ?? runnerCfg.cmd });

const story = YAML.parse(readFileSync(join(storyDir, "story.yaml"), "utf8"));
const tasksDoc = YAML.parse(readFileSync(join(storyDir, "service-tasks.yaml"), "utf8"));
const slug = story.story;

// --- Select + validate tasks (approval gate, fail closed) --------------------------
const approved = tasksDoc.tasks.filter((t) => t.approved === true);
const skipped = tasksDoc.tasks.filter((t) => t.approved !== true);
if (!approved.length) fail("no approved tasks; review impact-analysis.md and set approved: true in service-tasks.yaml");

const problems = [];
for (const t of approved) {
  if (!existsSync(join(storyDir, t.contextPack))) problems.push(`${t.service}: missing context pack ${t.contextPack}`);
  const agentId = t.agent ?? config.defaultAgent;
  try {
    getAgent(config, agentId);
  } catch (e) {
    problems.push(`${t.service}: ${e.message}`);
  }
}
const { waves, cyclic } = computeWaves(approved);
if (cyclic.length) problems.push(`dependency cycle among: ${cyclic.join(", ")} (fix dependsOn in service-tasks.yaml)`);
if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  fail("preconditions failed; nothing was dispatched");
}

// --- Run setup ---------------------------------------------------------------------
const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const runDir = join(storyDir, "runs", runId);
mkdirSync(join(runDir, "outputs"), { recursive: true });
mkdirSync(join(runDir, "handoffs"), { recursive: true });

const ledger = openLedger(join(storyDir, "ledger.jsonl"));
const budget = createBudget({ capUsd, run: runId, ledger });
const pins = loadBaselines(BASELINES_PATH).pins;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

const runStarted = ledger.append({
  run: runId,
  actor: "orchestrator",
  action: "run-started",
  data: { story: slug, waves, capUsd, maxParallel, onSwap, runner: runnerType },
  evidence: [`${storyDir}/story.yaml`, `bundle:${story.bundleVersion}`],
});

const state = new Map(); // service -> { status, handoff, handoffEntry, model, costUsd, error }
const failed = new Set();
let swapHalt = null;

function buildPrompt(t) {
  const deps = (t.dependsOn ?? []).filter((d) => state.get(d)?.handoff);
  const lines = [
    `# Task: ${t.task}`,
    "",
    `- Story: ${story.title} (${slug})`,
    `- Service: ${t.service}`,
    `- Bundle: ${story.bundleVersion}`,
    "",
  ];
  if (deps.length) {
    lines.push(`## Upstream handoffs (${deps.length}) — compacted, paths/symbols/decisions verbatim`, "");
    for (const d of deps) lines.push(state.get(d).handoff, "");
  }
  lines.push("## Context pack", "", readFileSync(join(storyDir, t.contextPack), "utf8").trim(), "");
  return lines.join("\n");
}

async function runTask(t, prompt, dispatchEntry) {
  const agentId = t.agent ?? config.defaultAgent;
  const agent = getAgent(config, agentId);
  const pin = pins[agentId] ?? agent.pinnedModel;
  const taskId = `${slug}/${t.service}`;

  const result = await runner({ taskId: t.service, agentId, agent: { ...agent, pinnedModel: pin }, prompt, workDir: join(runDir, "outputs") });

  // Model-swap check against the pin, on the model the platform reported.
  let swapEntry = null;
  if (result.model && result.model !== pin) {
    swapEntry = ledger.append({
      run: runId,
      actor: "orchestrator",
      action: "model-swap-observed",
      data: { agent: agentId, pinned: pin, observed: result.model, policy: onSwap },
      evidence: [`dispatch:${dispatchEntry.hash}`],
      causes: [dispatchEntry.hash],
    });
    if (onSwap === "fail") swapHalt = { agent: agentId, pinned: pin, observed: result.model, entry: swapEntry.hash };
  }

  const model = result.model ?? pin;
  const actual = costUsd(result.usage, model, config.pricing);
  const settlement = budget.settle(t.service, actual, { estimated: result.estimated, causes: [dispatchEntry.hash] });

  const outputPath = join(runDir, "outputs", `${t.service}.md`);
  writeFileSync(outputPath, result.output);

  const completed = ledger.append({
    run: runId,
    actor: `agent:${agentId}`,
    action: "task-completed",
    data: { service: t.service, model, modelVerified: Boolean(result.model), usage: result.usage, costUsd: settlement.actualUsd, output: `runs/${runId}/outputs/${t.service}.md` },
    evidence: [t.contextPack, `bundle:${story.bundleVersion}`, `prompt:sha256:${sha(prompt)}`],
    confidence: result.confidence,
    causes: [dispatchEntry.hash, ...(swapEntry ? [swapEntry.hash] : [])],
  });

  const { markdown, stats } = compactHandoff({ service: t.service, agent: agentId, task: t.task, output: result.output });
  writeFileSync(join(runDir, "handoffs", `${t.service}.md`), markdown);
  const handoffEntry = ledger.append({
    run: runId,
    actor: "orchestrator",
    action: "handoff-created",
    data: { service: t.service, stats, path: `runs/${runId}/handoffs/${t.service}.md` },
    evidence: [`output:sha256:${sha(result.output)}`],
    causes: [completed.hash],
  });

  state.set(t.service, { status: "completed", handoff: markdown, handoffEntry: handoffEntry.hash, model, costUsd: settlement.actualUsd, stats });
  console.log(`  ${t.service}: completed (agent=${agentId} model=${model} cost=$${settlement.actualUsd}${result.estimated ? " est." : ""}, handoff ${stats.originalChars}->${stats.compactedChars} chars)`);
}

// --- Execute wave by wave -------------------------------------------------------------
let aborted = null;
for (let w = 0; w < waves.length; w++) {
  const blocked = blockedBy(approved, failed);
  const wave = waves[w]
    .map((id) => approved.find((t) => t.service === id))
    .filter((t) => !blocked.has(t.service));
  for (const id of waves[w]) {
    if (blocked.has(id)) {
      state.set(id, { status: "blocked", error: `upstream ${blocked.get(id)} failed` });
      console.log(`  ${id}: blocked (upstream ${blocked.get(id)} failed)`);
    }
  }
  if (!wave.length) continue;
  if (swapHalt) {
    aborted = `model swap (${swapHalt.pinned} -> ${swapHalt.observed} under agent ${swapHalt.agent}); run eval-gate, then --accept or fix pins`;
    break;
  }

  console.log(`wave ${w + 1}/${waves.length}: ${wave.map((t) => t.service).join(", ")}`);

  // Pessimistic reservation for the WHOLE wave before any dispatch.
  const prepared = [];
  try {
    for (const t of wave) {
      const agentId = t.agent ?? config.defaultAgent;
      const agent = getAgent(config, agentId);
      const prompt = buildPrompt(t);
      const ceiling = estimateCeilingUsd({
        promptChars: prompt.length,
        maxOutputTokens: config.budget.maxOutputTokensPerTask ?? 8192,
        model: pins[agentId] ?? agent.pinnedModel,
        pricing: config.pricing,
        maxUsdPerTask: agent.maxUsdPerTask ?? null,
      });
      budget.reserve(t.service, ceiling, { causes: [runStarted.hash] });
      prepared.push({ t, prompt, ceiling });
    }
  } catch (e) {
    for (const p of prepared) budget.release(p.t.service, { causes: [runStarted.hash] });
    if (e instanceof BudgetExceededError) {
      aborted = `budget cap: ${e.message}`;
      for (const t of wave) if (!state.has(t.service)) state.set(t.service, { status: "not-dispatched", error: "budget cap" });
      break;
    }
    throw e;
  }

  await mapLimit(prepared, maxParallel, async ({ t, prompt, ceiling }) => {
    const agentId = t.agent ?? config.defaultAgent;
    const dispatchEntry = ledger.append({
      run: runId,
      actor: "orchestrator",
      action: "task-dispatched",
      data: { service: t.service, agent: agentId, wave: w + 1, ceilingUsd: ceiling, dependsOn: t.dependsOn ?? [] },
      evidence: [t.contextPack, `bundle:${story.bundleVersion}`, `prompt:sha256:${sha(prompt)}`],
      causes: [runStarted.hash, ...(t.dependsOn ?? []).map((d) => state.get(d)?.handoffEntry).filter(Boolean)],
    });
    try {
      await runTask(t, prompt, dispatchEntry);
    } catch (e) {
      budget.settle(t.service, 0, { estimated: true, causes: [dispatchEntry.hash] }); // charge ceiling: cost unknown
      ledger.append({
        run: runId,
        actor: "orchestrator",
        action: "task-failed",
        data: { service: t.service, error: String(e.message ?? e) },
        causes: [dispatchEntry.hash],
      });
      state.set(t.service, { status: "failed", error: String(e.message ?? e) });
      failed.add(t.service);
      console.error(`  ${t.service}: FAILED — ${e.message ?? e}`);
    }
  });
}

// --- Reports --------------------------------------------------------------------------
const report = budget.report();
const finalEntry = ledger.append({
  run: runId,
  actor: "orchestrator",
  action: aborted ? "run-aborted" : "run-completed",
  data: {
    reason: aborted ?? null,
    tasks: Object.fromEntries([...state.entries()].map(([k, v]) => [k, v.status])),
    budget: { capUsd: report.capUsd, spentUsd: report.spentUsd, remainingUsd: report.remainingUsd },
  },
  causes: [runStarted.hash],
});

const br = [`# Budget report: ${runId}`, "", `Cap: $${report.capUsd} | Spent: $${report.spentUsd} | Remaining: $${report.remainingUsd}`, ""];
br.push(`| Task | Ceiling reserved | Actual | Credited back | Estimated |`);
br.push(`| --- | --- | --- | --- | --- |`);
for (const t of report.tasks) br.push(`| ${t.id} | $${t.ceilingUsd} | $${t.actualUsd} | $${Math.round((t.ceilingUsd - t.actualUsd) * 1e6) / 1e6} | ${t.estimated ? "yes (charged ceiling)" : "no"} |`);
writeFileSync(join(runDir, "budget-report.md"), br.join("\n") + "\n");

const or = [`# Orchestration report: ${story.title}`, "", `Run: ${runId} | Story: ${slug} | Bundle: ${story.bundleVersion}`, ""];
if (aborted) or.push(`**RUN ABORTED (fail closed):** ${aborted}`, "");
or.push(`Waves: ${waves.map((w, i) => `${i + 1}: [${w.join(", ")}]`).join("  ")}`, "");
or.push(`| Service | Status | Model | Cost | Handoff compaction |`);
or.push(`| --- | --- | --- | --- | --- |`);
for (const t of approved) {
  const s = state.get(t.service) ?? { status: "not-dispatched" };
  or.push(`| ${t.service} | ${s.status} | ${s.model ?? "—"} | ${s.costUsd !== undefined ? `$${s.costUsd}` : "—"} | ${s.stats ? `${s.stats.originalChars} -> ${s.stats.compactedChars} chars` : "—"} |`);
}
for (const t of skipped) or.push(`| ${t.service} | not approved (skipped) | — | — | — |`);
or.push("", `Decision ledger: \`ledger.jsonl\` entries ${runStarted.seq}..${finalEntry.seq} — verify with \`npm run ledger -- verify --story ${slug}\`.`, "");
writeFileSync(join(runDir, "orchestration-report.md"), or.join("\n"));

console.log(`\nbudget: spent $${report.spentUsd} of $${report.capUsd} (remaining $${report.remainingUsd})`);
console.log(`wrote ${join(runDir, "orchestration-report.md")}`);
console.log(`wrote ${join(runDir, "budget-report.md")}`);
console.log(`ledger: ${join(storyDir, "ledger.jsonl")} (entries ${runStarted.seq}..${finalEntry.seq})`);
if (aborted) fail(`run aborted: ${aborted}`);
