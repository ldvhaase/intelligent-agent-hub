import assert from "node:assert/strict";
import test from "node:test";
import { compactHandoff, extractFilePaths, extractSymbols } from "../orchestrator/handoff.mjs";

const longProse = Array.from({ length: 60 }, (_, i) =>
  `Paragraph ${i} opens with its key point. It then rambles on with supporting detail that a downstream agent does not need to re-read, repeating context about the change and restating assumptions at length so the transcript grows well beyond any useful size.`
).join("\n\n");

const sampleOutput = [
  "I implemented the surge pricing change.",
  "",
  "Modified src/estimator/fare-calculator.mjs and added tests in test/contracts/fare-estimate.test.mjs.",
  "The entry point is `applySurgeMultiplier` and the config knob is `SURGE_CAP`.",
  "",
  "Decision: we decided to keep fare.estimated.v1 backward compatible instead of versioning the topic, because rider-service consumes it in production.",
  "",
  "Contract: POST /v1/fare-estimates now returns surgeMultiplier as an optional field.",
  "",
  "TODO: confirm the surge cap default with the pricing team (open question).",
  "",
  longProse,
].join("\n");

test("file paths and symbols are preserved verbatim", () => {
  assert.ok(extractFilePaths(sampleOutput).includes("src/estimator/fare-calculator.mjs"));
  assert.ok(extractFilePaths(sampleOutput).includes("test/contracts/fare-estimate.test.mjs"));
  assert.ok(extractSymbols(sampleOutput).includes("applySurgeMultiplier"));
  assert.ok(extractSymbols(sampleOutput).includes("SURGE_CAP"));
});

test("compactHandoff keeps decisions, contracts, and open questions verbatim", () => {
  const { markdown } = compactHandoff({ service: "pricing-service", output: sampleOutput });
  assert.match(markdown, /we decided to keep fare\.estimated\.v1 backward compatible/);
  assert.match(markdown, /POST \/v1\/fare-estimates now returns surgeMultiplier/);
  assert.match(markdown, /confirm the surge cap default/);
  assert.match(markdown, /`src\/estimator\/fare-calculator\.mjs`/);
});

test("compactHandoff compresses long prose substantially", () => {
  const { markdown, stats } = compactHandoff({ service: "pricing-service", output: sampleOutput, maxChars: 4000 });
  assert.ok(stats.compactedChars < stats.originalChars * 0.6, `expected <60% of ${stats.originalChars}, got ${stats.compactedChars}`);
  assert.ok(stats.ratio < 0.6);
  assert.match(markdown, /compacted \d+ -> \d+ chars/);
});

test("compactHandoff is deterministic", () => {
  const a = compactHandoff({ service: "s", output: sampleOutput });
  const b = compactHandoff({ service: "s", output: sampleOutput });
  assert.equal(a.markdown, b.markdown);
});

test("empty-ish output produces a well-formed handoff", () => {
  const { markdown, stats } = compactHandoff({ service: "s", output: "ok" });
  assert.match(markdown, /_none_/);
  assert.equal(stats.filePaths, 0);
});
