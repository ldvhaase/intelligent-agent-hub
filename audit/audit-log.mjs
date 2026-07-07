import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {"request_started" | "tool_call" | "llm_call" | "artifact_created" | "request_completed" | "request_failed"} AuditEventType
 */

/**
 * @typedef {"started" | "success" | "failed" | "completed"} AuditStatus
 */

/**
 * @typedef {Object} AuditEvent
 * @property {string=} timestamp
 * @property {string} requestId
 * @property {AuditEventType} eventType
 * @property {AuditStatus} status
 * @property {string=} runId
 * @property {string=} requestType
 * @property {string=} agent
 * @property {string=} phase
 * @property {string=} model
 * @property {string=} tool
 * @property {number=} inputTokens
 * @property {number=} outputTokens
 * @property {number=} totalTokens
 * @property {number=} cachedInputTokens
 * @property {number=} reasoningTokens
 * @property {number=} tokensReturned
 * @property {number=} estimatedCostUsd
 * @property {number=} creditsUsed
 * @property {number=} resultCount
 * @property {Record<string, unknown>=} metadata
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const auditDir = path.join(repoRoot, ".audit");
const auditPath = path.join(auditDir, "audit.jsonl");
const costCatalogPath = path.join(__dirname, "cost-catalog.json");

function readCostCatalog() {
  try {
    return JSON.parse(fs.readFileSync(costCatalogPath, "utf8"));
  } catch {
    return {
      version: "unknown",
      models: {
        default: {
          inputPer1MTokensUsd: 0,
          cachedInputPer1MTokensUsd: 0,
          outputPer1MTokensUsd: 0,
          reasoningPer1MTokensUsd: 0
        }
      }
    };
  }
}

function normalizeNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * @param {Partial<AuditEvent>} event
 * @returns {number}
 */
export function calculateTotalTokens(event = {}) {
  const explicitTotal = normalizeNumber(event.totalTokens);

  if (explicitTotal > 0) {
    return explicitTotal;
  }

  return (
    normalizeNumber(event.inputTokens) +
    normalizeNumber(event.outputTokens) +
    normalizeNumber(event.cachedInputTokens) +
    normalizeNumber(event.reasoningTokens)
  );
}

/**
 * @param {string} prefix
 * @returns {string}
 */
export function createRequestId(prefix = "req") {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);

  const random = crypto.randomBytes(4).toString("hex");

  return `${prefix}_${timestamp}_${random}`;
}

/**
 * @param {Object} args
 * @param {string=} args.model
 * @param {number=} args.inputTokens
 * @param {number=} args.outputTokens
 * @param {number=} args.cachedInputTokens
 * @param {number=} args.reasoningTokens
 * @returns {number}
 */
export function estimateCostUsd(args = {}) {
  const catalog = readCostCatalog();
  const modelName = args.model ?? "default";
  const modelPricing = catalog.models?.[modelName] ?? catalog.models?.default;

  if (!modelPricing) {
    return 0;
  }

  const inputCost =
    (normalizeNumber(args.inputTokens) / 1_000_000) *
    normalizeNumber(modelPricing.inputPer1MTokensUsd);

  const cachedInputCost =
    (normalizeNumber(args.cachedInputTokens) / 1_000_000) *
    normalizeNumber(modelPricing.cachedInputPer1MTokensUsd);

  const outputCost =
    (normalizeNumber(args.outputTokens) / 1_000_000) *
    normalizeNumber(modelPricing.outputPer1MTokensUsd);

  const reasoningCost =
    (normalizeNumber(args.reasoningTokens) / 1_000_000) *
    normalizeNumber(modelPricing.reasoningPer1MTokensUsd);

  return Number(
    (inputCost + cachedInputCost + outputCost + reasoningCost).toFixed(8)
  );
}

/**
 * @param {AuditEvent} event
 */
export function audit(event) {
  try {
    if (!event?.requestId) {
      throw new Error("Audit event is missing required field: requestId");
    }

    if (!event?.eventType) {
      throw new Error("Audit event is missing required field: eventType");
    }

    if (!event?.status) {
      throw new Error("Audit event is missing required field: status");
    }

    fs.mkdirSync(auditDir, { recursive: true });

    const record = {
      timestamp: new Date().toISOString(),
      ...event
    };

    if (!record.totalTokens) {
      record.totalTokens = calculateTotalTokens(record);
    }

    fs.appendFileSync(auditPath, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    if (process.env.AUDIT_STRICT === "true") {
      throw error;
    }

    console.warn(
      `[audit] Failed to write audit event: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
