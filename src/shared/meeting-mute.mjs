// Meet 静音态解析：从只读探测脚本收集到的按钮列表里判定麦克风是否静音。
// 选择器与判定规则集中在此文件，Meet 改版时只改这里；解析不出来一律返回 null
// （未知 → 不暂停，退化为「照常翻译」而不是误停）。

// Material 图标连字文本与界面语言无关，优先用它；aria-label 作兜底。
const ICON_TEXT = /\bmic(_off)?\b/i
const ARIA_TEXT = /microphone|麦克风|マイク|마이크/i

function stringOf(value) {
  return typeof value === 'string' ? value : ''
}

// 一趟扫描：取第一个命中按钮的可读静音属性；无命中或属性不可读都返回 null
function scan(list, matches) {
  for (const button of list) {
    if (!matches(button)) continue
    if (button.dataIsMuted === 'true') return true
    if (button.dataIsMuted === 'false') return false
  }
  return null
}

// 返回 true（已静音）/ false（未静音）/ null（找不到麦克风按钮或属性不可读）。
// 必须分两趟：参会者行与磁贴也带 data-is-muted，且 aria-label 里常含 microphone/麦克风。
// 逐按钮混合匹配时，排在真麦克风按钮之前的参会者元素会抢答——远端有人静音就会
// 静默暂停我们的上行。所以先用与界面语言无关的图标连字扫全部按钮，全不命中才用 aria 兜底。
export function parseMeetMuteState({ buttons } = {}) {
  const list = Array.isArray(buttons) ? buttons : []
  const byIcon = scan(list, (button) => ICON_TEXT.test(stringOf(button?.text)))
  if (byIcon !== null) return byIcon
  return scan(list, (button) => ARIA_TEXT.test(stringOf(button?.ariaLabel)))
}

// 多个会议标签时取最近一次上报；没有任何上报则未知
export function resolveMeetingMuted(reports) {
  const list = Array.isArray(reports) ? reports : []
  let latest = null
  for (const report of list) {
    if (!report) continue
    if (latest === null || (report.at ?? 0) >= (latest.at ?? 0)) latest = report
  }
  if (latest === null) return null
  return latest.muted === true || latest.muted === false ? latest.muted : null
}
