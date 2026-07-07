import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const auditPath = path.join(repoRoot, ".audit", "audit.jsonl");

function readAuditEvents() {
  if (!fs.existsSync(auditPath)) {
    return [];
  }

  return fs
    .readFileSync(auditPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        return {
          timestamp: null,
          requestId: "unknown",
          eventType: "invalid_json",
          status: "failed",
          metadata: {
            line: index + 1
          }
        };
      }
    });
}

function sum(events, field) {
  return events.reduce((total, event) => {
    const value = event[field];
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function count(events, predicate) {
  return events.filter(predicate).length;
}

function topBy(events, keyField, valueField) {
  const totals = new Map();

  for (const event of events) {
    const key = event[keyField];

    if (!key) {
      continue;
    }

    const value = Number.isFinite(event[valueField]) ? event[valueField] : 0;
    totals.set(key, (totals.get(key) ?? 0) + value);
  }

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0] ?? ["none", 0];
}

function formatMoney(value) {
  return `$${value.toFixed(6)}`;
}

const events = readAuditEvents();

if (events.length === 0) {
  console.log("No audit log found yet.");
  console.log(`Expected path: ${auditPath}`);
  process.exit(0);
}

const totalInputTokens = sum(events, "inputTokens");
const totalOutputTokens = sum(events, "outputTokens");
const totalTokens = sum(events, "totalTokens");
const totalRetrievedTokens = sum(events, "tokensReturned");
const estimatedCostUsd = sum(events, "estimatedCostUsd");

const [mostExpensiveRequest, mostExpensiveRequestTokens] = topBy(
  events,
  "requestId",
  "totalTokens"
);

const [mostExpensiveAgent, mostExpensiveAgentTokens] = topBy(
  events,
  "agent",
  "totalTokens"
);

const [mostExpensiveModel, mostExpensiveModelTokens] = topBy(
  events,
  "model",
  "totalTokens"
);

console.log("Audit Summary");
console.log("");
console.log(`Events: ${events.length}`);
console.log(
  `Requests started: ${count(events, event => event.eventType === "request_started")}`
);
console.log(
  `Requests completed: ${count(events, event => event.eventType === "request_completed")}`
);
console.log(
  `Requests failed: ${count(events, event => event.eventType === "request_failed")}`
);
console.log(
  `LLM calls: ${count(events, event => event.eventType === "llm_call")}`
);
console.log(
  `Tool calls: ${count(events, event => event.eventType === "tool_call")}`
);
console.log(
  `Artifacts created: ${count(events, event => event.eventType === "artifact_created")}`
);
console.log(`Total input tokens: ${totalInputTokens}`);
console.log(`Total output tokens: ${totalOutputTokens}`);
console.log(`Total tokens: ${totalTokens}`);
console.log(`Total retrieved/tool tokens: ${totalRetrievedTokens}`);
console.log(`Estimated cost: ${formatMoney(estimatedCostUsd)}`);
console.log(
  `Most expensive request: ${mostExpensiveRequest} (${mostExpensiveRequestTokens} tokens)`
);
console.log(
  `Most expensive agent: ${mostExpensiveAgent} (${mostExpensiveAgentTokens} tokens)`
);
console.log(
  `Most expensive model: ${mostExpensiveModel} (${mostExpensiveModelTokens} tokens)`
);
