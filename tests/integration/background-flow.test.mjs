import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { buildDirections, DEFAULT_SETTINGS } from '../../src/shared/direction-plan.mjs'
import { readyCopy, failureCopy, BADGE_COLORS } from '../../src/shared/runtime-state.mjs'
import { USER_MESSAGES } from '../../src/shared/errors.mjs'

// service worker 的编排流程整体验证：用假的 chrome API 与假的离屏文档跑真正的
// background.js。真实音频图（getUserMedia / AudioContext / setSinkId）只能实机验证，
// 这里覆盖的是它上面的全部编排：冷启动分步、就绪与失败通知、桥与翻译层的隔离、
// Meet 静音暂停与恢复、断开、SW 唤醒后的恢复分派。
//
// 加载方式：background.js 里的 '/shared/x.mjs' 是扩展根绝对路径，Node 解析不了，
// 因此把 import 说明符改写成本仓库的 file:// 路径后再 import——除说明符外一字不改。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SHARED_URL = pathToFileURL(path.join(ROOT, 'src', 'shared')).href
const MEET_TAB = { id: 7, url: 'https://meet.google.com/abc-defg-hij' }
const READY_FRAME = {
  type: 'ready',
  port: 51234,
  backend: 'mock',
  mockWsUrl: 'ws://127.0.0.1:51235',
  launchToken: 'launch-token-must-not-leak',
  pid: 4242,
  version: '0.1.0',
}
const RUNNING = { downlink: { status: 'running', mode: 'translate' }, uplink: { status: 'running', mode: 'translate' } }

let loadCounter = 0

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settle(times = 12) {
  for (let i = 0; i < times; i++) await tick()
}

function createEnv({ session = {}, local = {}, offscreenExists = false } = {}) {
  const storage = { local: { ...local }, session: { ...session } }
  const notifications = []
  const badges = []
  const offscreenCalls = []
  const hostPorts = []
  const swListeners = []
  const tabRemovedListeners = []
  const connectListeners = []
  const lifecycle = { installed: [], startup: [] }
  let documentExists = offscreenExists

  const env = {
    notifications,
    badges,
    offscreenCalls,
    hostPorts,
    storage,
    // 默认的假离屏：什么都成功
    offscreen: async (message) => {
      if (message.type === 'li:connect') return { ok: true, roles: {}, labels: {} }
      if (message.type === 'li:start') return { ok: true, directions: RUNNING }
      if (message.type === 'li:set-uplink-paused') return { ok: true, restarted: [] }
      if (message.type === 'li:update-plan') return { ok: true, restarted: ['downlink'] }
      return { ok: true }
    },
    // 默认的假宿主：连上就发 ready
    connectNative: (port) => port.emit(READY_FRAME),
    runtime: () => storage.session.runtime,
    lastBadge: () => badges[badges.length - 1],
    hasDocument: () => documentExists,
    async toSw(message, sender = {}) {
      let response
      for (const listener of swListeners) {
        const kept = listener(message, sender, (value) => {
          response = value
        })
        if (kept === true) {
          for (let i = 0; i < 40 && response === undefined; i++) await tick()
        }
      }
      await settle()
      return response
    },
    async removeTab(tabId) {
      for (const listener of tabRemovedListeners) listener(tabId)
      await settle()
    },
    fireInstalled: async () => {
      for (const l of lifecycle.installed) l()
      await settle()
    },
    keepalivePort: null,
  }

  function makeNativePort() {
    const messageListeners = []
    const disconnectListeners = []
    const port = {
      posted: [],
      disconnected: false,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
      postMessage: (msg) => port.posted.push(msg),
      disconnect: () => {
        port.disconnected = true
        for (const fn of disconnectListeners) fn()
      },
      emit: (frame) => {
        for (const fn of messageListeners) fn(frame)
      },
      die: (message) => {
        env.chrome.runtime.lastError = message ? { message } : undefined
        for (const fn of disconnectListeners) fn()
        env.chrome.runtime.lastError = undefined
      },
    }
    return port
  }

  env.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => swListeners.push(fn) },
      onInstalled: { addListener: (fn) => lifecycle.installed.push(fn) },
      onStartup: { addListener: (fn) => lifecycle.startup.push(fn) },
      onConnect: { addListener: (fn) => connectListeners.push(fn) },
      connect: () => ({ onMessage: { addListener() {} }, postMessage() {} }),
      sendMessage: async (message) => {
        assert.equal(message.to, 'offscreen', '只允许向离屏文档主动发消息')
        offscreenCalls.push(message)
        return env.offscreen(message)
      },
      connectNative: (name) => {
        assert.equal(name, 'com.live_interpreter.host')
        const port = makeNativePort()
        hostPorts.push(port)
        queueMicrotask(() => env.connectNative(port))
        return port
      },
      getContexts: async () => (documentExists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
    },
    offscreen: {
      createDocument: async () => {
        documentExists = true
      },
      closeDocument: async () => {
        documentExists = false
      },
    },
    storage: {
      local: {
        get: async (key) => (storage.local[key] === undefined ? {} : { [key]: storage.local[key] }),
        set: async (patch) => Object.assign(storage.local, patch),
      },
      session: {
        get: async (key) => (storage.session[key] === undefined ? {} : { [key]: storage.session[key] }),
        set: async (patch) => Object.assign(storage.session, patch),
      },
    },
    action: {
      setBadgeText: async ({ text }) => badges.push({ text }),
      setBadgeBackgroundColor: async ({ color }) => {
        badges[badges.length - 1].color = color
      },
    },
    notifications: { create: (id, options) => notifications.push({ id, ...options }) },
    tabs: { onRemoved: { addListener: (fn) => tabRemovedListeners.push(fn) } },
    sidePanel: { setPanelBehavior: async () => {} },
  }

  env.connectKeepalive = async () => {
    const listeners = []
    const port = {
      name: 'li-keepalive',
      onMessage: { addListener: (fn) => fn && null },
      onDisconnect: { addListener: (fn) => listeners.push(fn) },
      postMessage: () => {},
      drop: async () => {
        for (const fn of listeners) fn()
        await settle()
      },
    }
    for (const fn of connectListeners) fn(port)
    env.keepalivePort = port
    await settle()
    return port
  }

  return env
}

