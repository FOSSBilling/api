import { vi } from "vitest";

export function suppressConsole() {
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;

  console.error = vi.fn();
  console.log = vi.fn();
  console.warn = vi.fn();

  return () => {
    console.error = originalError;
    console.log = originalLog;
    console.warn = originalWarn;
  };
}

export function createMockFetchResponse(data: unknown, ok = true) {
  return {
    ok,
    json: async () => data,
    text: async () => JSON.stringify(data),
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error"
  };
}

/**
 * Returns a graphql mock implementation that builds a synthetic batch response
 * from the aliases in the query. Pass null for composerJson to simulate missing
 * files, or rawBlobText to return a specific string (e.g. malformed JSON).
 */
export function createGraphQLImplementation(
  composerJson: Record<string, unknown> | null,
  rawBlobText?: string
) {
  return async (query: string) => {
    const aliasMatches = [...query.matchAll(/(\w+): object\(expression:/g)];
    const repoData: Record<string, { text: string } | null> = {};
    for (const [, alias] of aliasMatches) {
      if (rawBlobText !== undefined) {
        repoData[alias] = { text: rawBlobText };
      } else {
        repoData[alias] = composerJson
          ? { text: JSON.stringify(composerJson) }
          : null;
      }
    }
    return { repository: repoData };
  };
}

export function setupGitHubApiMock(
  ghRequest: {
    mockImplementation: (fn: (route: string) => Promise<unknown>) => void;
  },
  graphqlFn: {
    mockImplementation: (fn: (query: string) => Promise<unknown>) => void;
  },
  githubReleases: unknown[],
  composerJson: Record<string, unknown>
) {
  ghRequest.mockImplementation(async (route: string) => {
    if (route === "GET /repos/{owner}/{repo}/releases") {
      return { data: githubReleases };
    }
    throw new Error("Unexpected route");
  });

  graphqlFn.mockImplementation(createGraphQLImplementation(composerJson));
}
