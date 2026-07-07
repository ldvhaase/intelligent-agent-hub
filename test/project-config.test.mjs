import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import {
  AGENT_HUB_ROOT,
  copilotSettings,
  knowledgeWikiPath,
  projectConfig,
  reposRoot,
  runnerDefaults,
} from "../lib/project-config.mjs";

// Each test points AGENT_HUB_CONFIG at its own file so the committed
// agent-hub.config.yaml never leaks into assertions.
function withConfig(yamlText, fn) {
  const dir = mkdtempSync(join(tmpdir(), "hubcfg-"));
  const path = join(dir, "agent-hub.config.yaml");
  writeFileSync(path, yamlText);
  const saved = { ...process.env };
  process.env.AGENT_HUB_CONFIG = path;
  delete process.env.KNOWLEDGE_WIKI_PATH;
  delete process.env.AGENT_HUB_REPOS_ROOT;
  delete process.env.COPILOT_CLI_BIN;
  try {
    projectConfig({ reload: true });
    return fn();
  } finally {
    for (const k of ["AGENT_HUB_CONFIG", "KNOWLEDGE_WIKI_PATH", "AGENT_HUB_REPOS_ROOT", "COPILOT_CLI_BIN"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    projectConfig({ reload: true });
  }
}

test("config file values are used and resolved from the agent-hub root", () => {
  withConfig("knowledgeWikiPath: ../elsewhere/wiki\nreposRoot: ../checkouts\n", () => {
    assert.equal(knowledgeWikiPath(), resolve(AGENT_HUB_ROOT, "..", "elsewhere", "wiki"));
    assert.equal(reposRoot(), resolve(AGENT_HUB_ROOT, "..", "checkouts"));
  });
});

test("environment variables take precedence over the config file", () => {
  withConfig("knowledgeWikiPath: ../from-config\n", () => {
    process.env.KNOWLEDGE_WIKI_PATH = join(tmpdir(), "from-env");
    assert.equal(knowledgeWikiPath(), resolve(join(tmpdir(), "from-env")));
  });
});

test("missing keys fall back to sibling-directory defaults", () => {
  withConfig("", () => {
    assert.equal(knowledgeWikiPath(), resolve(AGENT_HUB_ROOT, "..", "knowledge-network"));
    assert.equal(reposRoot(), resolve(AGENT_HUB_ROOT, ".."));
    assert.ok(isAbsolute(knowledgeWikiPath()));
  });
});

test("runner defaults come from the config file, defaulting to dry-run", () => {
  withConfig("runner:\n  type: cmd\n  cmd: node orchestrator/adapters/copilot.mjs\n", () => {
    assert.deepEqual(runnerDefaults(), { type: "cmd", cmd: "node orchestrator/adapters/copilot.mjs" });
  });
  withConfig("", () => {
    assert.deepEqual(runnerDefaults(), { type: "dry-run", cmd: null });
  });
});

test("copilot settings honor config and env override for the binary", () => {
  withConfig("copilot:\n  bin: /opt/copilot/bin/copilot\n  extraArgs: [\"--allow-tool\", \"read\"]\n", () => {
    assert.deepEqual(copilotSettings(), { bin: "/opt/copilot/bin/copilot", extraArgs: ["--allow-tool", "read"] });
    process.env.COPILOT_CLI_BIN = "copilot-canary";
    assert.equal(copilotSettings().bin, "copilot-canary");
  });
  withConfig("", () => {
    assert.deepEqual(copilotSettings(), { bin: "copilot", extraArgs: ["--allow-all"] });
  });
});
