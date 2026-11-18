// Wrangler exposes these local buckets through its built-in S3 and public endpoints.
export default {
  fetch: () => new Response(null, { status: 404 })
};
