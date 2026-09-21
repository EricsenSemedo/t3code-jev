const SYNC_BRANCH = "automation/upstream-main";
const REQUIRED_JOBS = [
  "check",
  "test",
  "preview_metadata",
  "wsl_runtime",
  "Desktop installer (linux)",
  "Desktop installer (win)",
];

async function completeUpstreamSync({ github, context, core, now = Date.now() }) {
  const repo = context.repo;
  const pending = (reason) => {
    core.info(`Upstream sync waiting: ${reason}`);
    return false;
  };
  const { data: prs } = await github.rest.pulls.list({
    ...repo,
    state: "open",
    base: "main",
    head: `${repo.owner}:${SYNC_BRANCH}`,
  });
  if (prs.length !== 1) return pending("no unique open sync PR");
  const number = prs[0].number;
  const readPr = async () => (await github.rest.pulls.get({ ...repo, pull_number: number })).data;
  const pr = await readPr();
  if (
    pr.draft ||
    pr.state !== "open" ||
    pr.head.repo?.full_name !== `${repo.owner}/${repo.repo}` ||
    pr.head.ref !== SYNC_BRANCH ||
    pr.base.ref !== "main"
  )
    return pending("unexpected PR identity or draft state");
  const head = pr.head.sha;
  const base = pr.base.sha;
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${base}...${head}`,
  });
  if (comparison.status !== "ahead") return pending("sync branch must include current main");

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...repo,
    pull_number: number,
    per_page: 100,
  });
  const latestReviews = new Map();
  for (const review of reviews) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      latestReviews.set(review.user.login, review);
    }
  }
  if ([...latestReviews.values()].some((r) => r.state === "CHANGES_REQUESTED")) {
    return pending("a reviewer requested changes");
  }
  const approval = latestReviews.get("coderabbitai[bot]");
  if (approval?.state !== "APPROVED" || approval.commit_id !== head) {
    // A rate-limited automatic review is not retried just because CI completed.
    // Retry at most hourly without treating a successful bot status as approval.
    const marker = "<!-- personal-upstream-review -->";
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...repo,
      issue_number: number,
      per_page: 100,
    });
    const lastRequest = comments
      .filter((c) => c.user.login === "github-actions[bot]" && c.body.includes(marker))
      .reduce((latest, c) => Math.max(latest, Date.parse(c.created_at)), 0);
    if (now - lastRequest >= 60 * 60 * 1000) {
      await github.rest.issues.createComment({
        ...repo,
        issue_number: number,
        body: `@coderabbitai full review\n\n${marker}\nRequesting review of upstream revision ${head}; merge remains gated on approval.`,
      });
    }
    return pending("CodeRabbit approval is missing or belongs to an older revision");
  }
  const { repository } = await github.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes { isResolved }
          }
        }
      }
    }`,
    { ...repo, number },
  );
  const threads = repository.pullRequest.reviewThreads;
  if (threads.pageInfo.hasNextPage || threads.nodes.some((thread) => !thread.isResolved)) {
    return pending("unresolved review threads");
  }

  const { data: runs } = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: "ci.yml",
    branch: SYNC_BRANCH,
    event: "workflow_dispatch",
    head_sha: head,
    per_page: 1,
  });
  const run = runs.workflow_runs[0];
  if (!run || run.head_sha !== head || run.status !== "completed" || run.conclusion !== "success") {
    return pending("the latest CI run for this revision has not passed");
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  if (
    REQUIRED_JOBS.some((name) => !jobs.some((j) => j.name === name && j.conclusion === "success"))
  ) {
    return pending("CI is missing a required successful job");
  }
  const checks = await github.paginate(github.rest.checks.listForRef, {
    ...repo,
    ref: head,
    filter: "latest",
    per_page: 100,
  });
  if (
    checks.some(
      (c) => c.status !== "completed" || !["success", "neutral", "skipped"].includes(c.conclusion),
    )
  ) {
    return pending("a check is pending or failed");
  }
  const { data: status } = await github.rest.repos.getCombinedStatusForRef({ ...repo, ref: head });
  if (status.statuses.length && status.state !== "success")
    return pending("a commit status is not successful");

  const current = await readPr();
  if (current.head.sha !== head || current.base.sha !== base || current.mergeable !== true) {
    return pending("PR changed during validation or is not mergeable");
  }
  const { data: merged } = await github.rest.pulls.merge({
    ...repo,
    pull_number: number,
    sha: head,
    merge_method: "merge",
  });
  if (!merged.merged) throw new Error(`Upstream merge was refused: ${merged.message}`);
  core.info(`Merged upstream PR #${number} at ${merged.sha}; dispatching Personal release.`);
  // GITHUB_TOKEN merges do not trigger ordinary push workflows.
  await github.rest.actions.createWorkflowDispatch({
    ...repo,
    workflow_id: "custom-desktop-nightly.yml",
    ref: "main",
  });
  return true;
}

module.exports = { completeUpstreamSync };
