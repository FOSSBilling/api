import { and, isNotNull, isNull, sql } from "drizzle-orm";
import { ExtensionsDb } from "../../../../lib/db";
import { DatabaseResult } from "../../../../lib/interfaces";
import { sortReleasesDescending } from "../../../../lib/releases";
import { BadgeDataSchema } from "../schemas/badges";
import { MAX_CONTENT_BYTES } from "../resource-limits";
import { databaseError } from "./errors";
import { extensions } from "./schema";

type BadgeData = {
  latestRelease: { tag: string; requires: { fossbilling: string } } | null;
  license: string;
};

export class ExtensionBadgesDatabase {
  constructor(private db: ExtensionsDb) {}

  async getById(id: string): Promise<DatabaseResult<BadgeData>> {
    try {
      // Keep this public, high-volume read independent of the full content,
      // selecting only bounded JSON fields and filtering hidden rows in SQL.
      const [row] = await this.db
        .select({
          releases: sql<
            string | null
          >`CASE WHEN length(CAST(${extensions.releases} AS BLOB)) <= ${MAX_CONTENT_BYTES} THEN ${extensions.releases} ELSE NULL END`,
          license: sql<
            string | null
          >`CASE WHEN length(CAST(${extensions.license} AS BLOB)) <= ${MAX_CONTENT_BYTES} THEN ${extensions.license} ELSE NULL END`
        })
        .from(extensions)
        .where(
          and(
            sql`LOWER(${extensions.id}) = LOWER(${id})`,
            isNotNull(extensions.publishedAt),
            isNull(extensions.delistedAt)
          )
        );
      if (!row)
        return {
          data: null,
          error: {
            code: "NOT_FOUND",
            message: `Cannot find extension by id: ${id}`
          }
        };

      const parsed = BadgeDataSchema.safeParse({
        releases: row.releases === null ? null : JSON.parse(row.releases),
        license: row.license === null ? null : JSON.parse(row.license)
      });
      if (!parsed.success)
        return {
          data: null,
          error: {
            code: "CONTENT_UNAVAILABLE",
            message: "Published badge fields require manual correction"
          }
        };
      return {
        data: {
          latestRelease:
            sortReleasesDescending(parsed.data.releases)[0] ?? null,
          license: parsed.data.license
        },
        error: null
      };
    } catch (error) {
      if (error instanceof SyntaxError)
        return {
          data: null,
          error: {
            code: "CONTENT_UNAVAILABLE",
            message: "Published badge fields require manual correction"
          }
        };
      return databaseError("extensionBadges.getById", error);
    }
  }
}
