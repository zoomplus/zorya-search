import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Resolves the existing prefix of a possibly not-yet-created directory. */
export async function canonicalFuturePath(path: string): Promise<string> {
  const absolute = resolve(path)
  let cursor = absolute
  const missing: string[] = []

  while (true) {
    try {
      await lstat(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || cursor === dirname(cursor))
        throw error
      missing.push(basename(cursor))
      cursor = dirname(cursor)
      continue
    }
    // A dangling link or an inaccessible existing ancestor must fail closed.
    const prefix = await realpath(cursor)
    if (!(await stat(prefix)).isDirectory()) throw new Error('RUNTIME_PATH_NOT_DIRECTORY')
    return resolve(prefix, ...missing.reverse())
  }
}

export function isSameOrDescendantPath(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate)
  return (
    pathFromParent === '' ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== '..' &&
      !pathFromParent.startsWith(`..${sep}`))
  )
}
