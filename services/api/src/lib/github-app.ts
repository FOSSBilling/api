import githubAppJwt from "universal-github-app-jwt";
import type { PlatformContext } from "./context";
import { GitHubError } from "./github-errors";

export type GitHubTokenProvider = () => Promise<string>;

// Cache resolved credentials only: an in-flight fetch belongs to its request
// context in Workers. Keep just the active configuration so key rotation also
// invalidates the cached token.
let cached:
  | {
      clientId: string;
      installationId: string;
      privateKey: string;
      token: string;
      expiresAt: number;
    }
  | undefined;

export function githubTokenProvider(
  platform: Pick<PlatformContext, "getEnv">
): GitHubTokenProvider {
  let pending: Promise<string> | undefined;
  return () => (pending ??= installationToken(platform));
}

async function installationToken(
  platform: Pick<PlatformContext, "getEnv">
): Promise<string> {
  const clientId = platform.getEnv("GITHUB_APP_CLIENT_ID");
  const installationId = platform.getEnv("GITHUB_APP_INSTALLATION_ID");
  const privateKey = platform.getEnv("GITHUB_APP_PRIVATE_KEY");
  if (
    !clientId ||
    !installationId ||
    !/^\d+$/.test(installationId) ||
    !privateKey
  ) {
    throw new GitHubError("GitHub App credentials are not configured", 503);
  }
  if (
    cached?.clientId === clientId &&
    cached.installationId === installationId &&
    cached.privateKey === privateKey &&
    cached.expiresAt > Date.now() + 60_000
  ) {
    return cached.token;
  }

  try {
    const { token: jwt } = await githubAppJwt({ id: clientId, privateKey });
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "FOSSBilling-API"
        },
        body: JSON.stringify({
          repositories: ["FOSSBilling"],
          permissions: {
            contents: "read",
            actions: "read",
            pull_requests: "read"
          }
        })
      }
    );
    if (!response.ok) throw new Error("Token request failed");
    const data = (await response.json()) as {
      token?: unknown;
      expires_at?: unknown;
    };
    const expiresAt =
      typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
    if (
      typeof data.token !== "string" ||
      !data.token ||
      !(expiresAt > Date.now() + 60_000)
    ) {
      throw new Error("Invalid token response");
    }
    cached = {
      clientId,
      installationId,
      privateKey,
      token: data.token,
      expiresAt
    };
    return data.token;
  } catch {
    // Never expose the signing key, JWT or GitHub's request/response objects in
    // the callers' logs. A token-endpoint 404 must not become an entity 404.
    throw new GitHubError("GitHub App authentication is unavailable", 503);
  }
}
