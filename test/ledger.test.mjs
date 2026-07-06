import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLedger, readLedger, traceDecision, verifyLedger, GENESIS_HASH, canonicalJson } from "../orchestrator/ledger.mjs";

const tmpLedger = () => join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test("append builds a verifiable hash chain from genesis", () => {
  const path = tmpLedger();
  const ledger = openLedger(path);
  const e1 = ledger.append({ run: "r1", actor: "orchestrator", action: "run-started" });
  const e2 = ledger.append({ run: "r1", actor: "agent:implementer", action: "task-completed", confidence: 0.9, causes: [e1.hash] });

  assert.equal(e1.prevHash, GENESIS_HASH);
  assert.equal(e2.prevHash, e1.hash);
  assert.equal(e2.seq, 1);

  const { ok, entries, problems } = verifyLedger(path);
  assert.equal(ok, true, JSON.stringify(problems));
  assert.equal(entries.length, 2);
});

test("re-opening a ledger continues the same chain", () => {
  const path = tmpLedger();
  openLedger(path).append({ actor: "orchestrator", action: "a" });
  openLedger(path).append({ actor: "orchestrator", action: "b" });
  const { ok, entries } = verifyLedger(path);
  assert.equal(ok, true);
  assert.equal(entries[1].prevHash, entries[0].hash);
});

test("tampering with a recorded entry is detected", () => {
  const path = tmpLedger();
  const ledger = openLedger(path);
  ledger.append({ actor: "orchestrator", action: "budget-reserved", data: { ceilingUsd: 0.5 } });
  ledger.append({ actor: "orchestrator", action: "budget-settled", data: { actualUsd: 0.1 } });

  const lines = readFileSync(path, "utf8").trim().split("\n");
  const doctored = JSON.parse(lines[0]);
  doctored.data.ceilingUsd = 99; // rewrite history
  writeFileSync(path, [JSON.stringify(doctored), lines[1]].join("\n") + "\n");

  const { ok, problems } = verifyLedger(path);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.seq === 0 && /hash mismatch/.test(p.reason)));
});

test("deleting an entry breaks the chain", () => {
  const path = tmpLedger();
  const ledger = openLedger(path);
  ledger.append({ actor: "orchestrator", action: "a" });
  ledger.append({ actor: "orchestrator", action: "b" });
  ledger.append({ actor: "orchestrator", action: "c" });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  writeFileSync(path, [lines[0], lines[2]].join("\n") + "\n"); // drop the middle entry
  const { ok, problems } = verifyLedger(path);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /prevHash mismatch/.test(p.reason)));
});

test("traceDecision reconstructs the causal chain oldest-first", () => {
  const path = tmpLedger();
  const ledger = openLedger(path);
  const start = ledger.append({ actor: "orchestrator", action: "run-started" });
  const dispatch = ledger.append({ actor: "orchestrator", action: "task-dispatched", causes: [start.hash] });
  ledger.append({ actor: "orchestrator", action: "unrelated" });
  const done = ledger.append({ actor: "agent:implementer", action: "task-completed", causes: [dispatch.hash] });
  const override = ledger.append({ actor: "human:reviewer", action: "human-override", causes: [done.hash] });

  const chain = traceDecision(path, override.hash);
  assert.deepEqual(chain.map((e) => e.action), ["run-started", "task-dispatched", "task-completed", "human-override"]);
  assert.equal(readLedger(path).length, 5);
});
