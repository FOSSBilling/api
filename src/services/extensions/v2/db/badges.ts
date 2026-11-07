import { ZodError } from "zod";
import { and, isNotNull, isNull, sql } from "drizzle-orm";
import { ExtensionsDb } from "../../../../lib/db";
import { DatabaseResult } from "../../../../lib/interfaces";
import { latestRelease } from "../../../../lib/releases";
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

  async getByIdentifier(id: string): Promise<DatabaseResult<BadgeData>> {
    try {
      // Select only badge fields so large README content does not affect badges.
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
            sql`LOWER(${extensions.identifier}) = LOWER(${id})`,
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

      const data = BadgeDataSchema.parse({
        releases: row.releases === null ? null : JSON.parse(row.releases),
        license: row.license === null ? null : JSON.parse(row.license)
      });
      return {
        data: {
          latestRelease: latestRelease(data.releases) ?? null,
          license: data.license
        },
        error: null
      };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError)
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
