// A handful of tests need to inject a fault or a concurrent mutation at an
// exact point mid-request (e.g. "ownership changes between this read and
// that guarded write") - something no amount of pre-request DB state setup
// can reproduce, since the race is *inside* a single request's own
// execution. This wraps a real D1Database so a hook fires immediately
// before every statement actually executes (including each statement
// inside a .batch() call, in the order they'd run) - tests match on the
// SQL text to run a side effect or throw, then everything still executes
// for real against the same D1 database.
type Hook = (
  sql: string
) => Promise<D1PreparedStatement | void> | D1PreparedStatement | void;

class HookedStatement implements D1PreparedStatement {
  constructor(
    private readonly real: D1Database,
    readonly sqlText: string,
    private readonly hook: Hook,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): D1PreparedStatement {
    return new HookedStatement(this.real, this.sqlText, this.hook, params);
  }

  target(): D1PreparedStatement {
    return this.real.prepare(this.sqlText).bind(...this.params);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    await this.hook(this.sqlText);
    return this.target().run<T>();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    await this.hook(this.sqlText);
    return this.target().all<T>();
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    await this.hook(this.sqlText);
    return this.target().first<T>(colName as never);
  }

  raw: D1PreparedStatement["raw"] = (async (
    ...args: Parameters<D1PreparedStatement["raw"]>
  ) => {
    await this.hook(this.sqlText);
    return (
      this.target().raw as (
        ...args: Parameters<D1PreparedStatement["raw"]>
      ) => ReturnType<D1PreparedStatement["raw"]>
    )(...args);
  }) as D1PreparedStatement["raw"];
}

export function wrapD1WithHook(real: D1Database, hook: Hook): D1Database {
  return {
    prepare(sqlText: string): D1PreparedStatement {
      return new HookedStatement(real, sqlText, hook);
    },
    async batch<T = unknown>(
      statements: D1PreparedStatement[]
    ): Promise<D1Result<T>[]> {
      // D1's real batch() is one opaque, atomic round-trip - there's no way
      // for a client-side wrapper to observe or inject a fault "between"
      // individual statements inside it, since they're never executed
      // one-at-a-time from the caller's perspective. So every statement's
      // hook necessarily fires before the batch is sent, not interleaved
      // with its (real, all-or-nothing) execution. A hook may return a real
      // prepared statement to replace the matching batch item, allowing a
      // constraint failure to occur at that exact position inside D1. Hooks
      // that only perform a side effect still run before the batch starts.
      const hooked = statements as unknown as HookedStatement[];
      const replacements: (D1PreparedStatement | void)[] = [];
      for (const statement of hooked) {
        replacements.push(await hook(statement.sqlText));
      }
      return real.batch<T>(
        hooked.map(
          (statement, index) => replacements[index] ?? statement.target()
        )
      );
    },
    dump: () => real.dump(),
    exec: (query: string) => real.exec(query),
    withSession: (constraintOrBookmark?: string) =>
      real.withSession(constraintOrBookmark)
  };
}
