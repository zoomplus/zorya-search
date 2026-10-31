export interface QueryResult<Row = Record<string, unknown>> { rows: Row[]; rowCount: number }
export interface QueryableDatabase {
  query<Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResult<Row>>
  exec(sql: string): Promise<unknown>
  transaction<T>(operation: (client: QueryableDatabase) => Promise<T>, signal?: AbortSignal): Promise<T>
}
export interface OwnedDatabase extends QueryableDatabase { close(): Promise<void>; readonly kind: 'embedded' | 'postgres' }
