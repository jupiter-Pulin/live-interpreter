// Google Meet 静音探测：只读。
//
// 只做三件事：读 [data-is-muted] 按钮的属性与图标文字、在快照变化时把这份原始列表
// 上报给 service worker、离开页面时上报空列表。静音判定本身在 shared 的
// parseMeetMuteState 里（由 SW 调用）——本文件不含任何判定逻辑。
//
// 绝不创建/修改任何 DOM 节点、绝不注入 UI、绝不访问网络与媒体设备、
// 绝不监听用户输入事件。解析不出来时 SW 得到 null（未知 → 不暂停），
// Meet 改版时退化为「照常翻译」而不是误停。
//
// 注意：manifest 里声明的内容脚本是经典脚本（AC-115 钉死 content_scripts 恰含
// matches/js/run_at 三个键），不能用 import；也不能靠 web_accessible_resources
// 动态 import。因此判定放在 SW 侧，本文件只搬运原始快照。

const POLL_MS = 1000
const THROTTLE_MS = 200

let lastSnapshot = null
let pending = null

function collect() {
  const buttons = []
  for (const el of document.querySelectorAll('[data-is-muted]')) {
    buttons.push({
      dataIsMuted: el.getAttribute('data-is-muted'),
      text: el.textContent,
      ariaLabel: el.getAttribute('aria-label'),
    })
  }
  return buttons
}

// 只在快照变化时上报：Meet 的 DOM 每秒变化上百次，这里只比较原始字符串，不做判定
function report(buttons) {
  const snapshot = JSON.stringify(buttons)
  if (snapshot === lastSnapshot) return
  lastSnapshot = snapshot
  try {
    // SW 不 sendResponse，返回的 Promise 必须接住：否则每次上报都留一个 unhandled rejection
    chrome.runtime.sendMessage({ type: 'li:meeting-mute', to: 'sw', platform: 'meet', buttons })?.catch(() => {})
  } catch {
    // 扩展被重载时端口失效，下一次变化再报
  }
}

function scan() {
  report(collect())
}

function schedule() {
  if (pending !== null) return
  pending = setTimeout(() => {
    pending = null
    scan()
  }, THROTTLE_MS)
}

new MutationObserver(schedule).observe(document.documentElement, {
  subtree: true,
  attributes: true,
  attributeFilter: ['data-is-muted'],
  childList: true,
})

// 兜底轮询：属性变化若被 Meet 以其它方式绕过，1s 内也能纠正
setInterval(scan, POLL_MS)

// 离开会议页 = 静音态不再可知（空列表 → SW 判为 null）
window.addEventListener('pagehide', () => report([]))

scan()
