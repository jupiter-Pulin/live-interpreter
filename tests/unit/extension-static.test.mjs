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
