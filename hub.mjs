#!/usr/bin/env node
// hub: one command surface for the whole story pipeline.
//
//   plan -> status -> approve -> execute / orchestrate -> ledger
//
// `status` shows where every story sits and the exact next command; `approve`
// is the human gate — it flips the flags AND records who approved what in the
// story's decision ledger. Everything else passes through to the underlying
// tool unchanged, so nothing here is a second way of doing things.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { AGENT_HUB_ROOT } from "./lib/project-config.mjs";
import { openLedger, readLedger } from "./orchestrator/ledger.mjs";

const USAGE = `usage: npm run hub -- <command> [args]

commands:
  plan --title "..." --story "..." [--services a,b]   story -> plan + context packs
  status [--story <slug>]                             pipeline stage per story + next step
  approve --story <slug> (--all | --services a,b) [--by <name>]
                                                      record human approval (ledger-backed)
  execute --story <slug> [flags]                      approved tasks -> branches + TASK.md
  orchestrate --story <slug> [flags]                  approved tasks -> parallel agent run
  eval-gate [flags]                                   model-swap regression gate
  ledger <verify|show|trace|override> [flags]         decision ledger tools
  knowledge <command> [args]                          knowledge bundle queries`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);
function flag(name) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return null;
  const vals = [];
  for (let j = i + 1; j < rest.length && !rest[j].startsWith("--"); j++) vals.push(rest[j]);
  return vals.join(" ") || null;
}
const hasFlag = (name) => rest.includes(`--${name}`);

const PASSTHROUGH = {
  plan: "story-planner/plan-story.mjs",
  execute: "story-planner/execute-story.mjs",
  orchestrate: "orchestrator/orchestrate.mjs",
  "eval-gate": "orchestrator/eval-gate.mjs",
  ledger: "orchestrator/ledger-cli.mjs",
  knowledge: "knowledge-client/cli.mjs",
};

const storiesDir = join(AGENT_HUB_ROOT, "stories");
const storyDirOf = (slug) => join(storiesDir, slug);

function loadStory(slug) {
  const dir = storyDirOf(slug);
  if (!existsSync(join(dir, "story.yaml"))) fail(`story not found: ${slug} (run \`hub plan\` first, or check \`hub status\`)`);
  return {
    dir,
    story: YAML.parse(readFileSync(join(dir, "story.yaml"), "utf8")),
    tasksDoc: YAML.parse(readFileSync(join(dir, "service-tasks.yaml"), "utf8")),
  };
}

function describe(slug) {
  const { dir, tasksDoc } = loadStory(slug);
  const tasks = tasksDoc.tasks;
  const approved = tasks.filter((t) => t.approved === true);
  const branched = tasks.filter((t) => ["branched", "pr-opened"].includes(t.status));
  const runsDir = join(dir, "runs");
  const runs = existsSync(runsDir) ? readdirSync(runsDir).sort() : [];
  const ledgerPath = join(dir, "ledger.jsonl");
  const ledgerEntries = existsSync(ledgerPath) ? readLedger(ledgerPath) : [];
  const lastRunEntry = [...ledgerEntries].reverse().find((e) => ["run-completed", "run-aborted"].includes(e.action));

  let stage, next;
  if (!approved.length) {
    stage = "planned";
    next = `review ${join("stories", slug, "impact-analysis.md")}, then: npm run hub -- approve --story ${slug} --all`;
  } else if (lastRunEntry?.action === "run-aborted") {
    stage = `run aborted (${runs.at(-1)})`;
    next = `read runs/${runs.at(-1)}/orchestration-report.md — ${lastRunEntry.data?.reason ?? "see ledger"}`;
  } else if (runs.length || branched.length) {
    stage = [runs.length ? `orchestrated (${runs.length} run${runs.length > 1 ? "s" : ""})` : null, branched.length ? `branched ${branched.length}/${tasks.length}` : null].filter(Boolean).join(", ");
    next = `merge in planned order (see implementation-plan.md); audit: npm run hub -- ledger verify --story ${slug}`;
  } else {
    stage = `approved ${approved.length}/${tasks.length}`;
    next = `npm run hub -- orchestrate --story ${slug}   (agents)  |  npm run hub -- execute --story ${slug}   (branches/PRs)`;
  }
  return { slug, stage, tasks: tasks.length, approved: approved.length, ledgerEntries: ledgerEntries.length, next };
}

switch (command) {
  case "status": {
    const one = flag("story");
    const slugs = one
      ? [one]
      : existsSync(storiesDir)
        ? readdirSync(storiesDir).filter((d) => existsSync(join(storiesDir, d, "story.yaml"))).sort()
        : [];
    if (!slugs.length) {
      console.log('no stories yet — start with: npm run hub -- plan --title "..." --story "..."');
      break;
    }
    for (const slug of slugs) {
      const d = describe(slug);
      console.log(`${d.slug}`);
      console.log(`  stage:  ${d.stage} (${d.approved}/${d.tasks} approved${d.ledgerEntries ? `, ${d.ledgerEntries} ledger entries` : ""})`);
      console.log(`  next:   ${d.next}`);
    }
    break;
  }

  case "approve": {
    const slug = flag("story");
    if (!slug) fail("usage: approve --story <slug> (--all | --services a,b) [--by <name>]");
    const { dir, tasksDoc } = loadStory(slug);
    const wanted = hasFlag("all")
      ? null
      : (flag("services") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (wanted !== null && !wanted.length) fail("pass --all or --services a,b (approval must be explicit)");

    let by = flag("by");
    if (!by) {
      try {
        by = execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim();
      } catch {
        by = process.env.USERNAME ?? process.env.USER ?? null;
      }
    }
    if (!by) fail("could not determine approver; pass --by <name>");

    const selected = tasksDoc.tasks.filter((t) => wanted === null || wanted.includes(t.service));
    if (wanted !== null) {
      const known = new Set(tasksDoc.tasks.map((t) => t.service));
      for (const w of wanted) if (!known.has(w)) fail(`no such task in ${slug}: ${w}`);
    }
    const flipped = [];
    for (const t of selected) {
      if (t.approved === true) console.log(`  ${t.service}: already approved`);
      else if (t.status !== "proposed") console.log(`  ${t.service}: status is "${t.status}" — not touching it`);
      else {
        t.approved = true;
        flipped.push(t.service);
      }
    }
    if (!flipped.length) fail("nothing to approve");
    writeFileSync(join(dir, "service-tasks.yaml"), YAML.stringify({ story: slug, tasks: tasksDoc.tasks }));

    const entry = openLedger(join(dir, "ledger.jsonl")).append({
      actor: `human:${by}`,
      action: "task-approved",
      data: { services: flipped },
      evidence: [`stories/${slug}/impact-analysis.md`, `stories/${slug}/service-tasks.yaml`],
    });
    console.log(`approved by ${by}: ${flipped.join(", ")} (ledger #${entry.seq} ${entry.hash.slice(0, 12)})`);
    console.log(`next: npm run hub -- orchestrate --story ${slug}   or   npm run hub -- execute --story ${slug}`);
    break;
  }

  default: {
    if (!command) {
      console.error(USAGE);
      process.exit(0);
    }
    const script = PASSTHROUGH[command];
    if (!script) fail(`unknown command: ${command}\n\n${USAGE}`);
    const r = spawnSync(process.execPath, [join(AGENT_HUB_ROOT, script), ...rest], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
}
