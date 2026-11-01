export class CodeContextError extends Error {
  constructor(
    readonly code: 'STALE_SNAPSHOT' | 'MANDATORY_BUDGET' | 'CLOSED' | 'LIMIT' | 'TIMEOUT',
  ) {
    super(`Code context operation failed: ${code}`)
    this.name = 'CodeContextError'
  }
}
