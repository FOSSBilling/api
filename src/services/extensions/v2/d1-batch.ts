// drizzle-orm 0.45.2's D1 batch() throws "Cannot read properties of
// undefined (reading 'bind')" for any db.run(sql`...`) item that has bound
// params (confirmed via an isolated repro against real D1 - its
// prepared-query wrapper for raw sql lacks the .stmt property batch()
// unconditionally reads). Statements that need changes()-gating or
// correlated subqueries the query builder can't express, and therefore
// have to be batched together as raw sql, go through the underlying D1
// client directly instead (Drizzle's documented $client escape hatch) -
// this converts a hand-written {sql, params} pair, or a query builder's
// own .toSQL() output, into a real D1PreparedStatement for that.
export function toD1Statement(
  client: D1Database,
  query: { sql: string; params: readonly unknown[] }
): D1PreparedStatement {
  return client.prepare(query.sql).bind(...query.params);
}
