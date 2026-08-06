import { vi } from "vitest";

// The @octokit/request module shape every suite that touches GitHub mocks.
// vi.mock's hoisting is per-module, so each test file still declares its own
// vi.mock("@octokit/request", ...) — but the factory body lives here so the
// shape only has to be updated once when the octokit surface changes.
export function octokitRequestMock() {
  const endpoint = { DEFAULTS: {} };
  const derivedFn = Object.assign(vi.fn(), { defaults: vi.fn(), endpoint });
  const request = Object.assign(vi.fn(), {
    defaults: vi.fn().mockReturnValue(derivedFn),
    endpoint
  });
  return { request };
}
