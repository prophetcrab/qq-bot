import { h } from 'koishi'

export async function sendCommandReplies(session: any, replies: unknown): Promise<void> {
  const list = (Array.isArray(replies) ? replies : [])
    .filter((reply): reply is string => typeof reply === 'string' && reply.trim() !== '')
    .slice(0, 3)
  for (let index = 0; index < list.length; index += 1) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 250))
    await session.send(list[index])
  }
}

/** Send a game's rendered image when present, falling back to text. */
export async function sendGameResult(session: any, result: any): Promise<void> {
  const image = result?.image
  if (image && typeof image.data === 'string' && image.data !== '') {
    try {
      await session.send(h.image(Buffer.from(image.data, 'base64'), image.mime ?? 'image/png'))
      return
    } catch {
      // Fall through to the text result.
    }
  }
  await sendCommandReplies(session, result?.replies)
}
