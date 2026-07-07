#!/usr/bin/env node
// Story executor: turns APPROVED service tasks into branches (and optionally PRs).
// Usage:
//   node story-planner/execute-story.mjs --story <slug> [--repos-root dir] [--push] [--dry-run]
//
// Unit of work (per spec): one service, one bounded task, one branch, one PR,
// one context pack. Only tasks with approved: true in service-tasks.yaml are
// executed — this script IS the human approval gate enforcement.
//
// Per approved task:
//   1. locate service checkout at <repos-root>/<service> (default: agent-hub parent dir)
//   2. validate: git repo, clean worktree, task branch does not exist
//   3. create branch from current HEAD, commit .story/<slug>/TASK.md briefing
//      (task + context pack), switch back to the original branch
//   4. with --push: push branch and open a draft PR via gh
//
// All tasks are validated before any repo is mutated. Results are written back
// to service-tasks.yaml (status, baseCommit, prUrl) and execution-report.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { AGENT_HUB_ROOT, reposRoot as configuredReposRoot } from "../lib/project-config.mjs";

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
const hasFlag = (name) => args.includes(`--${name}`);

const storyArg = flag("story");
if (!storyArg) fail("usage: execute-story --story <slug> [--repos-root dir] [--push] [--dry-run]");
const storyDir = existsSync(join(storyArg, "story.yaml")) ? storyArg : join(AGENT_HUB_ROOT, "stories", storyArg);
if (!existsSync(join(storyDir, "story.yaml"))) fail(`story not found: ${storyDir} (run plan-story first)`);

const reposRoot = resolve(flag("repos-root") ?? configuredReposRoot());
const push = hasFlag("push");
const dryRun = hasFlag("dry-run");

const story = YAML.parse(readFileSync(join(storyDir, "story.yaml"), "utf8"));
const tasksDoc = YAML.parse(readFileSync(join(storyDir, "service-tasks.yaml"), "utf8"));
const slug = story.story;

// --- Git helpers ----------------------------------------------------------------
function git(repoDir, ...argv) {
  return execFileSync("git", argv, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function branchExists(repoDir, branch) {
  try {
    git(repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

// --- Select + validate all approved tasks before mutating anything ----------------
const approved = tasksDoc.tasks.filter((t) => t.approved === true);
const skipped = tasksDoc.tasks.filter((t) => t.approved !== true);
if (!approved.length) fail("no approved tasks; review impact-analysis.md and set approved: true in service-tasks.yaml");

const problems = [];
for (const t of approved) {
  if (t.status !== "proposed") {
    problems.push(`${t.service}: status is "${t.status}" (already executed?)`);
    continue;
  }
  const repoDir = join(reposRoot, t.service);
  if (!existsSync(join(repoDir, ".git"))) {
    problems.push(`${t.service}: no git checkout at ${repoDir}`);
    continue;
  }
  if (git(repoDir, "status", "--porcelain")) problems.push(`${t.service}: worktree not clean at ${repoDir}`);
  if (branchExists(repoDir, t.branch)) problems.push(`${t.service}: branch ${t.branch} already exists`);
  if (!existsSync(join(storyDir, t.contextPack))) problems.push(`${t.service}: missing context pack ${t.contextPack}`);
}
if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  fail("preconditions failed; no repositories were modified");
}

// --- Execute -----------------------------------------------------------------------
const results = [];
for (const t of approved) {
  const repoDir = join(reposRoot, t.service);
  if (dryRun) {
    console.log(`[dry-run] ${t.service}: would create branch ${t.branch}, commit .story/${slug}/TASK.md${push ? ", push + open draft PR" : ""}`);
    results.push({ ...t, baseCommit: git(repoDir, "rev-parse", "HEAD"), status: "proposed", prUrl: null });
    continue;
  }

  const originalBranch = git(repoDir, "rev-parse", "--abbrev-ref", "HEAD");
  const baseCommit = git(repoDir, "rev-parse", "HEAD");
  git(repoDir, "checkout", "-b", t.branch);
  try {
    const agentId = t.agent ?? "implementer";
    const briefing = [
      `# Task briefing: ${story.title}`,
      "",
      `- Story: ${slug}`,
      `- Service: ${t.service}`,
      `- Branch: ${t.branch}`,
      `- Base commit: ${baseCommit}`,
      `- Bundle: ${story.bundleVersion}`,
      `- Agent: ${agentId}`,
      "",
      `## How to run this task`,
      "",
      `With the GitHub Copilot CLI, from this repo on this branch:`,
      "",
      "```",
      `copilot --agent=${agentId} -p "Read .story/${slug}/TASK.md and complete the task it describes."`,
      "```",
      "",
      `(The custom agent is defined in agent-hub's .github/agents/${agentId}.agent.md.)`,
      "",
      `## Task`,
      "",
      t.task,
      "",
      story.description,
      "",
      `## Context pack`,
      "",
      readFileSync(join(storyDir, t.contextPack), "utf8").trim(),
      "",
    ].join("\n");
    mkdirSync(join(repoDir, ".story", slug), { recursive: true });
    writeFileSync(join(repoDir, ".story", slug, "TASK.md"), briefing);
    git(repoDir, "add", `.story/${slug}/TASK.md`);
    git(repoDir, "commit", "-m", `chore(story): add task briefing for ${slug}`);

    let prUrl = null;
    let status = "branched";
    if (push) {
      git(repoDir, "push", "-u", "origin", t.branch);
      prUrl = execFileSync(
        "gh",
        ["pr", "create", "--draft", "--head", t.branch, "--title", `[${slug}] ${t.task}`, "--body", `Story: ${slug}\n\nSee \`.story/${slug}/TASK.md\` for the task briefing and context pack.`],
        { cwd: repoDir, encoding: "utf8" }
      ).trim();
      status = "pr-opened";
    }
    results.push({ ...t, baseCommit, status, prUrl });
    console.log(`${t.service}: ${status} ${t.branch} (base ${baseCommit.slice(0, 7)})${prUrl ? ` ${prUrl}` : ""}`);
  } finally {
    git(repoDir, "checkout", originalBranch);
  }
}

// --- Record results ------------------------------------------------------------------
if (!dryRun) {
  const updated = tasksDoc.tasks.map((t) => results.find((r) => r.service === t.service) ?? t);
  writeFileSync(join(storyDir, "service-tasks.yaml"), YAML.stringify({ story: slug, tasks: updated }));

  const report = [];
  report.push(`# Execution report: ${story.title}`);
  report.push("");
  report.push(`Story: ${slug}`);
  report.push("");
  report.push(`| Service | Branch | Base | Status | PR |`);
  report.push(`| --- | --- | --- | --- | --- |`);
  for (const r of results) report.push(`| ${r.service} | \`${r.branch}\` | ${r.baseCommit.slice(0, 7)} | ${r.status} | ${r.prUrl ?? "—"} |`);
  for (const t of skipped) report.push(`| ${t.service} | \`${t.branch}\` | — | not approved (skipped) | — |`);
  report.push("");
  report.push(`Merge order guidance: see implementation-plan.md (callees merge before callers).`);
  report.push("");
  writeFileSync(join(storyDir, "execution-report.md"), report.join("\n"));
  console.log(`wrote ${join(storyDir, "execution-report.md")}`);
}
if (skipped.length) console.log(`skipped (not approved): ${skipped.map((t) => t.service).join(", ")}`);
