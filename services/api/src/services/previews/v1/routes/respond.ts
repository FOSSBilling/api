import { PreviewGitHub } from "../github/request";
import { Context, TypedResponse } from "hono";
import { getArtifactDownloadUrl } from "../github/artifacts";
import { PreviewLookupResult } from "../resolve";
import { githubErrorBody, notFoundBody, statusFromGithubError } from "./errors";

type LookupData = Extract<PreviewLookupResult, { status: "found" }>["data"];
type LookupOk = Response & TypedResponse<{ result: LookupData }, 200, "json">;
type LookupMissing = Response &
  TypedResponse<{ error: { message: string; code: string } }, 404, "json">;
type LookupError = Response &
  TypedResponse<
    { error: { message: string; code: string } },
    409 | 429 | 500 | 503,
    "json"
  >;
type LookupErrorWithoutAmbiguity = Response &
  TypedResponse<
    { error: { message: string; code: string } },
    429 | 500 | 503,
    "json"
  >;
type LookupRedirect = Response & TypedResponse<undefined, 302, "redirect">;

// Shared by /commit/{sha} and /pr/{number}: both resolve to a
// PreviewLookupResult and only differ in their not-found message. PR routes
// resolve from GitHub's full head SHA, which never takes the prefix-scan
// path that produces AMBIGUOUS_COMMIT, so they pass includeAmbiguous=false
// to keep the unreachable 409 out of their OpenAPI contract.
export function respondWithLookup(
  c: Context,
  result: PreviewLookupResult,
  notFoundMessage: string,
  includeAmbiguous?: true
): LookupOk | LookupMissing | LookupError;
export function respondWithLookup(
  c: Context,
  result: PreviewLookupResult,
  notFoundMessage: string,
  includeAmbiguous: false
): LookupOk | LookupMissing | LookupErrorWithoutAmbiguity;
export function respondWithLookup(
  c: Context,
  result: PreviewLookupResult,
  notFoundMessage: string,
  includeAmbiguous = true
) {
  if (result.status === "found") {
    return c.json({ result: result.data }, 200);
  }
  if (result.status === "not_found") {
    return c.json(notFoundBody(notFoundMessage), 404);
  }
  const status = includeAmbiguous
    ? statusFromGithubError(result.error)
    : statusFromGithubError(result.error, false);
  return c.json(
    githubErrorBody(result.error, "Failed to look up the preview artifact"),
    status
  );
}

// Shared by /commit/{sha}/download and /pr/{number}/download. Always
// resolved live, never cached - GitHub's signed URL expires in ~60s, and
// KV enforces a hard 60s minimum TTL, so there's no safe margin available
// to cache it without risking handing out an already-expired URL. See
// preview:redirect caching's revert in git history for why that was tried
// and abandoned.
export async function respondWithDownloadRedirect(
  c: Context,
  github: PreviewGitHub,
  artifact: PreviewLookupResult,
  notFoundMessage: string,
  includeAmbiguous?: true
): Promise<LookupMissing | LookupError | LookupRedirect>;
export async function respondWithDownloadRedirect(
  c: Context,
  github: PreviewGitHub,
  artifact: PreviewLookupResult,
  notFoundMessage: string,
  includeAmbiguous: false
): Promise<LookupMissing | LookupErrorWithoutAmbiguity | LookupRedirect>;
export async function respondWithDownloadRedirect(
  c: Context,
  github: PreviewGitHub,
  artifact: PreviewLookupResult,
  notFoundMessage: string,
  includeAmbiguous = true
) {
  const statusFor = (error: Parameters<typeof statusFromGithubError>[0]) =>
    includeAmbiguous
      ? statusFromGithubError(error)
      : statusFromGithubError(error, false);
  if (artifact.status === "not_found") {
    return c.json(notFoundBody(notFoundMessage), 404);
  }
  if (artifact.status === "unavailable") {
    return c.json(
      githubErrorBody(artifact.error, "Failed to look up the preview artifact"),
      statusFor(artifact.error)
    );
  }

  const redirect = await getArtifactDownloadUrl(
    github,
    artifact.data.artifact_id
  );
  if (redirect.status === "not_found") {
    return c.json(notFoundBody("The preview artifact has expired."), 404);
  }
  if (redirect.status === "unavailable") {
    return c.json(
      githubErrorBody(
        redirect.error,
        "Failed to resolve the artifact download URL"
      ),
      statusFor(redirect.error)
    );
  }

  return c.redirect(redirect.data, 302);
}
