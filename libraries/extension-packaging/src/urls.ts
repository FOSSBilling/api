import { z } from "zod";

// Restricts to http(s) — z.url() alone accepts any scheme,
// including javascript:/data:, which is unsafe for fields a consumer may
// render as a link or image src.
export const httpUrl = () =>
  z
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "must use http or https"
    });

// Local S3/public endpoints use HTTP; deployed endpoints must keep HTTPS.
export function isLocalDevelopmentUrl(
  url: URL,
  environment: string | undefined
) {
  return (
    environment === "development" &&
    ["http:", "https:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}
