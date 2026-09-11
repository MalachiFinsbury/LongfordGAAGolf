/**
 * An in-memory stand-in for the supabase-js client.
 *
 * The app leans on PostgREST semantics that matter to correctness — an update
 * that matches nothing returns no row, `.is("x", null)` is how a draft is
 * proven unclaimed, a duplicate primary key is what makes the webhook ledger
 * idempotent. A hand-rolled `vi.fn()` per call site would assert that we called
 * Supabase, not that the filters mean what the code assumes. This double
 * actually applies them.
 */

export type Row = Record<string, unknown>;

export type SupabaseError = { message: string; code?: string } | null;

export type Result<T = unknown> = { data: T; error: SupabaseError };

type Op = "select" | "insert" | "update" | "delete";

type Filter =
  | { kind: "eq" | "neq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: null }
  | { kind: "or"; clauses: Filter[] };

/** Which column makes a row unique, so inserts can conflict like the real table. */
const PRIMARY_KEY: Record<string, string> = {
  registrations: "id",
  stripe_events: "id",
};

function matches(row: Row, filter: Filter): boolean {
  switch (filter.kind) {
    case "eq":
      // PostgREST compares as text over the wire, so 5 and "5" are the same
      // filter. Nulls never satisfy `eq` — that is what `is` is for.
      if (row[filter.column] === null || row[filter.column] === undefined) return false;
      return String(row[filter.column]) === String(filter.value);
    case "neq":
      if (row[filter.column] === null || row[filter.column] === undefined) return true;
      return String(row[filter.column]) !== String(filter.value);
    case "is":
      return row[filter.column] === null || row[filter.column] === undefined;
    case "or":
      return filter.clauses.some((c) => matches(row, c));
  }
}

/** Parses the PostgREST `or=` mini-syntax the app uses, e.g. `a.is.null,b.eq.x`. */
function parseOr(expression: string): Filter {
  const clauses = expression.split(",").map((part): Filter => {
    const [column, operator, ...rest] = part.trim().split(".");
    const raw = rest.join(".");
    if (operator === "is") return { kind: "is", column, value: null };
    if (operator === "eq") return { kind: "eq", column, value: raw };
    if (operator === "neq") return { kind: "neq", column, value: raw };
    throw new Error(`FakeSupabase: unsupported or() operator "${operator}"`);
  });
  return { kind: "or", clauses };
}

export type CallRecord = {
  table: string;
  op: Op;
  payload?: Row;
  columns?: string;
};

type FailureKey = string;

class QueryBuilder<T = unknown> implements PromiseLike<Result<T>> {
  private filters: Filter[] = [];
  private singleRow = false;
  private selected = false;
  private orderBy: { column: string; ascending: boolean } | null = null;
  /** Recorded so a test can assert which columns a query asked for. */
  private columns = "*";
  private rowLimit: number | null = null;

  constructor(
    private db: FakeSupabase,
    private table: string,
    private op: Op,
    private payload?: Row
  ) {}

  select(columns = "*") {
    this.columns = columns;
    this.selected = true;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }

  is(column: string, value: null) {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  or(expression: string) {
    this.filters.push(parseOr(expression));
    return this;
  }

  order(column: string, opts: { ascending?: boolean } = {}) {
    this.orderBy = { column, ascending: opts.ascending ?? true };
    return this;
  }

  limit(n: number) {
    this.rowLimit = n;
    return this;
  }

  maybeSingle() {
    this.singleRow = true;
    return this;
  }

  single() {
    this.singleRow = true;
    return this;
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((value: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private run(): Result<T> {
    this.db.calls.push({
      table: this.table,
      op: this.op,
      payload: this.payload,
      columns: this.columns,
    });

    const injected = this.db.takeFailure(this.table, this.op);
    if (injected) return { data: null as T, error: injected };

    const rows = this.db.table(this.table);
    const hit = (row: Row) => this.filters.every((f) => matches(row, f));

    switch (this.op) {
      case "insert": {
        const record = { ...(this.payload as Row) };
        const pk = PRIMARY_KEY[this.table];
        if (pk && rows.some((r) => r[pk] === record[pk])) {
          // An Error instance carrying `code`, because that is what
          // supabase-js hands back: PostgrestError extends Error, and callers
          // branch on both its `code` and on `instanceof Error`.
          return {
            data: null as T,
            error: Object.assign(
              new Error(
                `duplicate key value violates unique constraint "${this.table}_pkey"`
              ),
              { code: "23505" }
            ),
          };
        }
        rows.push(record);
        return this.shape([record]);
      }

      case "select": {
        let found = rows.filter(hit);
        if (this.rowLimit !== null) found = found.slice(0, this.rowLimit);
        if (this.orderBy) {
          const { column, ascending } = this.orderBy;
          found = [...found].sort((a, b) => {
            const av = String(a[column] ?? "");
            const bv = String(b[column] ?? "");
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        return this.shape(found);
      }

      case "update": {
        const touched: Row[] = [];
        for (const row of rows) {
          if (!hit(row)) continue;
          Object.assign(row, this.payload);
          touched.push(row);
        }
        return this.shape(touched);
      }

      case "delete": {
        const removed: Row[] = [];
        for (let i = rows.length - 1; i >= 0; i--) {
          if (!hit(rows[i])) continue;
          removed.unshift(...rows.splice(i, 1));
        }
        return this.shape(removed);
      }
    }
  }

  private shape(rows: Row[]): Result<T> {
    if (this.singleRow) return { data: (rows[0] ? { ...rows[0] } : null) as T, error: null };
    // Without `.select()` PostgREST returns no body — mirrored here so a test
    // cannot accidentally rely on data the real client would not have sent.
    if (!this.selected && this.op !== "select") return { data: null as T, error: null };
    return { data: rows.map((r) => ({ ...r })) as T, error: null };
  }
}

export class FakeSupabase {
  private tables = new Map<string, Row[]>();
  private failures = new Map<FailureKey, { error: SupabaseError; once: boolean }>();
  private rpcImpls = new Map<string, (args: Row) => Result<unknown>>();

  /** Every query run against this client, in order, for assertions. */
  calls: CallRecord[] = [];
  rpcCalls: Array<{ name: string; args: Row }> = [];

  rpc = (name: string, args: Row): Promise<Result<unknown>> => {
    this.rpcCalls.push({ name, args });
    const impl = this.rpcImpls.get(name);
    if (!impl) return Promise.resolve({ data: null, error: null });
    return Promise.resolve(impl(args));
  };

  from(table: string) {
    return {
      select: (columns?: string) =>
        new QueryBuilder(this, table, "select").select(columns ?? "*"),
      insert: (payload: Row) => new QueryBuilder(this, table, "insert", payload),
      update: (payload: Row) => new QueryBuilder(this, table, "update", payload),
      delete: () => new QueryBuilder(this, table, "delete"),
    };
  }

  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  /** Put rows in place before exercising a flow. */
  seed(table: string, rows: Row[]): void {
    this.table(table).push(...rows.map((r) => ({ ...r })));
  }

  /** The current contents of a table — deliberately a copy. */
  rows<T = Row>(table: string): T[] {
    return this.table(table).map((r) => ({ ...r })) as T[];
  }

  row<T = Row>(table: string, id: string): T | undefined {
    const pk = PRIMARY_KEY[table] ?? "id";
    const found = this.table(table).find((r) => r[pk] === id);
    return found ? ({ ...found } as T) : undefined;
  }

  onRpc(name: string, impl: (args: Row) => Result<unknown>) {
    this.rpcImpls.set(name, impl);
  }

  /** Make the next matching query fail, the way a dropped connection would. */
  failOnce(table: string, op: Op, error: SupabaseError) {
    this.failures.set(`${table}:${op}`, { error, once: true });
  }

  /** Make every matching query fail until reset. */
  failAlways(table: string, op: Op, error: SupabaseError) {
    this.failures.set(`${table}:${op}`, { error, once: false });
  }

  takeFailure(table: string, op: Op): SupabaseError {
    const key = `${table}:${op}`;
    const entry = this.failures.get(key);
    if (!entry) return null;
    if (entry.once) this.failures.delete(key);
    return entry.error;
  }

  reset() {
    this.tables.clear();
    this.failures.clear();
    this.rpcImpls.clear();
    this.calls = [];
    this.rpcCalls = [];
  }
}
