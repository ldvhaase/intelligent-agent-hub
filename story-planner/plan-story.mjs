#!/usr/bin/env node
// Story planner: turns a user story into a knowledge-informed plan.
// Usage:
//   node story-planner/plan-story.mjs --title "..." --story "..." [--services a,b] [--out dir]
//
// Outputs (default: stories/<slug>/):
//   story.yaml              story intake record
//   impact-analysis.md      impacted services, APIs, events, risks
//   implementation-plan.md  per-service tasks + merge order guidance
//   service-tasks.yaml      one bounded task per service (requires human approval)
//   context-packs/<id>.md   compact context pack per impacted service
//
// Planning is deterministic: candidates come from explicit --services plus
// chunk-search matches; impact expansion uses graph edges only. This is the
// scaffold agents build on — it never invents facts.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  buildContextPack,
  getBlastRadius,
  getManifest,
  getServiceExport,
  searchChunks,
} from "../knowledge-client/client.mjs";

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

const title = flag("title");
const story = flag("story");
const explicitServices = (flag("services") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!title || !story) fail('usage: plan-story --title "..." --story "..." [--services a,b] [--out dir]');

const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const outDir = flag("out") ?? join("stories", slug);

const manifest = getManifest();
const knownServices = manifest.services.map((s) => s.service);

for (const s of explicitServices) {
  if (!knownServices.includes(s)) fail(`--services includes unknown service: ${s}`);
}

// --- Candidate detection -----------------------------------------------------------
// 1. explicit services  2. service ids literally mentioned in the story
// 3. services whose chunks match the story text
const mentioned = knownServices.filter((id) =>
  `${title} ${story}`.toLowerCase().includes(id.replace(/-service$/, ""))
);
const chunkHits = searchChunks(`${title} ${story}`, {}, 10);
const fromChunks = [...new Set(chunkHits.map((c) => c.service).filter(Boolean))];
const candidates = [...new Set([...explicitServices, ...mentioned, ...fromChunks])].sort();
if (!candidates.length) fail("no candidate services detected; pass --services explicitly");

// --- Impact expansion via graph edges ------------------------------------------------
const impacted = new Map(); // id -> { reasons: [] }
const addImpact = (id, reason) => {
  if (!impacted.has(id)) impacted.set(id, { reasons: [] });
  impacted.get(id).reasons.push(reason);
};
for (const id of candidates) addImpact(id, "story candidate");
for (const id of candidates) {
  for (const hit of getBlastRadius(id).impacted) {
    if (knownServices.includes(hit.service)) addImpact(hit.service, `${hit.via} of ${id}`);
  }
}
const impactedIds = [...impacted.keys()].sort();
const exports_ = new Map(impactedIds.map((id) => [id, getServiceExport(id)]));

// --- Merge order: callees before callers; note event contracts ------------------------
// Build CALLS edges among impacted services, topo-sort so a service merges
// after everything it depends on.
const callsWithin = [];
for (const id of impactedIds) {
  for (const dep of exports_.get(id).facts.dependencies) {
    if (impactedIds.includes(dep.target)) callsWithin.push([id, dep.target]); // id CALLS target
  }
}
const mergeOrder = [];
const remaining = new Set(impactedIds);
while (remaining.size) {
  const ready = [...remaining]
    .filter((id) => !callsWithin.some(([from, to]) => from === id && remaining.has(to)))
    .sort();
  if (!ready.length) {
    // dependency cycle: emit remaining alphabetically with a warning flag
    mergeOrder.push(...[...remaining].sort().map((id) => ({ id, cycle: true })));
    break;
  }
  for (const id of ready) {
    mergeOrder.push({ id, cycle: false });
    remaining.delete(id);
  }
}

// Shared event contracts among impacted services.
const eventContracts = [];
for (const id of impactedIds) {
  for (const ev of exports_.get(id).facts.events) {
    const others = impactedIds.filter(
      (o) => o !== id && exports_.get(o).facts.events.some((e) => e.topic === ev.topic && e.direction !== ev.direction)
    );
    for (const other of others) {
      const key = [ev.topic, ...[id, other].sort()].join("|");
      if (!eventContracts.some((c) => c.key === key)) {
        const publisher = ev.direction === "publishes" ? id : other;
        const consumer = ev.direction === "publishes" ? other : id;
        eventContracts.push({ key, topic: ev.topic, publisher, consumer });
      }
    }
  }
}
eventContracts.sort((a, b) => a.key.localeCompare(b.key));

// --- Write artifacts --------------------------------------------------------------------
mkdirSync(join(outDir, "context-packs"), { recursive: true });

writeFileSync(
  join(outDir, "story.yaml"),
  YAML.stringify({
    story: slug,
    title,
    description: story,
    bundleVersion: manifest.bundleVersion,
    candidateServices: candidates,
    impactedServices: impactedIds,
    status: "planned",
    approval: { required: true, approvedBy: null },
  })
);

