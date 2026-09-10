// 语言目录：上游 gpt-realtime-translate 的 13 种输出语言 + 「原声（不翻译）」。
// 输入语言由上游自动识别，本目录只描述输出端，因此没有「你说的语言」。
// 所有界面上的语言标签都从这里取，接线层不得出现语言码或标签字面量。

export const OUTPUT_LANGUAGES = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'pt', label: 'Português' },
  { id: 'de', label: 'Deutsch' },
  { id: 'it', label: 'Italiano' },
  { id: 'ru', label: 'Русский' },
  { id: 'hi', label: 'हिन्दी' },
  { id: 'id', label: 'Bahasa Indonesia' },
  { id: 'vi', label: 'Tiếng Việt' },
]

export const ORIGINAL = 'original'
export const ORIGINAL_LABEL = '原声（不翻译）'

const BY_ID = new Map(OUTPUT_LANGUAGES.map((l) => [l.id, l.label]))

export function isOutputLanguage(id) {
  return BY_ID.has(id)
}

// 下拉可选项 = 13 种输出语言 + 原声
export function isTargetChoice(id) {
  return id === ORIGINAL || isOutputLanguage(id)
}

export function labelFor(id) {
  if (id === ORIGINAL) return ORIGINAL_LABEL
  return BY_ID.get(id) ?? ''
}

// 中文句子里夹拉丁/西里尔字母的标签时两侧补空格（「翻成 English 送进会议」），
// 中日韩与天城文标签不补（「翻成中文进你的耳机」）。文案生成只经此函数。
const SPACED_HEAD = /^[A-Za-zÀ-ɏͰ-ӿ]/
const SPACED_TAIL = /[A-Za-zÀ-ɏͰ-ӿ]$/

export function padLabel(label) {
  const text = typeof label === 'string' ? label : ''
  const head = SPACED_HEAD.test(text) ? ' ' : ''
  const tail = SPACED_TAIL.test(text) ? ' ' : ''
  return `${head}${text}${tail}`
}
