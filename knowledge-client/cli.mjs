#!/usr/bin/env node
// CLI over the knowledge client.
// Usage: npm run knowledge -- <command> [args]

import {
  buildContextPack,
  getApis,
  getBlastRadius,
  getDatastores,
  getDependencies,
  getEvents,
  getManifest,
  getReverseDependencies,
  getServiceCard,
  getServiceExport,
  searchChunks,
} from "./client.mjs";

const USAGE = `usage: npm run knowledge -- <command> [args]

commands:
  manifest                      bundle version and indexed services
  get-service <id>              merged export summary
  card <id>                     service card markdown
  deps <id>                     outgoing + reverse dependencies
  apis <id>                     REST APIs
  events <id>                   published/consumed events
  datastores <id>               datastores
  impact <id>                   blast radius
  search <query>                top matching chunks
  context-pack --service <id> --task "<task>"   compact context pack`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const arg = rest[0];

try {
  switch (command) {
    case "manifest": {
      const m = getManifest();
      console.log(`bundleVersion: ${m.bundleVersion}`);
      for (const s of m.services) console.log(`  ${s.service}  ${s.sourceRepo} @ ${String(s.sourceCommit).slice(0, 7)}`);
      break;
    }
    case "get-service": {
      if (!arg) fail("usage: get-service <id>");
      const svc = getServiceExport(arg);
      console.log(`${svc.displayName} (${svc.service})`);
      console.log(`  domain=${svc.domain} lifecycle=${svc.lifecycle} owners=${svc.owners.join(",")}`);
      console.log(`  source: ${svc.source.repo} @ ${String(svc.source.commit).slice(0, 7)}`);
      console.log(`  apis=${svc.facts.apis.length} deps=${svc.facts.dependencies.length} events=${svc.facts.events.length} datastores=${svc.facts.datastores.length}`);
      break;
    }
    case "card": {
      if (!arg) fail("usage: card <id>");
      process.stdout.write(getServiceCard(arg));
      break;
    }
    case "deps": {
      if (!arg) fail("usage: deps <id>");
      console.log("outgoing:");
      const out = getDependencies(arg);
      if (out.length) for (const d of out) console.log(`  -> ${d.target} (${d.via})${d.external ? " [external]" : ""}`);
      else console.log("  none");
      console.log("reverse:");
      const rev = getReverseDependencies(arg);
      if (rev.length) for (const d of rev) console.log(`  <- ${d.caller} (${d.via})`);
      else console.log("  none");
      break;
    }
    case "apis": {
      if (!arg) fail("usage: apis <id>");
      for (const a of getApis(arg)) console.log(`${a.method.padEnd(6)} ${a.path}`);
      break;
    }
    case "events": {
      if (!arg) fail("usage: events <id>");
      for (const e of getEvents(arg)) console.log(`${e.direction.padEnd(9)} ${e.topic}`);
      break;
    }
    case "datastores": {
      if (!arg) fail("usage: datastores <id>");
      for (const d of getDatastores(arg)) console.log(`${d.name}${d.table ? ` (table: ${d.table})` : ""}`);
      break;
    }
    case "impact": {
      if (!arg) fail("usage: impact <id>");
      const r = getBlastRadius(arg);
      console.log(`blast radius of ${r.service} (${r.impacted.length} impacted):`);
      for (const i of r.impacted) console.log(`  ${i.service} — ${i.via}`);
      if (!r.impacted.length) console.log("  none");
      break;
    }
    case "search": {
      if (!arg) fail("usage: search <query>");
      const hits = searchChunks(rest.join(" "));
      if (!hits.length) console.log("no matching chunks");
      for (const h of hits) console.log(`${String(h.score).padStart(3)}  ${h.id}  (${h.path})`);
      break;
    }
    case "context-pack": {
      const serviceIdx = rest.indexOf("--service");
      const taskIdx = rest.indexOf("--task");
      const service = serviceIdx !== -1 ? rest[serviceIdx + 1] : null;
      const task = taskIdx !== -1 ? rest.slice(taskIdx + 1).filter((a) => a !== "--service" && a !== service).join(" ") : null;
      if (!service || !task) fail('usage: context-pack --service <id> --task "<task>"');
      process.stdout.write(buildContextPack(service, task));
      break;
    }
    default:
      console.error(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  fail(e.message);
}
