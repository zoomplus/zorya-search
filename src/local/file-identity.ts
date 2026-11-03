import { z } from 'zod'

const maxFileIdentityDigits = 39

const persistedFileIdentity = z.union([
  z.number().int().nonnegative().refine(Number.isSafeInteger),
  z.string().regex(new RegExp(`^(?:0|[1-9][0-9]{0,${maxFileIdentityDigits - 1}})$`, 'u')),
]).transform((value) => BigInt(value))

export const fileIdentitySchema = z.object({
  dev: persistedFileIdentity,
  ino: persistedFileIdentity,
}).strict()

export interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

export function serializeFileIdentity(identity: FileIdentity): { dev: string; ino: string } {
  if (identity.dev < 0n || identity.ino < 0n) throw new Error('LOCAL_FILE_IDENTITY_INVALID')
  const dev = identity.dev.toString(10)
  const ino = identity.ino.toString(10)
  if (dev.length > maxFileIdentityDigits || ino.length > maxFileIdentityDigits)
    throw new Error('LOCAL_FILE_IDENTITY_INVALID')
  return { dev, ino }
}
