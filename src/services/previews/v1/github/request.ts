import { Context } from "hono";
import { request } from "@octokit/request";
import { GitHubError } from "../../../../lib/github-errors";

export interface PreviewGitHub {
  token: string;
  reserve: () => Promise<boolean>;
}

export function previewGitHub(
  c: Context<{ Bindings: CloudflareBindings }>
): PreviewGitHub {
  // CF supplies this header at the edge; never trust X-Forwarded-For.
  // Missing addresses share a conservative allowance.
  const client = c.req.header("CF-Connecting-IP") ?? "unknown";
  return {
    token: c.env.GITHUB_TOKEN,
    reserve: async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(client)
      );
      const key = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
      return c.env.PREVIEW_GITHUB_BUDGET.getByName("previews").reserve(key);
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
