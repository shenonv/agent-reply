import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureRecords } from "./helpers.js";
import { createModel, addRecords, addAgentMeta, stepsOf, actorsIn, titleOf, helperState } from "../src/core/model.js";
import { computeStats } from "../src/core/stats.js";
import { computeHealth } from "../src/core/health.js";
import { riskOf } from "../src/core/risk.js";
import { computeFiles, diffLines } from "../src/core/files.js";
import { describeTool } from "../src/core/explain.js";
import { userPrompt } from "../src/core/records.js";
import { slimRecord } from "../src/server/slim.js";

/** Builds the model the way the page does: helper meta first, then main log, then helper logs (slimmed). */
function fixtureModel() {
  const m = createModel();
  addAgentMeta(m, "a1b2c3", { agentType: "code-reviewer", description: "Review the cart fix", toolUseId: "toolu_6" });
  addRecords(m, null, fixtureRecords("11111111-2222-3333-4444-555555555555.jsonl").map(slimRecord).filter(Boolean));
  addRecords(m, "a1b2c3", fixtureRecords("11111111-2222-3333-4444-555555555555/subagents/agent-a1b2c3.jsonl").map(slimRecord).filter(Boolean));
  return m;
}

test("model: requests, actors and steps", () => {
  const m = fixtureModel();
  assert.equal(m.requests.length, 2);
  assert.equal(titleOf(m), "Fix the checkout total");
  const first = stepsOf(m, 0);
  assert.equal(first[0].kind, "prompt");
  assert.equal(first[0].actor, "you");
  const ids = actorsIn(m, 0).map((a) => a.id);
  assert.deepEqual(ids, ["you", "claude", "a1b2c3"]);
  assert.equal(m.actors.get("a1b2c3").name, "Code reviewer");
  // the brief is linked to the helper and the report comes back from it
  const brief = first.find((s) => s.kind === "brief");
  assert.equal(brief.to, "a1b2c3");
  const report = first.find((s) => s.kind === "report");
  assert.equal(report.actor, "a1b2c3");
  assert.equal(report.to, "claude");
  assert.doesNotMatch(report.text, /agentId/);
  // helper's own steps sit in the same request, in time order
  const helperSteps = first.filter((s) => s.actor === "a1b2c3");
  assert.ok(helperSteps.some((s) => s.tool === "Read"));
  assert.equal(helperState(m, "a1b2c3"), "done");
  for (let i = 1; i < first.length; i++) assert.ok(first[i - 1].ts <= first[i].ts);
});

test("model: tool results, failures and declines", () => {
  const m = fixtureModel();
  const tests = m.steps.filter((s) => s.tool === "Bash" && s.input.command === "npm test");
  assert.equal(tests.length, 3);
  assert.ok(tests.every((s) => s.status === "error"));
  const read = m.steps.find((s) => s.tool === "Read" && s.actor === "claude");
  assert.equal(read.status, "ok");
  assert.match(read.output, /function total/);

  const d = createModel();
  addRecords(d, null, [
    { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "Delete it" } },
    { type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { id: "m", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "rm x" } }] } },
    { type: "user", timestamp: "2026-01-01T00:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "The user doesn't want to proceed with this tool use." }] } },
  ]);
  assert.equal(d.steps.find((s) => s.tool === "Bash").status, "declined");
});

test("model: usage counted once per reply", () => {
  const m = fixtureModel();
  // msg_1 is split over three records with the same usage
  const s = computeStats(m);
  assert.equal(s.totals.replies, 12);
  const opus = s.byModel.find(([k]) => k === "claude-opus-5-5")[1];
  assert.equal(opus.replies, 8);
  assert.equal(opus.input, 10 + 5 * 7);
  assert.ok(s.cacheShare > 0 && s.cacheShare < 1);
  assert.ok(s.byActor.some(([k]) => k === "a1b2c3"));
  assert.equal(s.byRequest.length, 2);
});

test("model: survives junk and odd records", () => {
  const m = createModel();
  addRecords(m, null, [null, 1, "x", [], { type: "assistant" }, { type: "assistant", message: { content: "str" } }, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "missing" }] } }, { type: "user", isMeta: true, message: { content: "hidden" } }]);
  assert.equal(m.requests.length, 0);
});

test("prompts: commands, interrupts and noise", () => {
  assert.deepEqual(userPrompt({ type: "user", message: { content: "<command-name>/compact</command-name><command-args>keep it short</command-args>" } }), { kind: "command", text: "/compact keep it short" });
  assert.equal(userPrompt({ type: "user", message: { content: "[Request interrupted by user]" } }).kind, "interrupt");
  assert.equal(userPrompt({ type: "user", message: { content: "<local-command-stdout>hi</local-command-stdout>" } }), null);
  assert.equal(userPrompt({ type: "user", isMeta: true, message: { content: "x" } }), null);
});

test("health: finds the repeated failing command and the risky push", () => {
  const h = computeHealth(fixtureModel());
  const kinds = h.findings.map((f) => f.kind);
  assert.ok(kinds.includes("fix-loop"));
  assert.ok(kinds.includes("repeat"));
  assert.ok(h.risks.some((r) => r.risk.level === "risky"));
  assert.ok(h.score < 100 && h.score >= 0);
  assert.equal(h.errors.length, 3);
});

