import { z } from "zod";

// Restricts to http(s) — z.string().url() alone accepts any scheme,
// including javascript:/data:, which is unsafe for fields a consumer may
// render as a link or image src.
export const httpUrl = () =>
  z
    .string()
    .max(2048)
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "must use http or https"
    });
