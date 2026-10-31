import { z } from 'zod'

// Сохраняет форму UUID, принимаемую исходной границей Zod 3.
export const legacyUuidSchema = z.string().regex(/^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i)
