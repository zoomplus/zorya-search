export class CodeIndexError extends Error {
  readonly code: string
  readonly details?: Readonly<Record<string, string | number>>
  constructor(
    code: string,
    message = code,
    options?: ErrorOptions,
    details?: Readonly<Record<string, string | number>>,
  ) {
    super(message, options)
    this.name = 'CodeIndexError'
    this.code = code
    if (details) this.details = Object.freeze({ ...details })
  }
}

export function codeError(code: string): CodeIndexError {
  return new CodeIndexError(code)
}
