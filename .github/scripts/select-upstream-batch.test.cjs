const assert = require("node:assert/strict");
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
    runGit: () => { throw new Error("must not inspect Git"); },
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

test("rejects a reusable automation branch whose actual merge diff exceeds the limit", () => {
  const result = mergedFileLimit({
    base: "origin/main",
    head: "HEAD",
    maxFiles: 100,
    runGit: (args) => {
      assert.deepEqual(args, ["diff", "--no-renames", "--name-only", "origin/main", "HEAD"]);
      return Array.from({ length: 101 }, (_, i) => `stale/${i}`).join("\n");
    },
  });
  assert.deepEqual(result, { status: "over_limit", files: 101 });
});