const ia = [];
ia.push(`# Impact analysis: ${title}`);
ia.push("");
ia.push(`Story: ${story}`);
ia.push(`Bundle: \`${manifest.bundleVersion}\``);
ia.push("");
ia.push(`## Impacted services (${impactedIds.length})`);
ia.push("");
for (const id of impactedIds) {
  const exp = exports_.get(id);
  ia.push(`### ${id}`);
  ia.push("");
  ia.push(`- Why: ${[...new Set(impacted.get(id).reasons)].join("; ")}`);
  ia.push(`- Source: ${exp.source.repo} @ ${String(exp.source.commit).slice(0, 7)}`);
  ia.push(`- APIs: ${exp.facts.apis.map((a) => `\`${a.method} ${a.path}\``).join(", ") || "none"}`);
  ia.push(`- Events: ${exp.facts.events.map((e) => `${e.direction} \`${e.topic}\``).join(", ") || "none"}`);
  ia.push(`- Datastores: ${exp.facts.datastores.map((d) => d.name).join(", ") || "none"}`);
  if (exp.curated.knownFailureModes.length) {
    ia.push(`- Risk areas (known failure modes):`);
    for (const f of exp.curated.knownFailureModes) ia.push(`  - ${f}`);
  }
  ia.push("");
}
ia.push(`## Contract compatibility concerns`);
ia.push("");
if (eventContracts.length) {
  for (const c of eventContracts) ia.push(`- Event \`${c.topic}\`: ${c.publisher} publishes -> ${c.consumer} consumes. Schema changes must stay backward compatible or be versioned.`);
} else {
  ia.push("- No shared event contracts among impacted services detected.");
}
for (const [from, to] of callsWithin) ia.push(`- API contract: ${from} calls ${to}. Verify request/response compatibility.`);
ia.push("");
writeFileSync(join(outDir, "impact-analysis.md"), ia.join("\n"));

const tasks = impactedIds.map((id) => ({
  service: id,
  task: `Implement "${title}" changes scoped to ${id}`,
  branch: `story/${slug}/${id}`,
  contextPack: `context-packs/${id}.md`,
  status: "proposed",
  approved: false,
}));
writeFileSync(join(outDir, "service-tasks.yaml"), YAML.stringify({ story: slug, tasks }));

const ip = [];
ip.push(`# Implementation plan: ${title}`);
ip.push("");
ip.push(`Unit of work: one service, one bounded task, one branch, one PR, one context pack.`);
ip.push("");
ip.push(`## Human approval gate`);
ip.push("");
ip.push(`- [ ] Impact analysis reviewed`);
ip.push(`- [ ] Service tasks approved (set \`approved: true\` in service-tasks.yaml)`);
ip.push("");
ip.push(`## Per-service tasks`);
ip.push("");
for (const t of tasks) ip.push(`- **${t.service}** — branch \`${t.branch}\`, context pack \`${t.contextPack}\``);
ip.push("");
ip.push(`## Merge order guidance`);
ip.push("");
ip.push(`Callees merge before callers; event consumers deploy before publishers emit new fields.`);
ip.push("");
mergeOrder.forEach((m, i) => ip.push(`${i + 1}. ${m.id}${m.cycle ? " (dependency cycle detected — review manually)" : ""}`));
ip.push("");
ip.push(`## Test requirements`);
ip.push("");
for (const c of eventContracts) ip.push(`- Contract test for event \`${c.topic}\` between ${c.publisher} and ${c.consumer}`);
for (const [from, to] of callsWithin) ip.push(`- Integration test for ${from} -> ${to} call path`);
ip.push(`- Per-service unit tests scoped to each task`);
ip.push("");
ip.push(`## Rollback considerations`);
ip.push("");
ip.push(`- Gate new behavior behind a feature flag where user-visible`);
ip.push(`- Merge order above supports reverting callers without breaking callees`);
ip.push("");
writeFileSync(join(outDir, "implementation-plan.md"), ip.join("\n"));

for (const id of impactedIds) {
  writeFileSync(join(outDir, "context-packs", `${id}.md`), buildContextPack(id, `${title}: ${story}`));
}

console.log(`story: ${slug}`);
console.log(`candidates: ${candidates.join(", ")}`);
console.log(`impacted: ${impactedIds.join(", ")}`);
console.log(`merge order: ${mergeOrder.map((m) => m.id).join(" -> ")}`);
console.log(`wrote ${outDir}/story.yaml`);
console.log(`wrote ${outDir}/impact-analysis.md`);
console.log(`wrote ${outDir}/implementation-plan.md`);
console.log(`wrote ${outDir}/service-tasks.yaml`);
console.log(`wrote ${outDir}/context-packs/ (${impactedIds.length} pack(s))`);
console.log(`\nnext: review impact-analysis.md, then approve tasks in service-tasks.yaml`);
