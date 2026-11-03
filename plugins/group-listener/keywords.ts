/** Persona interest-keyword loading and matching for group triggers. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULT_KEYWORDS = [
  '股票', '股市', '期货', 'K线', '大盘', '行情', '保证金', '爆仓',
  '仓位', '止损', '多头', '空头', '基金', '财报', '加息', '降息',
  '漫画', '分镜', '截稿', '画稿', '旧货市场', '旧楼', '招牌', '年糕',
]

export function loadKeywords(file: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'))
    const values: unknown[] = Array.isArray(parsed?.keywords) ? parsed.keywords : []
    const keywords = values
      .filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== '')
      .map((value: string) => value.trim())
    return keywords.length > 0 ? [...new Set(keywords)] : DEFAULT_KEYWORDS
  } catch {
    return DEFAULT_KEYWORDS
  }
}

export function matchKeyword(text: string, keywords: string[]): string | null {
  const value = String(text ?? '').toLocaleLowerCase()
  if (value === '') return null
  for (const keyword of keywords) {
    const needle = String(keyword ?? '').trim().toLocaleLowerCase()
    if (needle !== '' && value.includes(needle)) return keyword
  }
  return null
}
