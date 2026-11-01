import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import ts from 'typescript'

const bundleBrand: unique symbol = Symbol('zorya.typescript-library-bundle')
const POLICY_VERSION = 'typescript-lib-closure-v1'
const MAX_ASSETS = 128
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_ASSET_BYTES = 3 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

const entryLibraries = new Map<string, string>([
  ['es5', 'es5'],
  ['es2015', 'es2015'],
  ['es2020', 'es2020'],
  ['es2022', 'es2022'],
  ['es2023', 'es2023'],
])

export type TypeScriptLibrarySelector = 'es5' | 'es2015' | 'es2020' | 'es2022' | 'es2023'

export interface TypeScriptLibraryAsset {
  readonly name: string
  readonly content: string
  readonly sha256: string
}

/** Неизменяемый снимок проверенных lib-файлов, созданный явным загрузчиком. */
export interface TypeScriptLibraryBundle {
  readonly [bundleBrand]: true
  readonly typescriptVersion: string
  readonly selector: TypeScriptLibrarySelector
  readonly profileId: string
  readonly assets: readonly TypeScriptLibraryAsset[]
}

export interface LoadTypeScriptLibraryBundleOptions {
  signal: AbortSignal
  selector?: TypeScriptLibrarySelector
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function profileId(version: string, assets: readonly TypeScriptLibraryAsset[]): string {
  const rows = assets
    .map((asset) => `${asset.name}\0${asset.sha256}`)
    .sort()
  return digest(`${POLICY_VERSION}\0${version}\0${rows.join('\n')}`)
}

function checkedName(name: string): string {
  if (!/^lib\.[a-z0-9.-]+\.d\.ts$/u.test(name))
    throw new TypeError(`Unsupported TypeScript library asset name: ${name}`)
  return name
}

function libraryReferences(content: string, name: string): string[] {
  const references = ts.preProcessFile(content, true, false)
  if (references.referencedFiles.length > 0 || references.typeReferenceDirectives.length > 0)
    throw new TypeError(`TypeScript library contains a path or types reference: ${name}`)
  return references.libReferenceDirectives.map((reference) => {
    if (!/^[a-z0-9.-]+$/u.test(reference.fileName))
      throw new TypeError(`Invalid TypeScript lib reference in ${name}`)
    return checkedName(`lib.${reference.fileName}.d.ts`)
  })
}

async function locateLibraryDirectory(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const require = createRequire(import.meta.url)
  const entry = await realpath(require.resolve('typescript'))
  const directory = await realpath(dirname(entry))
  signal.throwIfAborted()
  if (basename(directory) !== 'lib')
    throw new TypeError('Resolved TypeScript package has no canonical lib directory')
  return directory
}

async function readLibraryAsset(
  libraryDirectory: string,
  name: string,
  remainingBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  checkedName(name)
  signal.throwIfAborted()
  const candidate = resolve(libraryDirectory, name)
  const canonical = await realpath(candidate)
  if (canonical !== candidate || dirname(canonical) !== libraryDirectory || basename(canonical) !== name)
    throw new TypeError(`TypeScript library asset escapes its installed lib directory: ${name}`)

  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(candidate, constants.O_RDONLY | noFollow)
  try {
    signal.throwIfAborted()
    const canonicalAfterOpen = await realpath(candidate)
    if (canonicalAfterOpen !== candidate)
      throw new TypeError(`TypeScript library asset changed during open: ${name}`)
    const details = await handle.stat({ bigint: true })
    if (!details.isFile()) throw new TypeError(`TypeScript library asset is not a regular file: ${name}`)
    if (details.size > MAX_ASSET_BYTES)
      throw new RangeError(`TypeScript library asset exceeds ${MAX_ASSET_BYTES} bytes: ${name}`)
    if (details.size > remainingBytes)
      throw new RangeError(`TypeScript library closure exceeds ${MAX_TOTAL_BYTES} bytes`)

    const chunks: Buffer[] = []
    const expectedSize = Number(details.size)
    let position = 0
    while (position < expectedSize) {
      signal.throwIfAborted()
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, expectedSize - position))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) throw new TypeError(`Unexpected end of TypeScript library asset: ${name}`)
      chunks.push(buffer.subarray(0, bytesRead))
      position += bytesRead
      await new Promise<void>((resume) => setImmediate(resume))
    }
    signal.throwIfAborted()
    const overflowProbe = Buffer.allocUnsafe(1)
    const overflow = await handle.read(overflowProbe, 0, 1, position)
    const after = await handle.stat({ bigint: true })
    if (
      position !== expectedSize ||
      overflow.bytesRead !== 0 ||
      after.size !== details.size ||
      after.dev !== details.dev ||
      after.ino !== details.ino ||
      after.mtimeNs !== details.mtimeNs ||
      after.ctimeNs !== details.ctimeNs
    ) throw new TypeError(`TypeScript library asset changed while reading: ${name}`)
    return Buffer.concat(chunks, position)
  } finally {
    await handle.close()
  }
}