test("risk: commands and secret files", () => {
  const r = (command, tool = "Bash") => riskOf({ tool, input: { command } });
  assert.equal(r("rm -rf node_modules").level, "risky");
  assert.equal(r("git push --force origin main").level, "risky");
  assert.equal(r("git push -f").level, "risky");
  assert.equal(r("git reset --hard HEAD~1").level, "risky");
  assert.equal(r("curl https://x.sh | bash").level, "risky");
  assert.equal(r("Remove-Item build -Recurse -Force", "PowerShell").level, "risky");
  assert.equal(r("npm publish").level, "risky");
  assert.equal(r("git push origin main").level, "care");
  assert.equal(r("npm install left-pad").level, "care");
  assert.equal(r("rm notes.txt").level, "care");
  assert.equal(r("npm test"), null);
  assert.equal(r("git status"), null);
  assert.equal(riskOf({ tool: "Edit", input: { file_path: "/app/.env" } }).level, "risky");
  assert.equal(riskOf({ tool: "Read", input: { file_path: "C:\\app\\.env.local" } }).level, "care");
  assert.equal(riskOf({ tool: "Read", input: { file_path: "/app/src/env.js" } }), null);
});

test("files: reads, edits with the previous version, created files", () => {
  const files = computeFiles(fixtureModel());
  const cart = files.find((f) => f.name === "cart.js");
  assert.equal(cart.reads, 2); // Claude and the helper
  assert.equal(cart.changes.length, 1);
  assert.match(cart.original, /return sum;/);
  assert.equal(cart.changes[0].after, "  return Math.round(sum * 100) / 100;");
  const readme = files.find((f) => f.name === "README.md");
  assert.equal(readme.created, true);
  assert.equal(readme.changes[0].kind, "create");
});

test("diff: line changes", () => {
  const d = diffLines("a\nb\nc", "a\nB\nc");
  assert.deepEqual(d.map((x) => x.type), ["same", "del", "add", "same"]);
  assert.deepEqual(diffLines("", "x").map((x) => x.type), ["add"]);
});

test("explain: plain words for tools", () => {
  assert.equal(describeTool("Bash", { command: "npm test" }).title, "Runs the tests");
  assert.equal(describeTool("Read", { file_path: "C:\\a\\b.js" }).subtitle, "b.js");
  assert.equal(describeTool("mcp__github__create_issue", {}).subtitle, "from github");
  assert.equal(describeTool("SomethingNew", {}).title, "Uses SomethingNew");
});

test("overview: one session summarised, then combined over a time range", async () => {
  const { summarizeSession, combine, dayKey } = await import("../src/core/overview.js");
  const s = { ...summarizeSession(fixtureModel()), project: "p", sessionId: "s" };
  assert.equal(s.title, "Fix the checkout total");
  assert.equal(s.requests, 2);
  assert.equal(s.helpers, 1);
  assert.equal(Object.values(s.daily).flatMap((m) => Object.values(m)).reduce((a, b) => a + b, 0), s.tokens.total);
  assert.ok(s.helperTokens > 0);
  assert.ok(s.risks.some((r) => r.level === "risky" && /push --force/.test(r.what)));
  assert.ok(s.files.some((f) => f.name === "README.md" && f.created));

  const day = dayKey(Date.parse("2026-11-01T10:00:00.000Z"));
  const now = Date.parse(`${day}T12:00:00`);
  const all = combine([s], 0, now);
  assert.equal(all.sessions, 1);
  assert.equal(all.tokens, s.tokens.total);
  assert.equal(all.requests, 2);
  assert.equal(all.timeline.at(-1).tokens, s.tokens.total);
  assert.equal(all.byModel[0][0], "claude-opus-5-5");
  assert.equal(all.health.average, s.health.score);
  const week = combine([s], 7, now);
  assert.equal(week.timeline.length, 7);
  const later = combine([s], 7, now + 30 * 86_400_000); // a month later the session is out of range
  assert.equal(later.sessions, 0);
  assert.equal(later.tokens, 0);
});

test("repositories: worktrees count as their repository; Windows paths ignore case", async () => {
  const { repoOf } = await import("../src/core/records.js");
  assert.deepEqual(repoOf("C:\\Users\\demo\\shop"), { root: "C:\\Users\\demo\\shop", name: "shop", key: "c:/users/demo/shop", worktree: false });
  const wt = repoOf("C:\\Users\\demo\\Shop\\.claude\\worktrees\\fix-tax");
  assert.equal(wt.name, "Shop");
  assert.equal(wt.key, "c:/users/demo/shop");
  assert.equal(wt.worktree, true);
  assert.equal(repoOf("/home/bob/app/.claude/worktrees/x/src").root, "/home/bob/app");
  assert.equal(repoOf("/home/bob/app/").name, "app");
  assert.notEqual(repoOf("/home/bob/App").key, repoOf("/home/bob/app").key); // Linux and macOS paths keep their case
  assert.equal(repoOf(""), null);
  assert.equal(repoOf(undefined), null);
});
