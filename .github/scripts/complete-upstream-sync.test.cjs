const assert = require("node:assert/strict");
const test = require("node:test");
const { completeUpstreamSync } = require("./complete-upstream-sync.cjs");

function fixture() {
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    mergeable: true,
    head: { sha: "reviewed", ref: "automation/upstream-main", repo: { full_name: "owner/fork" } },
    base: { sha: "base", ref: "main" },
  };
  const state = {
    pr,
    finalPr: pr,
    comparison: "ahead",
    reviews: [{ user: { login: "coderabbitai[bot]" }, state: "APPROVED", commit_id: "reviewed" }],
    threads: { pageInfo: { hasNextPage: false }, nodes: [] },
    runs: [{ id: 12, head_sha: "reviewed", status: "completed", conclusion: "success" }],
    jobs: [
      "check",
      "test",
      "preview_metadata",
      "wsl_runtime",
      "Desktop installer (linux)",
      "Desktop installer (win)",
    ].map((name) => ({ name, conclusion: "success" })),
    checks: [{ status: "completed", conclusion: "success" }],
    status: { statuses: [{ state: "success" }], state: "success" },
    merges: [],
    dispatches: [],
    comments: [],
    requests: [],
  };
  let reads = 0;
  const github = {
    rest: {
      pulls: {
        list: async () => ({ data: [pr] }),
        get: async () => ({ data: reads++ ? state.finalPr : state.pr }),
        listReviews: async () => state.reviews,
        merge: async (args) => {
          state.merges.push(args);
          return { data: { merged: true, sha: "merged" } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { status: state.comparison } }),
        getCombinedStatusForRef: async () => ({ data: state.status }),
      },
      actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: state.runs } }),
        listJobsForWorkflowRun: async () => state.jobs,
        createWorkflowDispatch: async (args) => {
          state.dispatches.push(args);
        },
      },
      checks: { listForRef: async () => state.checks },
      issues: {
        listComments: async () => state.comments,
        createComment: async (args) => {
          state.requests.push(args);
        },
      },
    },
    paginate: (fn, args) => fn(args),
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: state.threads } } }),
  };
  return {
    state,
    options: { github, context: { repo: { owner: "owner", repo: "fork" } }, core: { info() {} } },
  };
}

test("merges only the validated SHA and explicitly dispatches publication", async () => {
  const { state, options } = fixture();
  assert.equal(await completeUpstreamSync(options), true);
  assert.equal(state.merges[0].sha, "reviewed");
  assert.equal(state.merges[0].merge_method, "merge");
  assert.deepEqual(state.dispatches, [
    { owner: "owner", repo: "fork", workflow_id: "custom-desktop-nightly.yml", ref: "main" },
  ]);
});

const blocked = {
  "foreign repository": (s) => {
    s.pr.head.repo.full_name = "attacker/fork";
  },
  draft: (s) => {
    s.pr.draft = true;
  },
  "main moved": (s) => {
    s.comparison = "diverged";
  },
  "stale approval": (s) => {
    s.reviews[0].commit_id = "old";
  },
  "missing approval": (s) => {
    s.reviews = [];
  },
  "requested changes": (s) => {
    s.reviews.push({ user: { login: "reviewer" }, state: "CHANGES_REQUESTED" });
  },
  "dismissed approval": (s) => {
    s.reviews.push({ user: { login: "coderabbitai[bot]" }, state: "DISMISSED" });
  },
  "unresolved thread": (s) => {
    s.threads.nodes = [{ isResolved: false }];
  },
  "unread review pages": (s) => {
    s.threads.pageInfo.hasNextPage = true;
  },
  "missing CI": (s) => {
    s.runs = [];
  },
  "stale CI": (s) => {
    s.runs[0].head_sha = "old";
  },
  "pending CI": (s) => {
    s.runs[0].status = "in_progress";
  },
  "failed CI": (s) => {
    s.runs[0].conclusion = "failure";
  },
  "missing Windows build": (s) => {
    s.jobs.pop();
  },
  "skipped test": (s) => {
    s.jobs[1].conclusion = "skipped";
  },
  "failed check": (s) => {
    s.checks[0].conclusion = "failure";
  },
  "pending check": (s) => {
    s.checks[0].status = "in_progress";
  },
  "failed commit status": (s) => {
    s.status.state = "failure";
  },
  "head race": (s) => {
    s.finalPr = { ...s.pr, head: { ...s.pr.head, sha: "new" } };
  },
  "base race": (s) => {
    s.finalPr = { ...s.pr, base: { ...s.pr.base, sha: "new" } };
  },
  "merge conflict": (s) => {
    s.finalPr = { ...s.pr, mergeable: false };
  },
};
for (const [name, mutate] of Object.entries(blocked)) {
  test(`does not merge or publish with ${name}`, async () => {
    const { state, options } = fixture();
    mutate(state);
    assert.equal(await completeUpstreamSync(options), false);
    assert.deepEqual(state.merges, []);
    assert.deepEqual(state.dispatches, []);
  });
}

test("publication failure is visible after merge; hourly release schedule can recover", async () => {
  const { state, options } = fixture();
  options.github.rest.actions.createWorkflowDispatch = async () => {
    throw new Error("API unavailable");
  };
  await assert.rejects(completeUpstreamSync(options), /API unavailable/);
  assert.equal(state.merges.length, 1);
});

test("retries a missing review but never merges on a request alone", async () => {
  const { state, options } = fixture();
  state.reviews = [];
  assert.equal(await completeUpstreamSync(options), false);
  assert.match(state.requests[0].body, /@coderabbitai full review/);
  assert.equal(state.merges.length, 0);
});

test("review retries are throttled across scheduled gate runs", async () => {
  const { state, options } = fixture();
  const now = Date.parse("2026-09-21T12:00:00Z");
  state.reviews = [];
  state.comments = [
    {
      user: { login: "github-actions[bot]" },
      body: "<!-- personal-upstream-review -->",
      created_at: new Date(now - 1000).toISOString(),
    },
  ];
  await completeUpstreamSync({ ...options, now });
  assert.equal(state.requests.length, 0);
  await completeUpstreamSync({ ...options, now: now + 60 * 60 * 1000 });
  assert.equal(state.requests.length, 1);
});
