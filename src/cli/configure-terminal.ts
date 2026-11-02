import { stdin, stderr } from 'node:process'
import { createInterface } from 'node:readline/promises'

export async function readHiddenSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('CONFIGURE_SECRET_TTY_REQUIRED')
  const priorRaw = stdin.isRaw
  const priorFlowing = stdin.readableFlowing
  stdin.setRawMode(true)
  let value = ''
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        if (settled) return
        settled = true
        stdin.removeListener('data', onData)
        stdin.removeListener('end', onEnd)
        stdin.removeListener('error', onError)
      }
      const onEnd = () => { cleanup(); reject(new Error('CONFIGURE_INPUT_CLOSED')) }
      const onError = () => { cleanup(); reject(new Error('CONFIGURE_INPUT_FAILED')) }
      const onData = (chunk: Buffer | string) => {
        for (const char of String(chunk)) {
          if (char === '\u0003' || char === '\u0004') {
            cleanup()
            reject(new Error('CONFIGURE_ABORTED'))
            return
          }
          if (char === '\r' || char === '\n') {
            cleanup()
            if (!value.trim()) reject(new Error('CONFIGURE_SECRET_EMPTY'))
            else resolve(value)
            return
          }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
          else if (char >= ' ' && char !== '\u007f') {
            if (Buffer.byteLength(value + char) > 8192) {
              cleanup()
              reject(new Error('CONFIGURE_SECRET_TOO_LARGE'))
              return
            }
            value += char
          }
        }
      }
      stdin.on('data', onData)
      stdin.once('end', onEnd)
      stdin.once('error', onError)
      stdin.resume()
      stderr.write(prompt)
    })
  } finally {
    stdin.setRawMode(priorRaw ?? false)
    if (priorFlowing === true) stdin.resume()
    else stdin.pause()
    stderr.write('\n')
  }
}

export async function confirmWatchedIndexing(): Promise<boolean> {
  if (!stdin.isTTY) return false
  const rl = createInterface({ input: stdin, output: stderr })
  try {
    const answer = await rl.question('Этот профиль может запустить платную индексацию уже наблюдаемых корней. Применить настройку и разрешить это? [y/N] ')
    return answer.trim().toLocaleLowerCase('en-US') === 'y' || answer.trim().toLocaleLowerCase('en-US') === 'yes'
  } finally {
    rl.close()
  }
}
