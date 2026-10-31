export class SearchError extends Error {
  readonly code: string
  constructor(code: string, message = code, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SearchError'
    this.code = code
  }
}
export type SearchErrorFactory = (code: string, message: string) => Error
export const defaultSearchErrorFactory: SearchErrorFactory = (code, message) => new SearchError(code, message)
