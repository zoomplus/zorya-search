import type { SearchErrorFactory } from '../core/errors.js'

export interface CompatibleSearchErrorConstructor<TError extends Error = Error> {
  new (code: string, message: string): TError
}

/** Подключает тип ошибки хоста, сохраняя instanceof и стабильные коды. */
export function createCompatibleErrorFactory<TError extends Error>(
  ErrorType: CompatibleSearchErrorConstructor<TError>,
): SearchErrorFactory {
  return (code, message) => new ErrorType(code, message)
}
