import { createRequire } from 'node:module'

interface PackageManifest {
  name?: unknown
  version?: unknown
}

const manifest = createRequire(import.meta.url)('../package.json') as PackageManifest

export const PACKAGE_NAME = 'zorya-search'

if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string')
  throw new Error('PACKAGE_MANIFEST_INVALID')

export const PACKAGE_VERSION = manifest.version
