import { Context } from "hono";
import { request } from "@octokit/request";
import { GitHubError } from "../../../../lib/github-errors";

export interface PreviewGitHub {
  token: string;
  reserve: () => Promise<boolean>;
}

// Includes PR resolution, artifact fallback and the live download redirect.
// Eight calls preserve ordinary fork-PR lookups and the page-six fallback.
const MAX_REQUEST_SUBREQUESTS = 8;

export function previewGitHub(
  c: Context<{ Bindings: CloudflareBindings }>
): PreviewGitHub {
  // CF-Connecting-IP is set by the edge for every client request and is a
  // bare address (never an X-Forwarded-For-style list), so it is used
  // directly as the per-client DO bucket key. IPv6 clients are therefore
  // limited per address, not per /64. A missing header (only possible off
  // the edge, e.g. in tests) shares one conservative "unknown" bucket.
  const client = c.req.header("CF-Connecting-IP") ?? "unknown";
  let remaining = MAX_REQUEST_SUBREQUESTS;
  return {
    token: c.env.GITHUB_TOKEN,
    reserve: async () => {
      if (remaining === 0) return false;
      // Consume before awaiting so concurrent calls cannot exceed the ceiling.
      remaining--;
      return c.env.PREVIEW_GITHUB_BUDGET.getByName("previews").reserve(client);
    }
  };
}

export async function previewRequest(
  github: PreviewGitHub,
  route: string,
  parameters: Record<string, unknown>
) {
  let allowed: boolean;
  try {
    allowed = await github.reserve();
  } catch {
    throw new GitHubError(
      "Preview GitHub budget unavailable",
      503,
      "preview_budget_unavailable"
    );
  }
  if (!allowed) {
    // Existing lookup error handling returns 503, without negative-caching
    // an incomplete scan. Binding failures also fail closed before GitHub.
    throw new GitHubError(
      "Preview GitHub request budget exhausted",
      503,
      "preview_budget_exhausted"
    );
  }
  return request(route, parameters);
}
