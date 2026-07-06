// Decision ledger: append-only, hash-chained JSONL audit trail.
//
// Every orchestration action (dispatch, budget movement, model observation,
// handoff, human override) is a ledger entry stamped with:
//   - actor       who did it ("orchestrator", "agent:<id>", "human:<name>")
//   - action      what happened (machine-readable slug)
//   - evidence    what it was based on (file paths, bundle version, prompt hash)
//   - confidence  0..1 where the actor reports one, else null
//   - causes      hashes of prior entries this decision depended on
//
// Entries are chained: entry.hash = sha256(canonical(entry-without-hash)) and
// entry.prevHash = previous entry's hash, so any edit or deletion after the
// fact is detectable with verifyLedger(). This is a control, not a log:
// "agents wrote this" becomes "agents wrote this, and here is the chain".

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export const GENESIS_HASH = "0".repeat(64);

// Deterministic JSON: object keys sorted so the hash never depends on
// insertion order.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// Open (or create) a ledger for appending. Reads the existing chain once and
// keeps the tail in memory; each append is a synchronous write so a crash
// never loses an acknowledged entry.
export function openLedger(path) {
  const existing = readLedger(path);
  let seq = existing.length;
  let prevHash = existing.length ? existing[existing.length - 1].hash : GENESIS_HASH;

  return {
    path,
    append({ run = null, actor, action, data = {}, evidence = [], confidence = null, causes = [] }) {
      if (!actor || !action) throw new Error("ledger entries require actor and action");
      const entry = {
        seq,
        ts: new Date().toISOString(),
        run,
        actor,
        action,
        data,
        evidence,
        confidence,
        causes,
        prevHash,
      };
      const hash = sha256(canonicalJson(entry));
      const full = { ...entry, hash };
      appendFileSync(path, JSON.stringify(full) + "\n");
      prevHash = hash;
      seq += 1;
      return full;
    },
  };
}

// Recompute the whole chain. Returns { ok, entries, problems: [{seq, reason}] }.
export function verifyLedger(path) {
  const entries = readLedger(path);
  const problems = [];
  let prevHash = GENESIS_HASH;
  for (const entry of entries) {
    const { hash, ...rest } = entry;
    if (entry.prevHash !== prevHash) {
      problems.push({ seq: entry.seq, reason: `prevHash mismatch (chain broken before seq ${entry.seq})` });
    }
    const expected = sha256(canonicalJson(rest));
    if (hash !== expected) {
      problems.push({ seq: entry.seq, reason: "hash mismatch (entry modified after write)" });
    }
    prevHash = hash;
  }
  return { ok: problems.length === 0, entries, problems };
}

// Walk the causes graph backwards from one entry to reconstruct why the
// system decided what it decided. Returns entries in causal order (oldest
// first), deduplicated.
export function traceDecision(path, entryHash) {
  const entries = readLedger(path);
  const byHash = new Map(entries.map((e) => [e.hash, e]));
  const start = byHash.get(entryHash);
  if (!start) throw new Error(`no ledger entry with hash ${entryHash}`);

  const chain = new Map(); // hash -> entry
  const frontier = [start];
  while (frontier.length) {
    const e = frontier.pop();
    if (chain.has(e.hash)) continue;
    chain.set(e.hash, e);
    for (const c of e.causes ?? []) {
      const parent = byHash.get(c);
      if (parent) frontier.push(parent);
    }
  }
  return [...chain.values()].sort((a, b) => a.seq - b.seq);
}
