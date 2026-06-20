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
 * Creates a fetch mock that handles GitHub GraphQL requests for PHP version
 * batch fetching. Parses aliases from the query and maps each to the provided
 * composerJson content (or null to simulate missing files).
 * Pass rawBlobText to return a specific string as the blob text (e.g. malformed JSON).
 */
export function createGraphQLFetchMock(
  composerJson: Record<string, unknown> | null,
  rawBlobText?: string
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.includes("api.github.com/graphql")) {
      const body = JSON.parse((options?.body as string) || "{}") as {
        query?: string;
      };
      const query = body.query ?? "";
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

      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: repoData } })
      };
    }

    throw new Error(`Unexpected fetch call to ${urlStr}`);
  });
}

export function setupGitHubApiMock(
  ghRequest: {
    mockImplementation: (fn: (route: string) => Promise<unknown>) => void;
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

  vi.stubGlobal("fetch", createGraphQLFetchMock(composerJson));
}
