#!/usr/bin/env node
// CLI over the decision ledger.
// Usage: npm run ledger -- <command> --story <slug> [args]
//
// commands:
//   verify   --story <slug>                       recompute the hash chain
//   show     --story <slug> [--run id] [--action a]   list entries
//   trace    --story <slug> --entry <hash>        causal chain for one decision
//   override --story <slug> --entry <hash> --by <name> --reason "..."
//            record a human override of a prior decision (appends; nothing
//            is ever rewritten — the override is itself a chained entry)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_HUB_ROOT } from "./config.mjs";
import { openLedger, readLedger, traceDecision, verifyLedger } from "./ledger.mjs";

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0];
function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const vals = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) vals.push(args[j]);
  return vals.join(" ") || null;
}

const USAGE = `usage: npm run ledger -- <verify|show|trace|override> --story <slug> [args]`;
const storyArg = flag("story");
if (!command || !storyArg) fail(USAGE);
const storyDir = existsSync(join(storyArg, "ledger.jsonl")) ? storyArg : join(AGENT_HUB_ROOT, "stories", storyArg);
const ledgerPath = join(storyDir, "ledger.jsonl");
if (!existsSync(ledgerPath)) fail(`no ledger at ${ledgerPath}`);

const short = (h) => (h ? h.slice(0, 12) : "—");
const printEntry = (e) => {
  console.log(`#${e.seq} ${short(e.hash)} ${e.ts} [${e.run ?? "-"}] ${e.actor} ${e.action}${e.confidence !== null ? ` (confidence ${e.confidence})` : ""}`);
  if (Object.keys(e.data ?? {}).length) console.log(`    data: ${JSON.stringify(e.data)}`);
  if (e.evidence?.length) console.log(`    evidence: ${e.evidence.join(" | ")}`);
  if (e.causes?.length) console.log(`    causes: ${e.causes.map(short).join(", ")}`);
};

switch (command) {
  case "verify": {
    const { ok, entries, problems } = verifyLedger(ledgerPath);
    if (ok) {
      console.log(`ok: ${entries.length} entries, hash chain intact`);
    } else {
      for (const p of problems) console.error(`TAMPER: seq ${p.seq}: ${p.reason}`);
      fail(`ledger verification FAILED (${problems.length} problem(s))`);
    }
    break;
  }
  case "show": {
    const run = flag("run");
    const action = flag("action");
    const entries = readLedger(ledgerPath).filter(
      (e) => (!run || e.run === run) && (!action || e.action === action)
    );
    if (!entries.length) console.log("no matching entries");
    for (const e of entries) printEntry(e);
    break;
  }
  case "trace": {
    const entryHash = flag("entry");
    if (!entryHash) fail("usage: trace --story <slug> --entry <full-hash>");
    const chain = traceDecision(ledgerPath, entryHash);
    console.log(`causal chain (${chain.length} entries, oldest first):`);
    for (const e of chain) printEntry(e);
    break;
  }
  case "override": {
    const entryHash = flag("entry");
    const by = flag("by");
    const reason = flag("reason");
    if (!entryHash || !by || !reason) fail('usage: override --story <slug> --entry <full-hash> --by <name> --reason "..."');
    const entries = readLedger(ledgerPath);
    const target = entries.find((e) => e.hash === entryHash);
    if (!target) fail(`no ledger entry with hash ${entryHash}`);
    const ledger = openLedger(ledgerPath);
    const entry = ledger.append({
      run: target.run,
      actor: `human:${by}`,
      action: "human-override",
      data: { overrides: { seq: target.seq, action: target.action }, reason },
      causes: [entryHash],
    });
    console.log(`recorded override #${entry.seq} ${short(entry.hash)} of #${target.seq} (${target.action}) by ${by}`);
    break;
  }
  default:
    fail(USAGE);
}