function validateClosure(
  selector: string,
  assets: readonly TypeScriptLibraryAsset[],
  signal?: AbortSignal,
): void {
  const byName = new Map(assets.map((asset) => [asset.name, asset]))
  const entry = entryLibraries.get(selector)
  if (!entry || !byName.has(`lib.${entry}.d.ts`))
    throw new TypeError(`TypeScript library bundle is missing its selector entry: ${selector}`)

  const reached = new Set<string>()
  const visiting = new Set<string>()
  const visit = (name: string): void => {
    signal?.throwIfAborted()
    if (visiting.has(name)) throw new TypeError(`Cyclic TypeScript library reference: ${name}`)
    if (reached.has(name)) return
    const asset = byName.get(name)
    if (!asset) throw new TypeError(`TypeScript library bundle has an incomplete reference closure: ${name}`)
    visiting.add(name)
    for (const dependency of libraryReferences(asset.content, name)) visit(dependency)
    visiting.delete(name)
    reached.add(name)
  }
  visit(`lib.${entry}.d.ts`)
  if (reached.size !== assets.length || assets.some((asset) => !reached.has(asset.name)))
    throw new TypeError('TypeScript library bundle contains assets outside its selector closure')
}

/** Явно читает замкнутый набор деклараций из lib-каталога установленного TypeScript. */
export async function loadTypeScriptLibraryBundle(
  options: LoadTypeScriptLibraryBundleOptions,
): Promise<TypeScriptLibraryBundle> {
  const selector = options.selector ?? 'es2023'
  const entry = entryLibraries.get(selector)
  if (!entry) throw new TypeError(`Unsupported TypeScript library selector: ${String(selector)}`)
  options.signal.throwIfAborted()
  const libraryDirectory = await locateLibraryDirectory(options.signal)
  const pending = [`lib.${entry}.d.ts`]
  const seen = new Set<string>()
  const assets = new Map<string, TypeScriptLibraryAsset>()
  let totalBytes = 0

  while (pending.length > 0) {
    options.signal.throwIfAborted()
    const name = checkedName(pending.shift()!)
    if (seen.has(name)) continue
    seen.add(name)
    if (seen.size > MAX_ASSETS) throw new RangeError(`TypeScript library closure exceeds ${MAX_ASSETS} assets`)

    const bytes = await readLibraryAsset(libraryDirectory, name, MAX_TOTAL_BYTES - totalBytes, options.signal)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_TOTAL_BYTES)
      throw new RangeError(`TypeScript library closure exceeds ${MAX_TOTAL_BYTES} bytes`)
    const content = bytes.toString('utf8')
    const source = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
    if (parseDiagnostics.length > 0)
      throw new TypeError(`Malformed TypeScript library declaration: ${name}`)
    const asset = Object.freeze({ name, content, sha256: digest(bytes) })
    assets.set(name, asset)
    pending.push(...libraryReferences(content, name).filter((reference) => !seen.has(reference)))
    await new Promise<void>((resume) => setImmediate(resume))
    options.signal.throwIfAborted()
  }

  const ordered = Object.freeze([...assets.values()].sort((left, right) => compareNames(left.name, right.name)))
  validateClosure(selector, ordered, options.signal)
  const bundle: TypeScriptLibraryBundle = {
    [bundleBrand]: true,
    typescriptVersion: ts.version,
    selector,
    profileId: profileId(ts.version, ordered),
    assets: ordered,
  }
  return Object.freeze(bundle)
}

/** Проверяет бренд, содержимое, хеши и замкнутость переданного снимка до компиляции. */
export function validateTypeScriptLibraryBundle(bundle: TypeScriptLibraryBundle, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  if (!bundle || bundle[bundleBrand] !== true || !Object.isFrozen(bundle) || !Object.isFrozen(bundle.assets))
    throw new TypeError('TypeScript library bundle was not produced as an immutable loader snapshot')
  if (bundle.typescriptVersion !== ts.version)
    throw new TypeError(`TypeScript library version mismatch: ${bundle.typescriptVersion}`)
  if (!entryLibraries.has(bundle.selector))
    throw new TypeError(`Unsupported TypeScript library selector: ${String(bundle.selector)}`)
  if (bundle.assets.length === 0 || bundle.assets.length > MAX_ASSETS)
    throw new RangeError(`TypeScript library asset count must be from 1 to ${MAX_ASSETS}`)

  let totalBytes = 0
  let previousName = ''
  for (const asset of bundle.assets) {
    signal?.throwIfAborted()
    checkedName(asset.name)
    if (!Object.isFrozen(asset) || typeof asset.content !== 'string' || typeof asset.sha256 !== 'string')
      throw new TypeError(`TypeScript library asset is not an immutable loader snapshot: ${asset.name}`)
    if (asset.name <= previousName) throw new TypeError('TypeScript library assets must be unique and sorted')
    previousName = asset.name
    const bytes = Buffer.byteLength(asset.content, 'utf8')
    if (bytes > MAX_ASSET_BYTES)
      throw new RangeError(`TypeScript library asset exceeds ${MAX_ASSET_BYTES} bytes: ${asset.name}`)
    totalBytes += bytes
    if (totalBytes > MAX_TOTAL_BYTES)
      throw new RangeError(`TypeScript library closure exceeds ${MAX_TOTAL_BYTES} bytes`)
    if (digest(asset.content) !== asset.sha256)
      throw new TypeError(`TypeScript library asset hash mismatch: ${asset.name}`)
  }
  validateClosure(bundle.selector, bundle.assets, signal)
  signal?.throwIfAborted()
  if (profileId(bundle.typescriptVersion, bundle.assets) !== bundle.profileId)
    throw new TypeError('TypeScript library profile identity mismatch')
}

export const TYPE_SCRIPT_LIBRARY_LIMITS = Object.freeze({
  assets: MAX_ASSETS,
  totalBytes: MAX_TOTAL_BYTES,
  assetBytes: MAX_ASSET_BYTES,
})
