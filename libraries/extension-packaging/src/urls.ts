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
