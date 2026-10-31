import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodeIndexError } from './errors.js'
import type { CodeSourceIdentity } from './types.js'
import { runGit } from './git.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export async function identifyRoot(
  inputRoot: string,
  contentHash: string,
  signal?: AbortSignal,
): Promise<CodeSourceIdentity> {
  const root = await realpath(resolve(inputRoot)).catch((error: unknown) => {
    throw new CodeIndexError('CODE_INDEX_ROOT_UNAVAILABLE', 'CODE_INDEX_ROOT_UNAVAILABLE', {
      cause: error,
    })
  })
  const settled = await Promise.allSettled([
    runGit(root, ['rev-parse', '--git-common-dir'], {
      maxOutputBytes: 2_000_000,
      ...(signal ? { signal } : {}),
    }),
    runGit(root, ['rev-parse', '--absolute-git-dir'], {
      maxOutputBytes: 2_000_000,
      ...(signal ? { signal } : {}),
    }),
    runGit(root, ['branch', '--show-current'], {
      maxOutputBytes: 2_000_000,
      ...(signal ? { signal } : {}),
    }),
    runGit(root, ['rev-parse', 'HEAD'], {
      maxOutputBytes: 2_000_000,
      ...(signal ? { signal } : {}),
    }),
  ])
  const failed = settled.find((item) => item.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  const clean = (value: string | null | undefined) => value?.replace(/\r?\n$/u, '') ?? null
  const common = clean(settled[0]?.status === 'fulfilled' ? settled[0].value : null)
  const gitdir = clean(settled[1]?.status === 'fulfilled' ? settled[1].value : null)
  const branch = clean(settled[2]?.status === 'fulfilled' ? settled[2].value : null)
  const head = clean(settled[3]?.status === 'fulfilled' ? settled[3].value : null)
  const canonical = await realpath(root)
  const repoId = sha(
    common
      ? `git:${await realpath(resolve(root, common)).catch(() => resolve(root, common))}`
      : `directory:${canonical}`,
  ).slice(0, 32)
  const worktreeId = sha(`${repoId}\0${canonical}\0${gitdir ?? 'no-git'}`).slice(0, 32)
  const snapshotId = sha(`${repoId}\0${worktreeId}\0${branch ?? ''}\0${head ?? ''}\0${contentHash}`)
  return {
    repoId,
    worktreeId,
    root: canonical,
    branch: branch || null,
    head,
    snapshotId,
    contentHash,
  }
}

export { sha as codeSha256 }
