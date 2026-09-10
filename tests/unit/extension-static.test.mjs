import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { OUTPUT_LANGUAGES, ORIGINAL, ORIGINAL_LABEL } from '../../src/shared/languages.mjs'

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/extension')

// 接线层文件：判定逻辑一律在 /shared，这些文件只允许搬运
const WIRING = ['background.js', 'offscreen.js', 'meet-mute.js']

function read(file) {
  return readFile(path.join(EXT, file), 'utf8')
}

async function readManifest() {
  return JSON.parse(await read('manifest.json'))
}

// 从 marker 起取一个花括号配平的代码块
function blockFrom(src, marker) {
  const start = src.indexOf(marker)
  assert.ok(start >= 0, `未找到 ${marker}`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`无法定位 ${marker} 的块边界`)
}

// 去掉所有顶层函数声明后剩下的即「顶层代码」（import / const / 监听器注册 / 启动调用）
function topLevel(src) {
  return src.replace(/^(?:async )?function [\s\S]*?^}$/gm, '')
}

test('AC-115 manifest：权限集合、站点匹配、入口与最低版本逐项固定', async () => {
  const manifest = await readManifest()
  assert.equal(manifest.manifest_version, 3)
  assert.deepEqual(new Set(manifest.permissions), new Set(['offscreen', 'nativeMessaging', 'storage', 'sidePanel', 'notifications']))
  assert.equal(manifest.permissions.length, 5, '不得夹带额外权限')
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*'])
  assert.equal(manifest.content_scripts.length, 1)
  assert.deepEqual(manifest.content_scripts[0], {
    matches: ['https://meet.google.com/*'],
    js: ['meet-mute.js'],
    run_at: 'document_idle',
  })
  assert.equal(manifest.web_accessible_resources, undefined, '不得暴露任何资源给网页')
  assert.equal(manifest.background.type, 'module')
  assert.equal(manifest.background.service_worker, 'background.js')
  assert.ok(typeof manifest.key === 'string' && manifest.key.length > 0)
  assert.equal(manifest.action.default_popup, 'popup.html')
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html')
  assert.equal(manifest.options_ui.page, 'options.html')
  assert.equal(manifest.minimum_chrome_version, '116')
})

