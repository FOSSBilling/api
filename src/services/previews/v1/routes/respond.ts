import { Context } from "hono";
import { getArtifactDownloadUrl } from "../github/artifacts";
import { PreviewLookupResult } from "../resolve";
import { githubErrorBody, notFoundBody, statusFromGithubError } from "./errors";

// Shared by /commit/{sha} and /pr/{number}: both resolve to a
// PreviewLookupResult and only differ in their not-found message.
export function respondWithLookup(
  c: Context,
  result: PreviewLookupResult,
  notFoundMessage: string
) {
  if (result.status === "found") {
    return c.json({ result: result.data }, 200);
  }
  if (result.status === "not_found") {
    return c.json(notFoundBody(notFoundMessage), 404);
  }
  return c.json(
    githubErrorBody(result.error, "Failed to look up the preview artifact"),
    statusFromGithubError(result.error)
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
  githubToken: string,
  artifact: PreviewLookupResult,
  notFoundMessage: string
) {
  if (artifact.status === "not_found") {
    return c.json(notFoundBody(notFoundMessage), 404);
  }
  if (artifact.status === "unavailable") {
    return c.json(
      githubErrorBody(artifact.error, "Failed to look up the preview artifact"),
      statusFromGithubError(artifact.error)
    );
  }

  const redirect = await getArtifactDownloadUrl(
    githubToken,
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
      statusFromGithubError(redirect.error)
    );
  }

  return c.redirect(redirect.data, 302);
}
