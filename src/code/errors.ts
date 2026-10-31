export class CodeIndexError extends Error {
  readonly code: string
  constructor(code: string, message = code, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CodeIndexError'
    this.code = code
  }
}

export function codeError(code: string): CodeIndexError {
  return new CodeIndexError(code)
}
