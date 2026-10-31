import { spawn } from 'node:child_process'
import { CodeIndexError } from './errors.js'

export async function runGit(
  root: string,
  args: string[],
  options: { maxOutputBytes: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<string | null> {
  options.signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let length = 0
    let failure: Error | undefined
    let commandMissing = false
    let escalationTimer: NodeJS.Timeout | undefined
    const stop = (error: Error) => {
      if (failure) return
      failure = error
      child.kill('SIGTERM')
      escalationTimer = setTimeout(() => child.kill('SIGKILL'), 250)
    }
    const timeout = setTimeout(
      () => stop(new CodeIndexError('CODE_INDEX_GIT_TIMEOUT')),
      options.timeoutMs ?? 5000,
    )
    const onAbort = () => stop(new CodeIndexError('CODE_INDEX_CANCELLED'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > options.maxOutputBytes) stop(new CodeIndexError('CODE_INDEX_GIT_OUTPUT_LIMIT'))
      else if (!failure) chunks.push(chunk)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') commandMissing = true
      else stop(new CodeIndexError('CODE_INDEX_GIT_FAILED'))
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (escalationTimer) clearTimeout(escalationTimer)
      options.signal?.removeEventListener('abort', onAbort)
      if (failure) reject(failure)
      else
        resolvePromise(
          !commandMissing && code === 0 ? Buffer.concat(chunks).toString('utf8') : null,
        )
    })
  })
}
