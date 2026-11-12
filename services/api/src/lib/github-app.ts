import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { request } from "@octokit/request";
import type { PlatformContext } from "./context";
import { GitHubError } from "./github-errors";

export type GitHubClient = Pick<Octokit, "request" | "graphql">;
export type GitHubClientProvider = () => Promise<GitHubClient>;

const transport = {
  fetch: ((input, init) =>
    globalThis.fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000)
    })) satisfies typeof fetch
};

// Reuse Octokit's installation-token cache for the active credentials. Replacing
// the auth instance on a configuration change also drops its cached tokens.
let cached:
  | {
      clientId: string;
      installationId: string;
      privateKey: string;
      authenticate: ReturnType<typeof createAppAuth>;
    }
  | undefined;

export function githubClientProvider(
  platform: Pick<PlatformContext, "getEnv">
): GitHubClientProvider {
  let pending: Promise<GitHubClient> | undefined;
  return () => (pending ??= createClient(platform));
}

async function createClient(
  platform: Pick<PlatformContext, "getEnv">
): Promise<GitHubClient> {
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

  try {
    if (
      cached?.clientId !== clientId ||
      cached.installationId !== installationId ||
      cached.privateKey !== privateKey
    ) {
      cached = {
        clientId,
        installationId,
        privateKey,
        authenticate: createAppAuth({
          appId: clientId,
          privateKey,
          installationId,
          request: request.defaults({ request: transport })
        })
      };
    }
    // Request explicit scope before constructing the client: the automatic App
    // auth hook otherwise issues a token with the installation's full access.
    const { token } = await cached.authenticate({
      type: "installation",
      repositoryNames: ["FOSSBilling"],
      permissions: { contents: "read", actions: "read", pull_requests: "read" }
    });
    return new Octokit({
      auth: token,
      userAgent: "FOSSBilling-API",
      request: transport
    });
  } catch {
    // Never expose signing keys, tokens or SDK request/response objects in logs.
    // A token-endpoint 404 must not become a missing GitHub user or artifact.
    throw new GitHubError("GitHub App authentication is unavailable", 503);
  }
}
