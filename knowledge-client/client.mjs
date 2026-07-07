// Knowledge client: stable read-only interface over the wiki knowledge bundle.
// The wiki checkout location comes from KNOWLEDGE_WIKI_PATH, then
// agent-hub.config.yaml (knowledgeWikiPath), then ../knowledge-network.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { knowledgeWikiPath } from "../lib/project-config.mjs";

export function wikiPath() {
  const p = knowledgeWikiPath();
  if (!existsSync(join(p, "knowledge", "bundle", "manifest.json"))) {
    throw new Error(
      `knowledge bundle not found under ${p} (set knowledgeWikiPath in agent-hub.config.yaml or the KNOWLEDGE_WIKI_PATH env var)`
    );
  }
  return p;
}

function readJsonl(relPath) {
  return readFileSync(join(wikiPath(), relPath), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function getManifest() {
  return JSON.parse(readFileSync(join(wikiPath(), "knowledge/bundle/manifest.json"), "utf8"));
}

export function getServiceExport(serviceId) {
  const p = join(wikiPath(), "knowledge/export/services", serviceId, "service.export.yaml");
  if (!existsSync(p)) throw new Error(`unknown service: ${serviceId}`);
  return YAML.parse(readFileSync(p, "utf8"));
}

export function getServiceCard(serviceId) {
  const p = join(wikiPath(), "knowledge/export/services", serviceId, "service-card.md");
  if (!existsSync(p)) throw new Error(`unknown service: ${serviceId}`);
  return readFileSync(p, "utf8").replaceAll("\r\n", "\n");
}

export function getEntities() {
  return readJsonl("knowledge/graph/entities.jsonl");
}

export function getEdges() {
  return readJsonl("knowledge/graph/edges.jsonl");
}

export function getDependencies(serviceId) {
  return getEdges()
    .filter((e) => e.from === `service:${serviceId}` && e.type === "CALLS")
    .map((e) => ({ target: e.to.replace(/^(service|external):/, ""), via: e.via ?? null, external: e.to.startsWith("external:") }));
}

export function getReverseDependencies(serviceId) {
  return getEdges()
    .filter((e) => e.to === `service:${serviceId}` && e.type === "CALLS")
    .map((e) => ({ caller: e.from.replace("service:", ""), via: e.via ?? null }));
}

export function getApis(serviceId) {
  return getServiceExport(serviceId).facts.apis;
}

export function getEvents(serviceId) {
  return getServiceExport(serviceId).facts.events;
}

export function getDatastores(serviceId) {
  return getServiceExport(serviceId).facts.datastores;
}

// Keyword search over chunks. filters: { service, type }
export function searchChunks(query, filters = {}, limit = 5) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const chunks = readJsonl("knowledge/bundle/chunks.jsonl").filter(
    (c) => (!filters.service || c.service === filters.service) && (!filters.type || c.type === filters.type)
  );
  const scored = chunks
    .map((c) => {
      const text = `${c.id} ${c.text}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let i = -1;
        while ((i = text.indexOf(t, i + 1)) !== -1) score++;
      }
      return { chunk: c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  return scored.slice(0, limit).map((s) => ({ ...s.chunk, score: s.score }));
}

// Blast radius: transitive reverse callers + consumers of published events.
export function getBlastRadius(serviceId) {
  const edges = getEdges();
  const sid = `service:${serviceId}`;

  const callers = new Map();
  let frontier = [sid];
  let depth = 0;
  while (frontier.length) {
    depth++;
    const next = [];
    for (const target of frontier) {
      for (const e of edges) {
        if (e.type === "CALLS" && e.to === target && !callers.has(e.from) && e.from !== sid) {
          callers.set(e.from, depth);
          next.push(e.from);
        }
      }
    }
    frontier = next;
  }

  const published = edges.filter((e) => e.from === sid && e.type === "PUBLISHES_EVENT").map((e) => e.to);
  const eventConsumers = new Set(
    edges
      .filter((e) => e.type === "CONSUMES_EVENT" && published.includes(e.to) && e.from !== sid)
      .map((e) => e.from)
  );

  const impacted = new Set([...callers.keys(), ...eventConsumers]);
  return {
    service: serviceId,
    impacted: [...impacted].sort().map((id) => ({
      service: id.replace(/^(service|external):/, ""),
      via: callers.has(id) ? `calls (depth ${callers.get(id)})` : "consumes published event",
    })),
  };
}

// Compact context pack. Budget: 1 service card, max 10 edges, max 5 chunks.
export function buildContextPack(serviceId, task, { maxEdges = 10, maxChunks = 5 } = {}) {
  const manifest = getManifest();
  const exp = getServiceExport(serviceId);
  const card = getServiceCard(serviceId);
  const sid = `service:${serviceId}`;

  const edges = getEdges()
    .filter(
      (e) =>
        (e.from === sid || e.to === sid) &&
        ["CALLS", "PUBLISHES_EVENT", "CONSUMES_EVENT"].includes(e.type)
    )
    .slice(0, maxEdges);

  // Exclude this service's own card chunks: the full card is already included.
  const chunks = searchChunks(task, {}, maxChunks * 2)
    .filter((c) => !(c.type === "service-card" && c.service === serviceId))
    .slice(0, maxChunks);

  const short = (id) => id.replace(/^(service|external|event):/, "");
  const lines = [];
  lines.push(`# Context Pack: ${serviceId}`);
  lines.push("");
  lines.push(`Task: ${task}`);
  lines.push(`Bundle: ${manifest.bundleVersion} | Source: ${exp.source.repo} @ ${String(exp.source.commit).slice(0, 7)} (${exp.source.branch})`);
  lines.push("");
  lines.push("## Service Card");
  lines.push("");
  lines.push(card.trim());
  lines.push("");
  lines.push(`## Graph Edges (${edges.length}, max ${maxEdges})`);
  lines.push("");
  for (const e of edges) {
    lines.push(e.from === sid ? `- ${e.type} -> ${short(e.to)}${e.via ? ` (${e.via})` : ""}` : `- ${short(e.from)} ${e.type} -> this service${e.via ? ` (${e.via})` : ""}`);
  }
  lines.push("");
  lines.push(`## Relevant Chunks (${chunks.length}, max ${maxChunks})`);
  lines.push("");
  if (chunks.length) {
    for (const c of chunks) {
      lines.push(`### ${c.id}`);
      lines.push(`_source: ${c.path}${c.sourceCommit ? ` @ ${String(c.sourceCommit).slice(0, 7)}` : ""}_`);
      lines.push("");
      lines.push(c.text.trim());
      lines.push("");
    }
  } else {
    lines.push("_No chunks matched the task description._");
    lines.push("");
  }
  lines.push("## Provenance");
  lines.push("");
  lines.push(`- Bundle version: ${manifest.bundleVersion}`);
  lines.push(`- Bundle hash: ${manifest.bundleHash}`);
  lines.push(`- Scanner version: ${exp.scannerVersion}`);
  lines.push(`- Facts trace to: knowledge/export/services/${serviceId}/source-map.json`);
  lines.push("");
  return lines.join("\n");
}
