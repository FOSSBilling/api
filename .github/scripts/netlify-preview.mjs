import assert from "node:assert/strict";
import { URL } from "node:url";

const artifactPrefix = "extension-packager-preview-attempt-";
const marker = "<!-- extension-packager-preview -->";
const statuses = {
  success: "Passed",
  failure: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled"
};

function isMatchingPr(pr, repository, branch) {
  return (
    pr.state === "open" &&
    pr.base.ref === "main" &&
    pr.head.repo?.full_name === repository &&
    pr.head.ref === branch
  );
}

export async function findPreview({ github, context, runAttempt }) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const eventRun = context.payload.workflow_run;
  const eventPr = context.payload.pull_request;
  let branch;
  if (context.eventName === "workflow_run") {
    if (
      eventRun.event !== "push" ||
      eventRun.head_repository?.full_name !== repository
    )
      return;
    branch = eventRun.head_branch;
  } else if (context.eventName === "pull_request_target") {
    if (!isMatchingPr(eventPr, repository, eventPr.head.ref)) return;
    branch = eventPr.head.ref;
  } else if (
    context.eventName === "push" &&
    context.ref.startsWith("refs/heads/")
  ) {
    branch = context.ref.slice("refs/heads/".length);
  } else return;
  if (branch === "main") return;

  const prs = (
    await github.paginate(github.rest.pulls.list, {
      ...context.repo,
      state: "open",
      base: "main",
      head: `${context.repo.owner}:${branch}`,
      per_page: 100
    })
  ).filter((pr) => isMatchingPr(pr, repository, branch));
  if (!prs.length) return;
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo,
    workflow_id: "ci.yml",
    event: "push",
    branch,
    head_sha: prs[0].head.sha,
    per_page: 1
  });
  const run = data.workflow_runs[0];
  if (!run || run.head_sha !== prs[0].head.sha) return;
  if (
    (eventRun &&
      (eventRun.id !== run.id || eventRun.run_attempt !== run.run_attempt)) ||
    (context.eventName === "push" &&
      (context.runId !== run.id || runAttempt !== run.run_attempt))
  )
    return;

  const artifacts = await github.paginate(
    github.rest.actions.listWorkflowRunArtifacts,
    { ...context.repo, run_id: run.id, per_page: 100 }
  );
  const artifact = artifacts.find(
    (item) =>
      !item.expired && item.name === `${artifactPrefix}${run.run_attempt}`
  );
  if (!artifact) return;
  return {
    runId: run.id,
    runAttempt: run.run_attempt,
    sha: run.head_sha,
    branch,
    artifactId: artifact.id,
    attempt: run.run_attempt,
    prs: prs.map((pr) => pr.number)
  };
}

export async function publishPreview({ github, context, preview, metadata }) {
  assert.equal(metadata.sha, preview.sha, "Preview commit mismatch");
  assert.equal(metadata.attempt, preview.attempt, "Preview attempt mismatch");
  for (const result of [metadata.build, metadata.checks, metadata.deployment])
    assert.ok(Object.hasOwn(statuses, result), "Invalid preview result");
  const success = metadata.deployment === "success";
  let url;
  if (success) {
    assert.equal(metadata.build, "success");
    assert.equal(metadata.checks, "success");
    url = new URL(metadata.url);
    assert.ok(
      url.protocol === "https:" &&
        url.hostname.endsWith(".netlify.app") &&
        !url.username &&
        !url.password &&
        url.pathname === "/.netlify/functions/extension-packager",
      "Invalid packager preview URL"
    );
  }
  const repoUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}`;
  const logs = `${repoUrl}/actions/runs/${preview.runId}/attempts/${preview.attempt}`;
  const body = [
    marker,
    "### Extension Packager Preview",
    "",
    `Commit [\`${preview.sha.slice(0, 7)}\`](${repoUrl}/commit/${preview.sha}) · Attempt ${preview.attempt} · [CI logs](${logs})`,
    "",
    "| Build | Checks | Deployment |",
    "| --- | --- | --- |",
    `| ${statuses[metadata.build]} | ${statuses[metadata.checks]} | ${statuses[metadata.deployment]} |`,
    "",
    success
      ? `[Preview endpoint](${url.href.replaceAll("(", "%28").replaceAll(")", "%29")})`
      : "No preview was deployed for this attempt."
  ].join("\n");

  for (const issue_number of preview.prs) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...context.repo,
      issue_number,
      per_page: 100
    });
    const existing = comments.find(
      (comment) =>
        comment.user?.login === "github-actions[bot]" &&
        comment.body?.includes(marker)
    );
    if (existing?.body === body) continue;
    const { data: pr } = await github.rest.pulls.get({
      ...context.repo,
      pull_number: issue_number
    });
    if (
      !isMatchingPr(
        pr,
        `${context.repo.owner}/${context.repo.repo}`,
        preview.branch
      ) ||
      pr.head.sha !== preview.sha
    )
      continue;
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: "ci.yml",
      event: "push",
      branch: preview.branch,
      head_sha: preview.sha,
      per_page: 1
    });
    const latest = data.workflow_runs[0];
    if (
      latest?.id !== preview.runId ||
      latest.run_attempt !== preview.runAttempt
    )
      continue;
    if (existing)
      await github.rest.issues.updateComment({
        ...context.repo,
        comment_id: existing.id,
        body
      });
    else
      await github.rest.issues.createComment({
        ...context.repo,
        issue_number,
        body
      });
  }
}
