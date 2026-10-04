import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { wrapD1WithHook } from "./db-interceptor";
import { request as ghRequest } from "@octokit/request";
import { getExtensionsDb } from "../../../../src/lib/db";
import { reserveClaimVerification } from "../../../../src/services/extensions/v2/db/claim-verification-budget";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  seedUnownedDeveloper,
  mockGithubEntity,
  post
} from "./harness";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);
setupExtensionsV2Tests();
const path = "/extensions/v2/developers/target/claim";

describe("durable claim verification budgets", () => {
  it("stops mismatches before GitHub, including after changing targets", async () => {
    const headers = await authHeaders("attacker");
    await db
      .prepare("UPDATE users SET github_login = 'other' WHERE id = 'attacker'")
      .run();
    mockGithubEntity("User");
    for (let i = 0; i < 4; i++) {
      await seedUnownedDeveloper(`target-${i}`);
      const response = await post(
        `/extensions/v2/developers/target-${i}/claim`,
        headers,
        {}
      );
      expect(response.status).toBe(i < 3 ? 403 : 429);
    }
    expect(ghRequest).toHaveBeenCalledTimes(3);
  });

  it("retains quota after cancellation while preserving manual review", async () => {
    const headers = await authHeaders("claimant");
    await seedUnownedDeveloper("target");
    for (let i = 0; i < 3; i++) {
      const response = await post(path, headers, {});
      expect(response.status).toBe(201);
      const body = (await response.json()) as { result: { id: string } };
      expect(
        (
          await post(
            `/extensions/v2/developers/claims/${body.result.id}/cancel`,
            headers
          )
        ).status
      ).toBe(200);
    }
    expect((await post(path, headers, {})).status).toBe(429);
    expect(ghRequest).toHaveBeenCalledTimes(3);
  });

  it("retains attempts on upstream failures and fails closed when the aggregate budget is full", async () => {
    const headers = await authHeaders("claimant");
    await seedUnownedDeveloper("target");
    vi.mocked(ghRequest).mockRejectedValue(
      Object.assign(new Error("Upstream failure"), { status: 500 })
    );
    for (let i = 0; i < 3; i++)
      expect((await post(path, headers, {})).status).toBe(503);
    expect((await post(path, headers, {})).status).toBe(429);
    expect(ghRequest).toHaveBeenCalledTimes(3);
    await db
      .prepare(
        "UPDATE claim_verification_budgets SET attempts = 300 WHERE key = 'global'"
      )
      .run();
    await seedUnownedDeveloper("independent-target");
    expect(
      (
        await post(
          "/extensions/v2/developers/independent-target/claim",
          await authHeaders("independent"),
          {}
        )
      ).status
    ).toBe(429);
    expect(ghRequest).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the budget write fails", async () => {
    const headers = await authHeaders("claimant");
    await seedUnownedDeveloper("target");
    env.DB_EXTENSIONS = wrapD1WithHook(db, (query) => {
      if (query.includes("INSERT INTO claim_verification_budgets"))
        throw new Error("budget write failed");
    });
    expect((await post(path, headers, {})).status).toBe(500);
    expect(ghRequest).not.toHaveBeenCalled();
  });

  it("shares the normalized developer budget between accounts", async () => {
    const database = getExtensionsDb(db);
    for (let i = 0; i < 3; i++) {
      expect(
        await reserveClaimVerification(database, `user-${i}`, "Target")
      ).toBe(true);
    }
    expect(await reserveClaimVerification(database, "another", "target")).toBe(
      false
    );
  });

  it("bounds independent accounts and targets by the aggregate budget", async () => {
    const database = getExtensionsDb(db);
    await db
      .prepare(
        "INSERT INTO claim_verification_budgets VALUES ('global', 299, unixepoch() + 3600)"
      )
      .run();
    expect(await reserveClaimVerification(database, "user-1", "target-1")).toBe(
      true
    );
    expect(await reserveClaimVerification(database, "user-2", "target-2")).toBe(
      false
    );
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM claim_verification_budgets WHERE key = 'account:user-2'"
      )
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("atomically admits only remaining capacity under concurrency", async () => {
    const database = getExtensionsDb(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reserveClaimVerification(database, "same-user", `target-${i}`)
      )
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    const row = await db
      .prepare(
        "SELECT attempts FROM claim_verification_budgets WHERE key = 'global'"
      )
      .first<{ attempts: number }>();
    expect(row?.attempts).toBe(3);
  });

  it("renews expired budgets using database time", async () => {
    const database = getExtensionsDb(db);
    for (let i = 0; i < 3; i++)
      expect(await reserveClaimVerification(database, "user", "target")).toBe(
        true
      );
    expect(await reserveClaimVerification(database, "user", "target")).toBe(
      false
    );
    await db
      .prepare(
        "UPDATE claim_verification_budgets SET expires_at = unixepoch() - 1 WHERE key != 'global'"
      )
      .run();
    expect(await reserveClaimVerification(database, "user", "target")).toBe(
      true
    );
  });
});
