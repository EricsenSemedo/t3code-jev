const { execFileSync } = require("node:child_process");

function changedFileCount(runGit, base, tree) {
  const files = runGit([
    "diff-tree",
    "--no-commit-id",
    "--no-renames",
    "--name-only",
    "-r",
    base,
    tree,
  ]);
  return files ? files.split("\n").filter(Boolean).length : 0;
}

function mergedFileLimit({ base, head, maxFiles, runGit }) {
  const files = runGit(["diff", "--no-renames", "--name-only", base, head]);
  const count = files ? files.split("\n").filter(Boolean).length : 0;
  return { status: count <= maxFiles ? "within_limit" : "over_limit", files: count };
}

function selectUpstreamBatch({ base, upstream, maxFiles, openPr = false, runGit }) {
  if (openPr) return { status: "open_stable" };

  const mergeBase = runGit(["merge-base", base, upstream]);
  const commits = runGit(["rev-list", "--first-parent", "--reverse", `${mergeBase}..${upstream}`])
    .split("\n")
    .filter(Boolean);
  if (commits.length === 0) return { status: "no_changes" };

  let selected;
  for (const commit of commits) {
    let tree;
    try {
      tree = runGit(["merge-tree", "--write-tree", base, commit]);
    } catch {
      if (!selected) return { status: "conflict", commit };
      return { status: "ready", commit: selected.commit, files: selected.files };
    }

    const files = changedFileCount(runGit, base, tree);
    if (files > maxFiles) {
      if (!selected) return { status: "oversized", commit, files };
      return { status: "ready", commit: selected.commit, files: selected.files };
    }
    selected = { commit, files };
  }

  return { status: "ready", commit: selected.commit, files: selected.files };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const base = value("--base");
  const upstream = value("--upstream");
  const head = value("--head");
  const maxFiles = Number(value("--max-files"));
  if (
    !base ||
    !Number.isInteger(maxFiles) ||
    maxFiles < 1 ||
    (!upstream && !head) ||
    (upstream && head)
  ) {
    throw new Error(
      "Usage: select-upstream-batch.cjs --base <ref> (--upstream <ref> | --head <ref>) --max-files <positive integer>",
    );
  }
  const result = head
    ? mergedFileLimit({ base, head, maxFiles, runGit: git })
    : selectUpstreamBatch({ base, upstream, maxFiles, runGit: git });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { mergedFileLimit, selectUpstreamBatch };
