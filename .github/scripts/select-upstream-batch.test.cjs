const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { mergedFileLimit, selectUpstreamBatch } = require("./select-upstream-batch.cjs");

function fakeGit({ commits = "", trees = {}, files = {}, conflict = [] } = {}) {
  return (args) => {
    if (args[0] === "merge-base") return "base";
    if (args[0] === "rev-list") return commits;
    if (args[0] === "merge-tree") {
      const commit = args.at(-1);
      if (conflict.includes(commit)) throw new Error("conflict");
      return trees[commit];
    }
    if (args[0] === "diff-tree") return files[args.at(-1)] ?? "";
    throw new Error(`Unexpected git command: ${args.join(" ")}`);
  };
}

test("selects the furthest first-parent commit at the file boundary", () => {
  const result = selectUpstreamBatch({
    base: "main",
    upstream: "upstream/main",
    maxFiles: 100,
    runGit: fakeGit({
      commits: "one\ntwo\nthree",
      trees: { one: "tree-one", two: "tree-two", three: "tree-three" },
      files: {
        "tree-one": Array.from({ length: 25 }, (_, i) => `a/${i}`).join("\n"),
        "tree-two": Array.from({ length: 100 }, (_, i) => `b/${i}`).join("\n"),
        "tree-three": Array.from({ length: 101 }, (_, i) => `c/${i}`).join("\n"),
      },
    }),
  });
  assert.deepEqual(result, { status: "ready", commit: "two", files: 100 });
});

test("reports no new upstream commits", () => {
  const result = selectUpstreamBatch({
    base: "main",
    upstream: "upstream/main",
    maxFiles: 100,
    runGit: fakeGit(),
  });
  assert.deepEqual(result, { status: "no_changes" });
});

test("does not inspect a pending upstream batch", () => {
  const result = selectUpstreamBatch({
    base: "main",
    upstream: "upstream/main",
    maxFiles: 100,
    openPr: true,
    runGit: () => {
      throw new Error("must not inspect Git");
    },
  });
  assert.deepEqual(result, { status: "open_stable" });
});

test("pauses when the first upstream commit exceeds the review limit", () => {
  const result = selectUpstreamBatch({
    base: "main",
    upstream: "upstream/main",
    maxFiles: 100,
    runGit: fakeGit({
      commits: "large",
      trees: { large: "large-tree" },
      files: { "large-tree": Array.from({ length: 101 }, (_, i) => `large/${i}`).join("\n") },
    }),
  });
  assert.deepEqual(result, { status: "oversized", commit: "large", files: 101 });
});

test("pauses when the first upstream commit conflicts", () => {
  const result = selectUpstreamBatch({
    base: "main",
    upstream: "upstream/main",
    maxFiles: 100,
    runGit: fakeGit({ commits: "conflicted", conflict: ["conflicted"] }),
  });
  assert.deepEqual(result, { status: "conflict", commit: "conflicted" });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("rejects a reusable automation branch whose actual merge diff exceeds the limit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "t3-upstream-batch-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  git(directory, "init", "-q", "-b", "main");
  git(directory, "config", "user.name", "Test");
  git(directory, "config", "user.email", "test@example.com");
  writeFileSync(join(directory, "base.txt"), "base\n");
  git(directory, "add", "base.txt");
  git(directory, "commit", "-qm", "base");
  git(directory, "checkout", "-qb", "automation/upstream-main");
  for (let index = 0; index <= 100; index += 1) {
    writeFileSync(join(directory, `stale-${index}.txt`), "stale\n");
  }
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "stale automation batch");

  const result = mergedFileLimit({
    base: "main",
    head: "HEAD",
    maxFiles: 100,
    runGit: (args) => git(directory, ...args),
  });
  assert.deepEqual(result, { status: "over_limit", files: 101 });
});
