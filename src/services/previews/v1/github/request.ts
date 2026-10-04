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

function clientBudgetIdentity(address: string | undefined): string {
  if (!address) return "unknown";
  if (!address.includes(":")) {
    const octets = address.split(".");
    if (
      octets.length !== 4 ||
      octets.some(
        (part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255
      )
    )
      return "unknown";
    return `ipv4:${octets.join(".")}`;
  }
  // URL's IPv6 parser handles compression and embedded IPv4 consistently.
  // Reject URL syntax (including ports and zone IDs) before parsing a literal.
  if (!/^[0-9a-f:.]+$/i.test(address)) return "unknown";
  try {
    const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [left, right] = host.split("::");
    const start = left ? left.split(":") : [];
    const end = right ? right.split(":") : [];
    const parts =
      right === undefined
        ? start
        : [...start, ...Array(8 - start.length - end.length).fill("0"), ...end];
    const words = parts.map((part) => parseInt(part, 16));
    // IPv4-mapped addresses share the native IPv4 allowance.
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return `ipv4:${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    }
    return `ipv6:${words
      .slice(0, 4)
      .map((word) => word.toString(16))
      .join(":")}/64`;
  } catch {
    return "unknown";
  }
}

export function previewGitHub(
  c: Context<{ Bindings: CloudflareBindings }>
): PreviewGitHub {
  // CF supplies this header at the edge; never trust X-Forwarded-For.
  // Missing addresses share a conservative allowance.
  const client = clientBudgetIdentity(c.req.header("CF-Connecting-IP"));
  let remaining = MAX_REQUEST_SUBREQUESTS;
  return {
    token: c.env.GITHUB_TOKEN,
    reserve: async () => {
      if (remaining === 0) return false;
      // Consume before awaiting so concurrent calls cannot exceed the ceiling.
      remaining--;
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