// 只改写 import 说明符，其余源码原样运行
async function loadBackground(env) {
  const source = await readFile(path.join(ROOT, 'src', 'extension', 'background.js'), 'utf8')
  const rewritten = source.replace(/from '\/shared\//g, `from '${SHARED_URL}/`)
  assert.ok(rewritten.includes(SHARED_URL), '改写后必须指向本仓库的 shared')
  assert.equal(
    rewritten.replace(new RegExp(SHARED_URL, 'g'), '/shared').length,
    source.length,
    '除 import 说明符外不得改动任何字符'
  )
  const dir = await mkdtemp(path.join(tmpdir(), 'li-bg-'))
  const file = path.join(dir, `background-${loadCounter++}.mjs`)
  await writeFile(file, rewritten)
  globalThis.chrome = env.chrome
  await import(pathToFileURL(file).href)
  await settle()
  return env
}

async function powerOn(env) {
  return env.toSw({ type: 'li:power', to: 'sw', on: true })
}

test('AC-142/AC-101/AC-143 冷启动：三步 startStep 序列 → 进行中 + 就绪通知', async () => {
  const env = createEnv()
  const steps = []
  const originalOffscreen = env.offscreen
  env.offscreen = async (message) => {
    steps.push({ type: message.type, startStep: env.runtime()?.startStep, bridge: env.runtime()?.bridge })
    return originalOffscreen(message)
  }
  await loadBackground(env)

  assert.deepEqual(env.runtime().directions, {
    downlink: { status: 'stopped', mode: null },
    uplink: { status: 'stopped', mode: null },
  })

  const result = await powerOn(env)
  assert.deepEqual(result, { ok: true })

  // 第一步发 li:connect 时 startStep 已是 bridge；第三步发 li:start 时是 translation
  assert.deepEqual(
    steps.map((s) => [s.type, s.startStep]),
    [
      ['li:connect', 'bridge'],
      ['li:start', 'translation'],
    ]
  )

  const runtime = env.runtime()
  assert.equal(runtime.bridge, 'connected')
  assert.equal(runtime.phase, 'on')
  assert.equal(runtime.startStep, null)
  assert.deepEqual(runtime.directions, RUNNING)
  assert.equal(runtime.server.port, READY_FRAME.port)
  assert.deepEqual(runtime.languages, { hear: DEFAULT_SETTINGS.hear, partnerHears: DEFAULT_SETTINGS.partnerHears })
  assert.deepEqual(env.lastBadge(), { text: '●', color: BADGE_COLORS.live })

  // 就绪通知：id、标题、正文都与纯函数一致
  assert.equal(env.notifications.length, 1)
  assert.deepEqual(env.notifications[0], {
    id: 'li-ready',
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    priority: 1,
    title: '同传已就绪',
    message: readyCopy({ plan: buildDirections(DEFAULT_SETTINGS), meetingMuted: null }),
  })

  // 建桥完成前没有拉起宿主
  assert.equal(env.hostPorts.length, 1)
  const startMessage = env.offscreenCalls.find((m) => m.type === 'li:start')
  assert.equal(startMessage.uplinkPaused, false)
  assert.equal(startMessage.server.launchToken, READY_FRAME.launchToken)
  assert.deepEqual(startMessage.plan, buildDirections(DEFAULT_SETTINGS))
})

test('AC-125 启动令牌只在内存：storage 里既没有它也没有 runtime 持久化', async () => {
  const env = createEnv()
  await loadBackground(env)
  await powerOn(env)
  const dumped = JSON.stringify(env.storage)
  assert.ok(!dumped.includes(READY_FRAME.launchToken), 'launchToken 绝不落盘')
  assert.ok(!dumped.includes('mockWsUrl'))
  assert.deepEqual(env.runtime().server, { port: READY_FRAME.port, backend: 'mock' })
  assert.equal(JSON.stringify(env.storage.local).includes('runtime'), false, '运行态不得进 storage.local')
})

test('AC-102 关闭同传：撤翻译层与宿主，桥与直通保持，不发通知', async () => {
  const env = createEnv()
  await loadBackground(env)
  await powerOn(env)
  env.notifications.length = 0

  const result = await env.toSw({ type: 'li:power', to: 'sw', on: false })
  assert.deepEqual(result, { ok: true })
  const runtime = env.runtime()
  assert.equal(runtime.phase, 'off')
  assert.equal(runtime.bridge, 'connected', '关闭同传绝不撤桥')
  assert.equal(runtime.server, null)
  assert.deepEqual(runtime.directions, {
    downlink: { status: 'stopped', mode: null },
    uplink: { status: 'stopped', mode: null },
  })
  assert.ok(env.offscreenCalls.some((m) => m.type === 'li:stop'))
  assert.ok(!env.offscreenCalls.some((m) => m.type === 'li:disconnect'), '关闭同传不得撤桥')
  assert.equal(env.hostPorts[0].disconnected, true, '宿主端口必须断开')
  assert.deepEqual(env.hostPorts[0].posted, [{ type: 'shutdown' }])
  assert.equal(env.hasDocument(), true, '离屏文档保留')
  assert.deepEqual(env.lastBadge(), { text: '●', color: BADGE_COLORS.idle })
  assert.deepEqual(env.notifications, [], 'stopped 不通知')
})

test('AC-104 过渡态收到 li:power 一律 busy，且 runtime 不变', async () => {
  const env = createEnv()
  let release
  env.offscreen = async (message) => {
    if (message.type === 'li:connect') {
      await new Promise((resolve) => {
        release = resolve
      })
      return { ok: true, roles: {}, labels: {} }
    }
    if (message.type === 'li:start') return { ok: true, directions: RUNNING }
    return { ok: true }
  }
  await loadBackground(env)

  const pending = powerOn(env)
  await settle()
  const snapshot = JSON.stringify(env.runtime())
  assert.equal(env.runtime().phase, 'starting')

  assert.deepEqual(await env.toSw({ type: 'li:power', to: 'sw', on: true }), { ok: false, reason: 'busy' })
  assert.deepEqual(await env.toSw({ type: 'li:power', to: 'sw', on: false }), { ok: false, reason: 'busy' })
  assert.deepEqual(await env.toSw({ type: 'li:disconnect', to: 'sw' }), { ok: false, reason: 'busy' })
  assert.equal(JSON.stringify(env.runtime()), snapshot, 'busy 期间 runtime 不得变化')

  release()
  await pending
  assert.equal(env.runtime().phase, 'on')
})

test('AC-105/AC-138 宿主不可用：翻译层 error，桥保持 connected 且通知说明原声仍在直通', async () => {
  const env = createEnv()
  env.connectNative = (port) => port.die('Specified native messaging host not found.')
  await loadBackground(env)

  const result = await powerOn(env)
  assert.equal(result.ok, false)

  const runtime = env.runtime()
  assert.equal(runtime.bridge, 'connected', '桥不受翻译层失败影响')
  assert.equal(runtime.phase, 'error')
  assert.equal(runtime.startStep, null)
  assert.equal(runtime.error.category, 'host_unavailable')
  assert.ok(runtime.error.message.includes('npm run install:host'))
  assert.deepEqual(runtime.directions, {
    downlink: { status: 'stopped', mode: null },
    uplink: { status: 'stopped', mode: null },
  })
  assert.equal(env.hasDocument(), true)

  assert.equal(env.notifications.length, 1)
  assert.equal(env.notifications[0].id, 'li-failed')
  assert.equal(env.notifications[0].title, '无法开启同传')
  assert.equal(
    env.notifications[0].message,
    failureCopy({ kind: 'translation', error: runtime.error, bridge: 'connected' })
  )
  assert.ok(env.notifications[0].message.includes('原声仍在直通。'))

  // 紧接着重试：桥已连，直接从第二步开始
  env.connectNative = (port) => port.emit(READY_FRAME)
  assert.deepEqual(await powerOn(env), { ok: true })
  assert.equal(env.runtime().phase, 'on')
})

test('AC-105 建桥失败：只报桥失败一条通知，翻译层同时进入 error', async () => {
  const env = createEnv()
  env.offscreen = async (message) => {
    if (message.type === 'li:connect') {
      return { ok: false, error: { category: 'device_missing', message: USER_MESSAGES.device_missing } }
    }
    return { ok: true }
  }
  await loadBackground(env)
  const result = await powerOn(env)
  assert.equal(result.ok, false)

  const runtime = env.runtime()
  assert.equal(runtime.bridge, 'failed')
  assert.equal(runtime.phase, 'error')
  assert.equal(runtime.bridgeError.category, 'device_missing')
  assert.equal(env.hostPorts.length, 0, '第一步就失败时绝不拉起宿主')
  assert.equal(env.notifications.length, 1, '桥失败与翻译失败不得重复通知')
  assert.equal(env.notifications[0].title, '无法连接会议音频')
  assert.ok(env.notifications[0].message.includes('会议现在听不到你，你也听不到会议。'))
  assert.deepEqual(env.lastBadge(), { text: '!', color: BADGE_COLORS.danger })
})

test('AC-141 桥丢失：撤宿主 + 通知；device_missing 时 devicechange 自动重试一次', async () => {
  const env = createEnv()
  await loadBackground(env)
  await powerOn(env)
  env.notifications.length = 0

  await env.toSw({
    type: 'li:pipeline-event',
    to: 'sw',
    event: 'bridge-lost',
    directionId: 'downlink',
    payload: { category: 'device_missing', message: '耳机没了。' },
  })

  let runtime = env.runtime()
  assert.equal(runtime.bridge, 'failed')
  assert.equal(runtime.phase, 'error')
  assert.equal(runtime.bridgeError.message, runtime.error.message)
  assert.equal(env.hostPorts[0].disconnected, true, '桥失败必须一并撤宿主')
  assert.equal(env.hasDocument(), true, '离屏文档保留以便监听 devicechange')
  assert.equal(env.notifications.length, 1)
  assert.equal(env.notifications[0].title, '无法连接会议音频')

  // 插回设备：自动重试一次并成功
  const before = env.offscreenCalls.filter((m) => m.type === 'li:connect').length
  await env.toSw({ type: 'li:pipeline-event', to: 'sw', event: 'devicechange', directionId: null, payload: null })
  runtime = env.runtime()
  assert.equal(runtime.bridge, 'connected')
  assert.equal(env.offscreenCalls.filter((m) => m.type === 'li:connect').length, before + 1, '只重试一次')
  assert.equal(runtime.phase, 'error', '桥回来了，但翻译层仍需用户重新开启')
})

test('AC-141 devicechange 不循环：桥仍失败时不再连续重试', async () => {
  const env = createEnv()
  env.offscreen = async (message) => {
    if (message.type === 'li:connect') {
      return { ok: false, error: { category: 'device_missing', message: '还是没有设备。' } }
    }
    return { ok: true }
  }
  await loadBackground(env)
  await powerOn(env)
  const attemptsAfterStart = env.offscreenCalls.filter((m) => m.type === 'li:connect').length

  for (let i = 0; i < 5; i++) {
    await env.toSw({ type: 'li:pipeline-event', to: 'sw', event: 'devicechange', directionId: null, payload: null })
  }
  const attempts = env.offscreenCalls.filter((m) => m.type === 'li:connect').length
  assert.equal(attempts, attemptsAfterStart + 1, `连发 5 次 devicechange 只允许重试一次，实际 ${attempts - attemptsAfterStart} 次`)
  assert.equal(env.runtime().bridge, 'failed')
})

test('AC-140 断开会议音频：先撤翻译层再撤桥，runtime 回初始，角标清空', async () => {
  const env = createEnv()
  await loadBackground(env)
  await powerOn(env)
  await env.toSw({ type: 'li:meeting-mute', to: 'sw', platform: 'meet', buttons: [{ dataIsMuted: 'true', text: 'mic_off' }] }, { tab: MEET_TAB })

  const result = await env.toSw({ type: 'li:disconnect', to: 'sw' })
  assert.deepEqual(result, { ok: true })
  const order = env.offscreenCalls.map((m) => m.type)
  assert.ok(order.indexOf('li:stop') < order.lastIndexOf('li:disconnect'), '必须先撤翻译层再撤桥')
  assert.equal(env.hasDocument(), false, '离屏文档必须关闭')
  assert.equal(env.hostPorts[0].disconnected, true)

  const runtime = env.runtime()
  assert.equal(runtime.bridge, 'disconnected')
  assert.equal(runtime.phase, 'off')
  assert.equal(runtime.meetingMuted, true, '断开只影响桥，会议静音态保留')
  assert.deepEqual(env.lastBadge(), { text: '' })
})

test('AC-131/AC-132 Meet 静音：暂停上行、角标转琥珀；取消静音按需重建', async () => {
  const env = createEnv()
  await loadBackground(env)
  await powerOn(env)

  const muted = await env.toSw(
    { type: 'li:meeting-mute', to: 'sw', platform: 'meet', buttons: [{ dataIsMuted: 'true', text: 'mic_off' }] },
    { tab: MEET_TAB }
  )
  assert.equal(muted, undefined, '探测上报不需要回执')
  assert.equal(env.runtime().meetingMuted, true)
  assert.deepEqual(env.lastBadge(), { text: '●', color: BADGE_COLORS.muted })
  const pause = env.offscreenCalls.filter((m) => m.type === 'li:set-uplink-paused')
  assert.deepEqual(pause[pause.length - 1], { type: 'li:set-uplink-paused', to: 'offscreen', paused: true })

  // 暂停期间上行被对端关闭 → 挂起，phase 保持 on
  await env.toSw({
    type: 'li:pipeline-event',
    to: 'sw',
    event: 'uplink-suspended',
    directionId: 'uplink',
    payload: { category: 'network_unavailable', message: '对端关闭。' },
  })
  assert.equal(env.runtime().phase, 'on')
  assert.equal(env.runtime().directions.uplink.status, 'suspended')
  assert.equal(env.runtime().directions.downlink.status, 'running', '下行不受影响')

  // 取消静音 → 离屏重建上行 → 标回 running
  env.offscreen = async (message) => {
    if (message.type === 'li:set-uplink-paused') return { ok: true, restarted: message.paused ? [] : ['uplink'] }
    return { ok: true }
  }
  await env.toSw(
    { type: 'li:meeting-mute', to: 'sw', platform: 'meet', buttons: [{ dataIsMuted: 'false', text: 'mic' }] },
    { tab: MEET_TAB }
  )
  assert.equal(env.runtime().meetingMuted, false)
  assert.equal(env.runtime().directions.uplink.status, 'running')
  assert.deepEqual(env.lastBadge(), { text: '●', color: BADGE_COLORS.live })
})

test('AC-132/AC-144 非 Meet 来源忽略；phase=off 时只记静音态；标签关闭后回落', async () => {
  const env = createEnv()
  await loadBackground(env)

  // 未开启时收到静音变化：只更新 meetingMuted，不发任何离屏消息
  await env.toSw(
    { type: 'li:meeting-mute', to: 'sw', platform: 'meet', buttons: [{ dataIsMuted: 'true', text: 'mic_off' }] },
    { tab: MEET_TAB }
  )
  assert.equal(env.runtime().meetingMuted, true)
  assert.deepEqual(env.offscreenCalls, [])

  // 非 Meet 页面的上报一律忽略
  await env.toSw(
    { type: 'li:meeting-mute', to: 'sw', platform: 'meet', buttons: [{ dataIsMuted: 'false', text: 'mic' }] },
    { tab: { id: 9, url: 'https://zoom.us/j/123' } }
  )
  assert.equal(env.runtime().meetingMuted, true, '非 Meet 标签不得改写静音态')
  await env.toSw({ type: 'li:meeting-mute', to: 'sw', platform: 'meet', buttons: [] }, {})
  assert.equal(env.runtime().meetingMuted, true, '没有 sender.tab 的上报一律忽略')

  // 关闭 Meet 标签 → 静音态回到未知
  await env.removeTab(MEET_TAB.id)
  assert.equal(env.runtime().meetingMuted, null)

  // 开启时把当前静音态带给离屏
  await env.toSw(
    { type: 'li:meeting-mute', to: 'sw', platform: 'meet', buttons: [{ dataIsMuted: 'true', text: 'mic_off' }] },
    { tab: MEET_TAB }
  )
  await powerOn(env)
  assert.equal(env.offscreenCalls.find((m) => m.type === 'li:start').uplinkPaused, true)
  assert.ok(
    env.notifications[0].message.includes('你在会议里已静音'),
    `就绪通知应写明已静音：${env.notifications[0].message}`
  )
})

test('AC-109 改语言：只重启受影响方向并更新 runtime.languages', async () => {
  const env = createEnv()
  await loadBackground(env)
  await powerOn(env)

  const response = await env.toSw({ type: 'li:set-settings', to: 'sw', hear: 'ja' })
  assert.equal(response.ok, true)
  assert.equal(response.settings.hear, 'ja')
  const update = env.offscreenCalls.find((m) => m.type === 'li:update-plan')
  assert.equal(update.plan.downlink.target, 'ja')
  assert.equal(update.plan.uplink.target, 'en')
  assert.equal(env.runtime().languages.hear, 'ja')
  assert.equal(env.storage.local.settings.hear, 'ja')

  // 未开启时改语言不发离屏消息
  await env.toSw({ type: 'li:power', to: 'sw', on: false })
  const before = env.offscreenCalls.length
  await env.toSw({ type: 'li:set-settings', to: 'sw', partnerHears: 'original' })
  assert.equal(env.offscreenCalls.length, before, '未开启时不得向离屏发计划')
  assert.equal(env.storage.local.settings.partnerHears, 'original')
})

test('AC-129 衬底档位改动即时下发；未知键被丢弃', async () => {
  const env = createEnv()
  await loadBackground(env)
  await powerOn(env)
  await env.toSw({ type: 'li:set-settings', to: 'sw', floorLevel: 0, speak: 'zh', autoConnect: true })
  const floor = env.offscreenCalls.find((m) => m.type === 'li:set-floor')
  assert.deepEqual(floor, { type: 'li:set-floor', to: 'offscreen', level: 0 })
  assert.equal(env.storage.local.settings.floorLevel, 0)
  assert.equal(env.storage.local.settings.speak, undefined, '未知键不得写入 settings')
  assert.equal(env.storage.local.settings.autoConnect, undefined)
})

test('AC-123 翻译层掉线：failed + 通知，桥保持，绝不自动重连', async () => {
  const env = createEnv()
  await loadBackground(env)
  await powerOn(env)
  env.notifications.length = 0
  const callsBefore = env.offscreenCalls.length

  await env.toSw({
    type: 'li:pipeline-event',
    to: 'sw',
    event: 'error',
    directionId: 'downlink',
    payload: { category: 'network_unavailable', message: USER_MESSAGES.network_unavailable },
  })

  const runtime = env.runtime()
  assert.equal(runtime.phase, 'error')
  assert.equal(runtime.bridge, 'connected')
  assert.equal(runtime.error.category, 'network_unavailable')
  assert.equal(env.hostPorts[0].disconnected, true)
  assert.equal(env.notifications.length, 1)
  assert.equal(env.notifications[0].title, '无法开启同传')

  // 再等一会儿，确认没有任何自动重连
  await settle(30)
  const newCalls = env.offscreenCalls.slice(callsBefore).map((m) => m.type)
  assert.deepEqual(newCalls, ['li:stop'], `失败后只允许撤翻译层，实际：${newCalls}`)
  assert.equal(env.hostPorts.length, 1, '不得自动重连宿主')
})

test('AC-139 浏览器刚启动：SW 顶层不占用任何设备', async () => {
  const env = createEnv()
  await loadBackground(env)
  await env.fireInstalled()
  assert.deepEqual(env.offscreenCalls, [], '不得向离屏发任何消息')
  assert.equal(env.hostPorts.length, 0, '不得拉起宿主')
  assert.equal(env.hasDocument(), false, '不得创建离屏文档')
  const runtime = env.runtime()
  assert.equal(runtime.bridge, 'disconnected')
  assert.equal(runtime.phase, 'off')
  assert.deepEqual(env.lastBadge(), { text: '' })
  assert.deepEqual(env.storage.local.settings, DEFAULT_SETTINGS, '安装时写入规范化后的默认设置')
})

test('AC-122 SW 唤醒后的恢复：离屏没了 → 桥失败；中间态 → 重置；宿主没了 → 重连', async () => {
  // 离屏文档丢失
  const lost = createEnv({
    session: { runtime: { bridge: 'connected', phase: 'on', directions: RUNNING, meetingMuted: null } },
    offscreenExists: false,
  })
  await loadBackground(lost)
  assert.equal(lost.runtime().bridge, 'failed')
  assert.equal(lost.notifications[0].title, '无法连接会议音频')
  assert.ok(lost.notifications[0].message.includes('会议音频桥意外中断'))

  // 中间态
  const halfway = createEnv({
    session: { runtime: { bridge: 'connected', phase: 'starting', startStep: 'host', meetingMuted: null } },
    offscreenExists: true,
  })
  await loadBackground(halfway)
  assert.equal(halfway.runtime().phase, 'error')
  assert.equal(halfway.runtime().bridge, 'connected')
  assert.ok(halfway.notifications[0].message.includes('上次操作未完成'))

  // 桥在、翻译在跑、宿主没了 → 重连宿主并把新端口告诉离屏
  const rehost = createEnv({
    session: { runtime: { bridge: 'connected', phase: 'on', directions: RUNNING, meetingMuted: null } },
    offscreenExists: true,
  })
  await loadBackground(rehost)
  assert.equal(rehost.hostPorts.length, 1, '必须重连宿主')
  assert.equal(rehost.runtime().phase, 'on')
  const changed = rehost.offscreenCalls.find((m) => m.type === 'li:server-changed')
  assert.equal(changed.server.port, READY_FRAME.port)
  assert.deepEqual(rehost.notifications, [], '恢复不发通知')
})

test('AC-122 离屏长连接断开：桥已连时判为文档丢失', async () => {
  const env = createEnv()
  await loadBackground(env)
  await powerOn(env)
  env.notifications.length = 0
  const port = await env.connectKeepalive()
  await port.drop()
  assert.equal(env.runtime().bridge, 'failed')
  assert.equal(env.notifications[0].title, '无法连接会议音频')
})
