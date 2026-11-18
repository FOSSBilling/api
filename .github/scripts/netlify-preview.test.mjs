import { describe, expect, it, vi } from "vitest";
import { findPreview, publishPreview } from "./netlify-preview.mjs";

function fixture() {
  const sha = "a".repeat(40);
  const pr = {
    number: 327,
    state: "open",
    base: { ref: "main" },
    head: {
      ref: "codex/netlify-cli-deployments",
      sha,
      repo: { full_name: "FOSSBilling/api" }
    }
  };
  const run = { id: 11, run_attempt: 1, head_sha: sha };
  const artifacts = [
    { id: 21, name: "extension-packager-preview-attempt-1", expired: false }
  ];
  const comments = [];
  const rest = {
    pulls: {
      list: vi.fn(async () => ({ data: [pr] })),
      get: vi.fn(async () => ({ data: pr }))
    },
    actions: {
      listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [run] } })),
      listWorkflowRunArtifacts: vi.fn(async () => ({ data: { artifacts } }))
    },
    issues: {
      listComments: vi.fn(async () => ({ data: comments })),
      createComment: vi.fn(async ({ body }) => {
        comments.push({ id: 31, user: { login: "github-actions[bot]" }, body });
      }),
      updateComment: vi.fn(async ({ comment_id, body }) => {
        comments.find((comment) => comment.id === comment_id).body = body;
      })
    }
  };
  const github = {
    rest,
    paginate: vi.fn(async (method, options) => {
      const { data } = await method(options);
      return Array.isArray(data) ? data : data.artifacts;
    })
  };
  const context = {
    repo: { owner: "FOSSBilling", repo: "api" },
    eventName: "push",
    ref: `refs/heads/${pr.head.ref}`,
    runId: run.id,
    serverUrl: "https://github.com",
    payload: {}
  };
  const metadata = {
    sha,
    attempt: 1,
    url: "https://deploy-id--fb-api-packager.netlify.app/.netlify/functions/extension-packager",
    build: "success",
    checks: "success",
    deployment: "success"
  };
  const find = (runAttempt = run.run_attempt) =>
    findPreview({ github, context, runAttempt });
  const publish = (preview, data = metadata) =>
    publishPreview({ github, context, preview, metadata: data });
  return {
    pr,
    run,
    artifacts,
    comments,
    github,
    rest,
    context,
    metadata,
    find,
    publish
  };
}

describe("packager preview reporting", () => {
  it("creates one comment, leaves identical reports untouched, and updates it after a failed retry", async () => {
    const f = fixture();
    await f.publish(await f.find());
    expect(f.rest.issues.createComment).toHaveBeenCalledOnce();
    expect(f.comments[0].body).toContain(
      `[Preview endpoint](${f.metadata.url})`
    );
    await f.publish(await f.find());
    expect(f.rest.issues.updateComment).not.toHaveBeenCalled();

    f.run.run_attempt = 2;
    f.artifacts.push({
      id: 22,
      name: "extension-packager-preview-attempt-2",
      expired: false
    });
    await f.publish(await f.find(), {
      ...f.metadata,
      attempt: 2,
      deployment: "failure",
      url: null
    });
    expect(f.comments).toHaveLength(1);
    expect(f.rest.issues.updateComment).toHaveBeenCalledOnce();
    expect(f.comments[0].body).toContain("| Passed | Passed | Failed |");
    expect(f.comments[0].body).toContain("/actions/runs/11/attempts/2");
    expect(f.comments[0].body).not.toContain(f.metadata.url);
  });

  it("finds the deployment when the PR opens after CI, using its current head", async () => {
    const f = fixture();
    f.context.eventName = "pull_request_target";
    f.context.payload.pull_request = {
      ...f.pr,
      head: { ...f.pr.head, sha: "b".repeat(40) }
    };
    const preview = await f.find();
    expect(f.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({ event: "push", head_sha: f.pr.head.sha })
    );
    await f.publish(preview);
    expect(f.rest.issues.createComment).toHaveBeenCalledOnce();
  });

  it("does not report fork PRs or PR-triggered workflow runs", async () => {
    const f = fixture();
    f.context.eventName = "pull_request_target";
    f.context.payload.pull_request = {
      ...f.pr,
      head: { ...f.pr.head, repo: { full_name: "contributor/api" } }
    };
    expect(await f.find()).toBeUndefined();
    f.context.eventName = "workflow_run";
    f.context.payload.workflow_run = {
      event: "pull_request",
      head_repository: { full_name: "FOSSBilling/api" }
    };
    expect(await f.find()).toBeUndefined();
    expect(f.github.paginate).not.toHaveBeenCalled();
  });

  it("ignores a delayed workflow completion after a newer run for the same commit", async () => {
    const f = fixture();
    f.context.eventName = "workflow_run";
    f.context.payload.workflow_run = {
      ...f.run,
      event: "push",
      head_branch: f.pr.head.ref,
      head_repository: { full_name: "FOSSBilling/api" }
    };
    f.run.id = 12;
    expect(await f.find()).toBeUndefined();
    expect(f.rest.actions.listWorkflowRunArtifacts).not.toHaveBeenCalled();
  });

  it("waits for metadata and can reuse an earlier attempt on a comment-only rerun", async () => {
    const f = fixture();
    const artifact = f.artifacts.pop();
    expect(await f.find()).toBeUndefined();
    f.artifacts.push(artifact);
    f.run.run_attempt = 2;
    const preview = await f.find();
    expect(preview.attempt).toBe(1);
    await f.publish(preview);
    expect(f.comments[0].body).toContain("/attempts/1");
  });

  it("does not overwrite the comment after the PR head or latest run changes", async () => {
    const f = fixture();
    const preview = await f.find();
    f.pr.head.sha = "b".repeat(40);
    await f.publish(preview);
    expect(f.rest.issues.createComment).not.toHaveBeenCalled();
    f.pr.head.sha = preview.sha;
    f.run.id = 12;
    await f.publish(preview);
    expect(f.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("rejects mismatched artifact metadata before publishing", async () => {
    const f = fixture();
    await expect(
      f.publish(await f.find(), { ...f.metadata, sha: "b".repeat(40) })
    ).rejects.toThrow("Preview commit mismatch");
    expect(f.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
