// Handoff compaction: structured summaries between agent stages.
//
// Passing a full upstream transcript into the next agent is wasteful and
// widens the hallucination surface. This module compresses a completed
// task's output into a handoff that preserves VERBATIM the things a
// downstream agent must not receive paraphrased:
//   - file paths                - decision lines (decided/chose/because...)
//   - code symbols (`ticked`)   - contract lines (HTTP routes, events/topics)
//   - open questions / TODOs
// and compresses everything else extractively (first sentence per paragraph,
// under a character budget). Fully deterministic — no LLM in the loop.

const dedupe = (arr) => [...new Set(arr)];

const FILE_PATH_RE =
  /(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z]{1,6}\b|\b[\w-]+\.(?:mjs|cjs|jsx?|tsx?|py|java|go|rb|rs|cs|php|sql|sh|ps1|ya?ml|json|md|toml|tf|proto)\b/g;

const DECISION_RE = /\b(decision|decided|chose|chosen|selected|opted|going with|will use|instead of|trade-?off|because)\b/i;
const CONTRACT_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+\/|\b(event|topic|schema|contract|publishes|consumes)\b/i;
const OPEN_RE = /\b(TODO|FIXME|open question|unresolved|blocked|needs (?:a )?decision|follow-?up required)\b/i;

export function extractFilePaths(text, limit = 40) {
  return dedupe(text.match(FILE_PATH_RE) ?? []).slice(0, limit);
}

export function extractSymbols(text, limit = 40) {
  const ticked = [...text.matchAll(/`([^`\n]{1,80})`/g)].map((m) => m[1].trim());
  const declared = [...text.matchAll(/\b(?:function|def|class|interface|const|type)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  return dedupe([...ticked, ...declared]).slice(0, limit);
}

function matchingLines(text, re, limit) {
  return dedupe(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && re.test(l))
  ).slice(0, limit);
}

// Extractive prose compression: first sentence of each paragraph until the
// budget runs out. Skips paragraphs that are already captured verbatim
// elsewhere (pure path/decision lines).
function compressProse(text, budgetChars) {
  const out = [];
  let used = 0;
  for (const para of text.split(/\n\s*\n/)) {
    const flat = para.replace(/\s+/g, " ").trim();
    if (!flat || flat.startsWith("#")) continue;
    const sentence = (flat.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? flat).trim();
    if (used + sentence.length > budgetChars) break;
    out.push(sentence);
    used += sentence.length;
  }
  return out;
}

// Build the handoff for one completed task. Returns { markdown, stats }.
export function compactHandoff({ service, agent = null, task = null, output, maxChars = 4000 }) {
  const filePaths = extractFilePaths(output);
  const symbols = extractSymbols(output);
  const decisions = matchingLines(output, DECISION_RE, 20);
  const contracts = matchingLines(output, CONTRACT_RE, 20);
  const openQuestions = matchingLines(output, OPEN_RE, 20);

  // Whatever budget is left after the verbatim sections goes to the summary.
  const verbatimChars =
    [...filePaths, ...symbols, ...decisions, ...contracts, ...openQuestions].join("\n").length;
  const summary = compressProse(output, Math.max(600, maxChars - verbatimChars - 600));

  const lines = [];
  lines.push(`# Handoff: ${service}`);
  lines.push("");
  if (agent) lines.push(`- Agent: ${agent}`);
  if (task) lines.push(`- Task: ${task}`);
  lines.push("");
  const section = (title, items, tick = false) => {
    lines.push(`## ${title} (${items.length})`);
    lines.push("");
    if (items.length) for (const i of items) lines.push(`- ${tick ? `\`${i}\`` : i}`);
    else lines.push("_none_");
    lines.push("");
  };
  section("Files touched (verbatim)", filePaths, true);
  section("Symbols (verbatim)", symbols, true);
  section("Decision points (verbatim)", decisions);
  section("Contract notes (verbatim)", contracts);
  section("Open questions (verbatim)", openQuestions);
  lines.push("## Summary (compressed)");
  lines.push("");
  if (summary.length) for (const s of summary) lines.push(`- ${s}`);
  else lines.push("_no prose to summarize_");
  lines.push("");

  const markdown = lines.join("\n");
  const stats = {
    originalChars: output.length,
    compactedChars: markdown.length,
    ratio: output.length ? Math.round((markdown.length / output.length) * 100) / 100 : 1,
    filePaths: filePaths.length,
    symbols: symbols.length,
    decisions: decisions.length,
    openQuestions: openQuestions.length,
  };
  lines.splice(2, 0, `_compacted ${stats.originalChars} -> ${stats.compactedChars} chars (${Math.round(stats.ratio * 100)}%)_`, "");
  return { markdown: lines.join("\n"), stats };
}