test('AC-119 接线层不得内联判定：无 BlackHole / label 空判 / 令牌路径字面量', async () => {
  for (const file of WIRING) {
    const src = await read(file)
    assert.ok(!src.includes('BlackHole'), `${file} 不得出现 BlackHole 字面量（设备判定在 device-preflight）`)
    assert.ok(!/label\s*===?\s*['"]{2}/.test(src), `${file} 不得自行判断 label 是否为空`)
    assert.ok(!src.includes('/api/session-token'), `${file} 不得内联令牌端点路径（应经 selectSessionEndpoint）`)
  }
})

test('AC-119/AC-142 background.js 的状态只经 runtime-state 转换，没有字段赋值', async () => {
  const src = await read('background.js')
  for (const field of ['phase', 'bridge', 'startStep', 'meetingMuted']) {
    // 允许 === / !== 比较，禁止赋值
    const assignment = new RegExp(`\\b${field}\\s*=(?![=>])`)
    assert.ok(!assignment.test(src), `background.js 不得出现 ${field} = 赋值，状态一律由 runtime-state 转换产生`)
  }
  assert.ok(/from '\/shared\/runtime-state\.mjs'/.test(src), '状态转换必须来自 shared')
  for (const fn of ['connectRequested', 'bridgeConnected', 'bridgeFailed', 'requestStart', 'hostReady', 'started', 'requestStop', 'stopped', 'failed', 'meetingMute', 'planRecovery', 'badgeFor']) {
    assert.ok(src.includes(fn), `background.js 必须使用 runtime-state 的 ${fn}`)
  }
})

test('AC-121 每次写 runtime 都同步刷新角标，角标值只来自 badgeFor', async () => {
  const src = await read('background.js')
  const dispatch = blockFrom(src, 'async function dispatch(')
  assert.ok(/badgeFor\(state\)/.test(dispatch), 'dispatch 必须用 badgeFor 求角标')
  assert.ok(/setBadgeText\(/.test(dispatch) && /setBadgeBackgroundColor\(/.test(dispatch))
  assert.ok(/storage\.session\.set\(/.test(dispatch))
  // 只有 dispatch 一处写 runtime，也只有它刷角标
  assert.equal((src.match(/storage\.session\.set\(/g) ?? []).length, 1, 'runtime 只允许经 dispatch 落盘')
  assert.equal((src.match(/setBadgeText\(/g) ?? []).length, 1)
})

test('AC-125 密钥不落盘：session 的 server 只经 stripSecrets，local 不含 launchToken', async () => {
  const src = await read('background.js')
  assert.ok(/storage\.session\.set\(\{ runtime: \{ \.\.\.state, server: stripSecrets\(state\.server\) \} \}\)/.test(src))
  const localWrites = [...src.matchAll(/storage\.local\.set\(([\s\S]{0,120}?)\)\n/g)].map((m) => m[1])
  assert.ok(localWrites.length > 0)
  for (const write of localWrites) {
    assert.ok(!write.includes('launchToken'), `storage.local 写入不得含 launchToken：${write}`)
    assert.ok(!write.includes('runtime'), 'runtime 不得持久化')
  }
  assert.ok(!/storage\.local\.set\([^)]*server/.test(src))
})

test('AC-122/AC-139 顶层与安装/启动钩子绝不占用设备', async () => {
  const src = await read('background.js')
  const occupying = ['createDocument(', 'connectNative(', "'li:connect'", "'li:start'"]

  for (const hook of ['chrome.runtime.onInstalled.addListener(', 'chrome.runtime.onStartup.addListener(']) {
    const body = blockFrom(src, hook)
    for (const call of occupying) {
      assert.ok(!body.includes(call), `${hook} 中不得出现 ${call}`)
    }
  }
  for (const call of occupying) {
    assert.ok(!topLevel(src).includes(call), `顶层代码中不得出现 ${call}`)
  }

  // 唤醒后的恢复分派完全由 planRecovery 决定，且不含建桥/开启动作
  const boot = blockFrom(src, 'async function boot(')
  assert.ok(/planRecovery\(\{/.test(boot), 'SW 顶层恢复必须调用 planRecovery')
  for (const action of ['fail-bridge', 'fail-translation', 'reconnect-host']) {
    assert.ok(boot.includes(action), `boot 必须处理 ${action}`)
  }
  for (const call of ["'li:connect'", "'li:start'", 'createDocument(']) {
    assert.ok(!boot.includes(call), `恢复流程不得 ${call}`)
  }
})

test('AC-123 翻译层失败不自动重连；桥失败与翻译失败分开处理', async () => {
  const src = await read('background.js')
  assert.ok(!/setInterval\(/.test(src), 'SW 不得有轮询重连循环')
  assert.ok(!/retry|reconnectLoop/i.test(blockFrom(src, 'async function failTranslation(')), '翻译层失败后不得自动重连')
  const failBridge = blockFrom(src, 'async function failBridge(')
  assert.ok(/disconnectHost\(\)/.test(failBridge), '桥失败必须一并撤掉宿主')
  assert.ok(/bridgeFailed\(state, error\)/.test(failBridge))
  const failTranslation = blockFrom(src, 'async function failTranslation(')
  assert.ok(/'li:stop'/.test(failTranslation), '翻译层失败只撤翻译层')
  assert.ok(!/'li:disconnect'/.test(failTranslation), '翻译层失败绝不撤桥')
})

test('AC-145 通知只在就绪/翻译失败/桥失败三处发出，正文只来自纯函数', async () => {
  const src = await read('background.js')
  const calls = [...src.matchAll(/chrome\.notifications\.create\(([\s\S]*?)\n  \}\)/g)].map((m) => m[0])
  assert.equal(calls.length, 3, `通知必须恰好三处，实际 ${calls.length} 处`)

  const ready = calls.find((c) => c.includes('NOTIFY.ready'))
  const failed = calls.find((c) => c.includes('NOTIFY.translationFailed'))
  const bridge = calls.find((c) => c.includes('NOTIFY.bridgeFailed'))
  assert.ok(ready && failed && bridge, '三处通知的 id 必须来自 NOTIFY')
  assert.ok(/message: readyCopy\(/.test(ready), '就绪通知正文只能来自 readyCopy')
  assert.ok(/message: failureCopy\(\{ kind: 'translation'/.test(failed))
  assert.ok(/message: failureCopy\(\{ kind: 'bridge'/.test(bridge))
  for (const call of calls) {
    assert.ok(/iconUrl: 'icons\/icon128\.png'/.test(call) || call.includes('NOTIFICATION_STYLE'))
  }
  // stopped / disconnected 不通知
  assert.ok(!/chrome\.notifications/.test(blockFrom(src, 'async function stop(')))
  assert.ok(!/chrome\.notifications/.test(blockFrom(src, 'async function disconnectAll(')))
})

test('AC-131/AC-132 上行暂停：SW 只转发，离屏只经 forwardMicAudio 门控', async () => {
  const sw = await read('background.js')
  assert.ok(/'li:set-uplink-paused'/.test(sw), 'SW 必须把静音态转成上行暂停消息')
  const applyMute = blockFrom(sw, 'async function applyMeetingMute(')
  assert.ok(/state\.phase !== 'on'/.test(applyMute), 'phase 不为 on 时只更新静音态，不发离屏消息')
  assert.ok(/uplinkResumed\(state\)/.test(applyMute), '重建完成后必须把上行标回 running')
  assert.ok(/'li:start'[\s\S]{0,200}uplinkPaused: state\.meetingMuted === true/.test(sw), '开启时 uplinkPaused 必须等于当前静音态')

  const off = await read('offscreen.js')
  assert.ok(/import \{[^}]*forwardMicAudio[^}]*\} from '\/shared\/audio-routing\.mjs'/s.test(off))
  const gates = off.match(/forwardMicAudio\(\{ muted: uplinkPaused/g) ?? []
  assert.equal(gates.length, 2, '上行的送音与译文入队都必须经 forwardMicAudio 门控')
  const pause = blockFrom(off, 'function applyPauseGate(')
  assert.ok(/player\.flush\(\)/.test(pause), '暂停时必须清空已排队的上行译文')
  assert.ok(/holdFloorFull\(uplinkPaused\)/.test(pause), '暂停期间上行直通必须保持 1.0')
})

test('AC-133 上行挂起：暂停期间被对端关闭只报 uplink-suspended 并置空以便重建', async () => {
  const off = await read('offscreen.js')
  const handler = blockFrom(off, 'function onSessionEvent(')
  assert.ok(/directionId === 'uplink' && uplinkPaused/.test(handler), '只有暂停中的上行才算挂起')
  assert.ok(/emit\('uplink-suspended'/.test(handler))
  assert.ok(/stopDirection\('uplink'\)/.test(handler), '挂起必须置空会话，取消静音时才好重建')
  const resume = blockFrom(off, 'async function setUplinkPaused(')
  assert.ok(/live\.uplink === null/.test(resume) && /startDirection\('uplink'\)/.test(resume), '恢复时按需重建上行')
})

test('AC-110 passthrough 方向的分支只看 plan 的 mode', async () => {
  const off = await read('offscreen.js')
  const start = blockFrom(off, 'async function startDirection(')
  assert.ok(/direction\.mode !== 'translate'/.test(start), 'passthrough 判定只以 mode 为条件')
  assert.ok(/if \(direction\.mode !== 'translate'\) return/.test(start), 'passthrough 直接返回：不建会话、不采集')
  const before = start.indexOf("direction.mode !== 'translate'")
  assert.ok(start.indexOf('openTranslationSession') > before, 'mode 判定必须在建会话之前')
  assert.ok(start.indexOf('startCapture(') > before, 'mode 判定必须在采集之前')
})

test('AC-143 就绪判定：startDirection 必须先等 open 再 startCapture，且在途启动可作废', async () => {
  const off = await read('offscreen.js')
  const start = blockFrom(off, 'async function startDirection(')
  const waitOpen = start.indexOf("session.on('open'")
  const capture = start.indexOf('startCapture(')
  assert.ok(waitOpen >= 0, 'startDirection 必须等会话的 open 事件')
  assert.ok(capture >= 0, 'startDirection 必须起采集')
  assert.ok(waitOpen < capture, '等 open 的代码必须排在 startCapture( 之前：open 之前就采集等于白烧设备与额度')

  // 每个 await 之后都要确认这次启动还算数：否则 li:stop 之后仍会占设备、覆盖 live[id]
  assert.ok(/const mine = epoch/.test(start), 'startDirection 必须在入口快照世代号')
  assert.equal(
    (start.match(/mine !== epoch/g) ?? []).length,
    2,
    'open 之后与写 live 之前各要比一次世代号'
  )
  const live = start.indexOf('live[directionId] = {')
  assert.ok(start.lastIndexOf('mine !== epoch') < live, '最后一次世代号比对必须在写 live 之前')

  const stop = blockFrom(off, 'function stopTranslation(')
  assert.ok(/cancelPendingStarts\(\)/.test(stop), '撤翻译层必须作废在途启动')
  const disconnect = blockFrom(off, 'function disconnectBridge(')
  assert.ok(/cancelPendingStarts\(\)/.test(disconnect), '撤桥必须作废在途启动')
  // 桥的建立必须幂等：devicechange 重试会再发一次 li:connect
  // （connectBridge 的参数是解构模式，blockFrom 取不到函数体，这里按出现位置判定）
  const connectAt = off.indexOf('async function connectBridge(')
  const resetAt = off.indexOf('disconnectBridge()', connectAt)
  const enumerateAt = off.indexOf('enumerateAudioDevices(', connectAt)
  assert.ok(resetAt >= 0 && resetAt < enumerateAt, 'connectBridge 必须先收尾旧桥再枚举设备，否则每次重试叠一套占用')
})

test('AC-136/AC-119 离屏的直通约束只经 buildFloorConstraints', async () => {
  const off = await read('offscreen.js')
  assert.ok(/import \{[^}]*buildFloorConstraints[^}]*\} from '\/shared\/audio-routing\.mjs'/s.test(off))
  const calls = off.match(/getUserMedia\(([^)]*)\)/g) ?? []
  assert.equal(calls.length, 1, '离屏只应有一处 getUserMedia（建直通路）')
  assert.ok(/getUserMedia\(buildFloorConstraints\(inputId, direction\.inputRole\)\)/.test(off))
  assert.ok(/preflight\(devices,/.test(off), '设备角色分配必须经 preflight')
  assert.ok(/resolveSinkId\(/.test(off), '输出设备必须按方向表解析')
})

test('AC-144 Meet 探测脚本只读：不写 DOM、不联网、不碰媒体、不监听输入', async () => {
  const src = await read('meet-mute.js')
  const forbidden = [
    'createElement',
    'appendChild',
    'insertBefore',
    'innerHTML',
    'outerHTML',
    'textContent =',
    'style.',
    'setAttribute',
    'classList',
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'getUserMedia',
    'mediaDevices',
    "addEventListener('click'",
    "addEventListener('keydown'",
    "addEventListener('keyup'",
  ]
  for (const token of forbidden) {
    assert.ok(!src.includes(token), `meet-mute.js 不得出现 ${token}`)
  }
  assert.ok(src.includes('MutationObserver'), '必须靠 MutationObserver 感知变化')
  assert.ok(src.includes('chrome.runtime.sendMessage'), '必须向本扩展上报')
  const sends = [...src.matchAll(/chrome\.runtime\.sendMessage\(([\s\S]*?)\)\n/g)].map((m) => m[1])
  assert.equal(sends.length, 1, '只允许一处上报')
  assert.ok(sends[0].includes("type: 'li:meeting-mute'") && sends[0].includes("to: 'sw'"))
  assert.ok(/pagehide/.test(src), '离开页面时必须把静音态标为未知')
  assert.ok(/querySelectorAll\('\[data-is-muted\]'\)/.test(src))
  // SW 不 sendResponse，返回的 Promise 必须接住：每秒一次上报的 unhandled rejection 会刷满会议页控制台
  assert.ok(
    /chrome\.runtime\.sendMessage\([^\n]*\)\??\.catch\(/.test(src),
    '上报必须接住返回的 Promise（SW 不 sendResponse，否则每次上报都留一条 unhandled rejection）'
  )
})

test('AC-144/AC-119 静音判定只经 parseMeetMuteState，且只信任 Meet 标签的上报', async () => {
  const sw = await read('background.js')
  assert.ok(/parseMeetMuteState\(\{ buttons: message\.buttons \}\)/.test(sw), '静音判定必须调用 shared 纯函数')
  assert.ok(/resolveMeetingMuted\(muteReports\)/.test(sw), '多标签取值必须经 resolveMeetingMuted')
  assert.ok(
    /sender\.tab\?\.url\?\.startsWith\(MEET_ORIGIN\)/.test(sw) && /MEET_ORIGIN = 'https:\/\/meet\.google\.com\/'/.test(sw),
    'SW 必须校验上报来自 Meet 标签页'
  )
  assert.ok(/chrome\.tabs\.onRemoved\.addListener/.test(sw), '标签关闭必须移除该标签的上报记录')
  // 探测脚本自身不含判定（经典内容脚本不能 import，判定放在 SW 侧）
  const probe = await read('meet-mute.js')
  assert.ok(!/data-is-muted['"]\s*\)\s*===/.test(probe), 'meet-mute.js 不得自行比较静音属性')
  assert.ok(!probe.includes('mic_off'), 'meet-mute.js 不得内联图标连字判定')
})

test('AC-135 接线层不含语言码与语言标签字面量', async () => {
  const codes = [...OUTPUT_LANGUAGES.map((l) => l.id), ORIGINAL]
  const labels = [...OUTPUT_LANGUAGES.map((l) => l.label), ORIGINAL_LABEL]
  for (const file of WIRING) {
    const src = await read(file)
    for (const code of codes) {
      assert.ok(!new RegExp(`['"]${code}['"]`).test(src), `${file} 不得出现语言码字面量 '${code}'`)
    }
    for (const label of labels) {
      assert.ok(!src.includes(label), `${file} 不得出现语言标签字面量「${label}」`)
    }
  }
})

test('AC-072 消息纪律：每条消息带 to，非己方消息返回 false', async () => {
  for (const [file, self] of [
    ['background.js', 'sw'],
    ['offscreen.js', 'offscreen'],
  ]) {
    const src = await read(file)
    assert.ok(
      new RegExp(`message\\?\\.to !== '${self}'\\) return false`).test(src),
      `${file} 必须忽略并 return false 非己方消息`
    )
    const sends = [...src.matchAll(/sendMessage\(\{([\s\S]*?)\}\)/g)].map((m) => m[1])
    for (const payload of sends) {
      assert.ok(/to: '(sw|offscreen)'/.test(payload) || /\.\.\.message, to: 'offscreen'/.test(payload), `缺少 to 字段：${payload}`)
    }
  }
})

// ---------------------------------------------------------------- 面板与选项页

const UI_FILES = ['panel.js', 'options.js']

// 「panel.js 或其模板」= 面板脚本 + 两个 HTML + 它直接 import 的 shared 模块
async function panelSurface() {
  const parts = await Promise.all([
    read('panel.js'),
    read('popup.html'),
    read('sidepanel.html'),
    readFile(path.join(EXT, '..', 'shared', 'runtime-state.mjs'), 'utf8'),
    readFile(path.join(EXT, '..', 'shared', 'languages.mjs'), 'utf8'),
  ])
  return parts.join('\n')
}

test('AC-106 面板只渲染 storage，不做状态判定也不碰设备', async () => {
  const src = await read('panel.js')
  for (const forbidden of ['getUserMedia', 'enumerateDevices', 'connectNative', 'chrome.offscreen', 'chrome.notifications']) {
    assert.ok(!src.includes(forbidden), `panel.js 不得出现 ${forbidden}`)
  }
  for (const field of ['meetingMuted', 'bridge', 'startStep']) {
    assert.ok(!new RegExp(`\\b${field}\\b`).test(src), `panel.js 不得对 ${field} 做任何判定`)
  }
  assert.ok(/statusCopy\(\{ \.\.\.runtime/.test(src), '文案、按钮、步骤、可见性全部来自 statusCopy')
  assert.ok(/chrome\.storage\.onChanged\.addListener/.test(src), '必须靠 storage.onChanged 刷新')
  assert.ok(/chrome\.storage\.local\.get\('settings'\)/.test(src) && /chrome\.storage\.session\.get\('runtime'\)/.test(src))
  // 面板只发消息，不自己动手
  const sends = [...src.matchAll(/type: '(li:[a-z-]+)'/g)].map((m) => m[1])
  assert.deepEqual(new Set(sends), new Set(['li:power', 'li:disconnect', 'li:set-settings']), `面板只允许发这三种消息：${sends}`)
  assert.ok(!sends.includes('li:connect'), 'UI 层没有只建桥不翻译的入口')
})

test('AC-136 UI 层不得存在「只建桥不翻译」的入口', async () => {
  for (const file of UI_FILES) {
    const src = await read(file)
    assert.ok(!src.includes('li:connect'), `${file} 不得发送 li:connect`)
    assert.ok(!src.includes('li:start'), `${file} 不得发送 li:start`)
  }
})

test('AC-126 弹窗与侧栏只加载 panel.js 与 panel.css，无内联脚本', async () => {
  for (const file of ['popup.html', 'sidepanel.html']) {
    const html = await read(file)
    assert.ok(/<script type="module" src="panel\.js"><\/script>/.test(html), `${file} 必须以模块方式加载 panel.js`)
    assert.equal((html.match(/<script/g) ?? []).length, 1, `${file} 只允许一个 script 标签`)
    assert.ok(!/<script(?![^>]*src=)/.test(html), `${file} 不得有内联脚本`)
    assert.ok(/<link rel="stylesheet" href="panel\.css" \/>/.test(html))
    assert.ok(!/<style/.test(html), `${file} 不得内联样式表`)
  }
  const popup = await read('popup.html')
  const side = await read('sidepanel.html')
  assert.ok(popup.includes('data-surface="popup"'))
  assert.ok(side.includes('data-surface="side"'))
})

test('AC-126 面板文案齐备：状态、步骤、字段、按钮、脚注', async () => {
  const surface = await panelSurface()
  const required = [
    '会议同传',
    'Live Interpreter',
    '未连接会议音频',
    '无法连接会议音频',
    '同传已关闭',
    '原声直通中',
    '同传进行中',
    '无法开启同传',
    '原声仍在直通',
    '会议已静音',
    '暂停翻译你的话',
    '未感知到会议静音',
    '正在恢复翻译…',
    '正在连接会议音频…',
    '正在启动本地翻译服务…',
    '正在连接翻译服务…',
    '你想听的语言',
    '对方听的语言',
    '开启同传',
    '关闭同传',
    '断开会议音频',
    '正在开启…',
    '正在关闭…',
    '开启时会在本机启动翻译服务，对话会多一到两秒延迟。',
  ]
  for (const text of required) {
    assert.ok(surface.includes(text), `面板缺少文案「${text}」`)
  }
})

test('AC-126 面板不含被否决的入口：你说的语言 / 只连接原声 / 重试 / 静音 / 恢复翻译按钮', async () => {
  const surface = await panelSurface()
  for (const text of ['你说的语言', '只连接原声', '重试']) {
    assert.ok(!surface.includes(text), `面板不得出现「${text}」`)
  }
  // 「静音」「恢复翻译」只能作为说明文字出现，不得成为按钮
  const { PRIMARY_START, PRIMARY_STOP, PRIMARY_STARTING, PRIMARY_STOPPING, SECONDARY_DISCONNECT, HINTS } = await import(
    '../../src/shared/runtime-state.mjs'
  )
  const buttonLabels = [PRIMARY_START, PRIMARY_STOP, PRIMARY_STARTING, PRIMARY_STOPPING, SECONDARY_DISCONNECT, ...Object.values(HINTS)]
  for (const label of buttonLabels) {
    for (const banned of ['静音', '恢复翻译', '重试']) {
      assert.ok(!label.includes(banned), `按钮文案「${label}」不得含「${banned}」`)
    }
  }
  // HTML 里的按钮文本一律由脚本填充，模板中没有写死的操作按钮
  const popup = await read('popup.html')
  const buttonTexts = [...popup.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1].trim()).filter(Boolean)
  assert.deepEqual(buttonTexts, [], `按钮文案必须来自 statusCopy，模板里不得写死：${buttonTexts}`)
})

test('AC-126/AC-135 两个下拉各 14 项，且面板不含语言码或标签字面量', async () => {
  const { TARGET_CHOICES } = await import('../../src/shared/languages.mjs')
  assert.equal(TARGET_CHOICES.length, 14, '13 种输出语言 + 原声')
  assert.equal(TARGET_CHOICES.filter((c) => c.separated).length, 1, '只有原声那一项前面有分隔线')
  assert.equal(TARGET_CHOICES[13].id, ORIGINAL)

  const src = await read('panel.js')
  assert.ok(/for \(const choice of TARGET_CHOICES\)/.test(src), '下拉必须按 TARGET_CHOICES 渲染')
  const codes = [...OUTPUT_LANGUAGES.map((l) => l.id), ORIGINAL]
  for (const file of UI_FILES) {
    const text = await read(file)
    for (const code of codes) {
      assert.ok(!new RegExp(`['"]${code}['"]`).test(text), `${file} 不得出现语言码字面量 '${code}'`)
    }
    for (const label of [...OUTPUT_LANGUAGES.map((l) => l.label), ORIGINAL_LABEL]) {
      assert.ok(!text.includes(label), `${file} 不得出现语言标签字面量「${label}」`)
    }
  }
})

test('AC-128 弹窗 380×600、侧栏铺满，深色默认且跟随系统浅色', async () => {
  const css = await read('panel.css')
  assert.ok(/body\[data-surface='popup'\][\s\S]{0,120}width: 380px;[\s\S]{0,60}height: 600px;/.test(css))
  assert.ok(/body\[data-surface='side'\][\s\S]{0,120}width: 100%;[\s\S]{0,60}min-height: 100vh;/.test(css))
  assert.ok(/@media \(prefers-color-scheme: light\)/.test(css), '系统浅色时必须切浅色 token')
  assert.ok(/--danger: #f07a68/.test(css) && /--warning: #e6b45a/.test(css), '错误与暂停用设计稿的色值')
  assert.ok(/@keyframes li-pulse/.test(css), '进行中需要脉冲绿点')
  assert.ok(/@keyframes li-spin/.test(css) && /\.power\[data-busy='true'\] \.spinner/.test(css), '开启中按钮内需要转圈')
  assert.ok(/max-height: 280px/.test(css), '下拉需要在面板内滚动')
  assert.ok(!/@import|https?:\/\//.test(css), '不得加载远程字体或样式')
})

test('AC-129 选项页：设备角色按 kind 过滤、衬底三选一、本地服务自检后立即断开', async () => {
  const src = await read('options.js')
  assert.ok(/enumerateAudioDevices\(\)/.test(src), '打开页面即枚举设备以触发授权提示')
  assert.ok(/for \(const role of DEVICE_ROLES\)/.test(src), '四张设备卡必须按 DEVICE_ROLES 渲染')
  assert.ok(/devices\.filter\(\(d\) => d\.kind === role\.kind\)/.test(src), '下拉必须按端点类型过滤')
  assert.ok(/DEFAULT_ASSIGNMENT_LABEL/.test(src), '首项必须是「（默认分配）」')
  assert.ok(/preflight\(devices, settings\.deviceOverrides\)/.test(src), '结论必须来自 preflight')
  assert.ok(/deviceOverrides: overrides/.test(src), '改动即写 settings.deviceOverrides')
  assert.ok(/for \(const entry of FLOOR_LEVEL_LABELS\)/.test(src), '衬底档位来自 floor.mjs')
  assert.ok(/floorLevel: entry\.level/.test(src))

  const probe = blockFrom(src, 'function probeHost(')
  assert.ok(/connectNative\(HOST_NAME\)/.test(probe))
  assert.ok(/frame\?\.type !== 'ready'/.test(probe) && /port\.disconnect\(\)/.test(probe), '拿到 ready 后必须立即断开端口')
  assert.ok(/classifyNativeError\(/.test(probe), '失败原因必须经 classifyNativeError')

  const html = await read('options.html')
  assert.ok(html.includes('npm run install:host'), '失败时要给出安装命令')
  assert.ok(html.includes('在 Google Meet 里静音时会自动暂停翻译你的话；其它会议平台暂不支持感知静音。'))
  assert.ok(html.includes('建议戴耳机'), '需要「建议耳机」提示')
  assert.ok(html.includes('模型可能不出声'), '需要同语言限制说明')
  assert.ok(!/自动连接/.test(html) && !/自动连接/.test(src), '不得出现自动连接开关')
})

test('AC-128 「停靠到侧栏」必须同步调用 sidePanel.open，不得先 await 掉用户手势', async () => {
  const src = await read('panel.js')
  // 去掉注释再查：注释里本来就会提到 await 这件事
  const dock = blockFrom(src, "el('dock').addEventListener('click'").replace(/\/\/[^\n]*/g, '')
  assert.ok(/chrome\.sidePanel\.open\(/.test(dock), '停靠按钮必须打开侧栏')
  assert.ok(!/\bawait\b/.test(dock), 'sidePanel.open 需要用户手势，放在 await 之后手势已过期')
  assert.ok(!/async/.test(dock), '点击处理器不得是 async：第一个 await 就会丢掉手势')
  assert.ok(!/chrome\.tabs\.query/.test(dock), '不得为了拿 tabId 先查标签（而且本扩展没有 tabs 权限）')
  assert.ok(/windowId: chrome\.windows\.WINDOW_ID_CURRENT/.test(dock), '用当前窗口常量即可，无需异步取 tabId')
})

test('AC-103 重开弹窗直接从 storage 渲染，不打扰正在跑的管道', async () => {
  const src = await read('panel.js')
  const load = blockFrom(src, 'async function load(')
  assert.ok(/chrome\.storage\.local\.get\('settings'\)/.test(load) && /chrome\.storage\.session\.get\('runtime'\)/.test(load))
  assert.ok(/render\(\)/.test(load), '读到两份数据后直接渲染')
  assert.ok(!/sendMessage/.test(load), '打开弹窗不得向 SW 发任何消息（重开弹窗不能扰动管道）')
  // 顶层只做渲染准备与订阅，没有任何会改变运行态的调用
  assert.ok(!/li:power|li:disconnect|li:set-settings/.test(load))
})
