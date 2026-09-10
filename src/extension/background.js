import {
  createInitialRuntime,
  connectRequested,
  bridgeConnected,
  bridgeFailed,
  disconnected,
  requestStart,
  hostReady,
  started,
  latency,
  uplinkSuspended,
  uplinkResumed,
  planApplied,
  requestStop,
  stopped,
  failed,
  meetingMute,
  badgeFor,
  planRecovery,
  readyCopy,
  failureCopy,
  stripSecrets,
  NOTIFY,
} from '/shared/runtime-state.mjs'
import { DEFAULT_SETTINGS, normalizeSettings, buildDirections, diffPlan, languagesOf } from '/shared/direction-plan.mjs'
import { parseMeetMuteState, resolveMeetingMuted } from '/shared/meeting-mute.mjs'
import { classifyNativeError } from '/shared/native-errors.mjs'
import { classifyError } from '/shared/errors.mjs'

// Service worker：桥与翻译层的编排者。只做接线——所有状态转换都经
// /shared/runtime-state.mjs 的纯函数，所有文案都来自那里的 copy 函数。
//
// 不自动连接：占用设备的动作（创建离屏文档、getUserMedia、connectNative）
// 只由 li:power {on:true} 触发，外加桥因缺设备失败后 devicechange 的一次重试。

const HOST_NAME = 'com.live_interpreter.host'
const MEET_ORIGIN = 'https://meet.google.com/'
const OFFSCREEN_PATH = 'offscreen.html'

const TIMEOUT = { connect: 10000, host: 10000, start: 15000, recover: 15000 }

const DEVICE_RETRY_COOLDOWN_MS = 1000

let state = createInitialRuntime()
let nativePort = null
let hostReadyFrame = null
let muteReports = []
let lastDeviceRetryAt = 0
let busy = false

// ---------------------------------------------------------------- 基础设施

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject({ category: 'api_error', message }), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

// 唯一的状态出口：同引用即无变化，否则落盘 + 刷角标
async function dispatch(next) {
  if (next === state) return false
  state = next
  const badge = badgeFor(state)
  await chrome.storage.session.set({ runtime: { ...state, server: stripSecrets(state.server) } })
  await chrome.action.setBadgeText({ text: badge.text })
  if (badge.color) await chrome.action.setBadgeBackgroundColor({ color: badge.color })
  return true
}

const NOTIFICATION_STYLE = { type: 'basic', iconUrl: 'icons/icon128.png', priority: 1 }

async function readSettings() {
  const stored = await chrome.storage.local.get('settings')
  return normalizeSettings(stored.settings ?? DEFAULT_SETTINGS)
}

async function toOffscreen(message) {
  const response = await chrome.runtime.sendMessage({ ...message, to: 'offscreen' })
  if (!response?.ok) throw response?.error ?? { category: 'api_error', message: '离屏文档没有响应。' }
  return response
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  return contexts.length > 0
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: '在后台维持会议音频直通与双向翻译管道。',
  })
}

// ---------------------------------------------------------------- 宿主

function disconnectHost() {
  const port = nativePort
  nativePort = null
  hostReadyFrame = null
  if (!port) return
  try {
    port.postMessage({ type: 'shutdown' })
  } catch {
    // 端口已断
  }
  try {
    port.disconnect()
  } catch {
    // 忽略
  }
}

function connectHost() {
  return new Promise((resolve, reject) => {
    let settled = false
    let port
    try {
      port = chrome.runtime.connectNative(HOST_NAME)
    } catch (err) {
      reject(classifyNativeError(err?.message))
      return
    }
    port.onMessage.addListener((frame) => {
      if (frame?.type === 'ready') {
        settled = true
        nativePort = port
        hostReadyFrame = frame
        resolve(frame)
        return
      }
      if (frame?.type === 'error') {
        settled = true
        reject(classifyError(frame))
      }
    })
    port.onDisconnect.addListener(() => {
      const reason = classifyNativeError(chrome.runtime.lastError?.message)
      if (!settled) {
        settled = true
        reject(reason)
        return
      }
      // 我们自己撤宿主时会先把 nativePort 置空，那不是意外退出
      if (nativePort !== port) return
      nativePort = null
      hostReadyFrame = null
      if (state.phase === 'on') void failTranslation(reason)
    })
  })
}

function serverConfig() {
  if (!hostReadyFrame) return null
  return {
    baseUrl: `http://127.0.0.1:${hostReadyFrame.port}`,
    backend: hostReadyFrame.backend,
    mockWsUrl: hostReadyFrame.mockWsUrl,
    launchToken: hostReadyFrame.launchToken,
    port: hostReadyFrame.port,
  }
}

// ---------------------------------------------------------------- 四条流程

async function connectBridge() {
  const settings = await readSettings()
  await dispatch(connectRequested(state))
  try {
    await ensureOffscreen()
    const response = await withTimeout(
      toOffscreen({
        type: 'li:connect',
        deviceOverrides: settings.deviceOverrides,
        floorLevel: settings.floorLevel,
      }),
      TIMEOUT.connect,
      '连接会议音频超时：请检查音频设备后重试。'
    )
    await dispatch(bridgeConnected(state))
    return response
  } catch (err) {
    await failBridge(classifyError(err))
    throw err
  }
}

// 桥失败：撤一切（含宿主），离屏文档保留以便监听 devicechange
async function failBridge(error) {
  disconnectHost()
  await dispatch(bridgeFailed(state, error))
  chrome.notifications.create(NOTIFY.bridgeFailed.id, {
    ...NOTIFICATION_STYLE,
    title: NOTIFY.bridgeFailed.title,
    message: failureCopy({ kind: 'bridge', error }),
  })
}

// 翻译层失败：只撤翻译层与宿主，桥与直通保持
async function failTranslation(error) {
  try {
    await toOffscreen({ type: 'li:stop' })
  } catch {
    // 离屏已不可用时尽力而为
  }
  disconnectHost()
  await dispatch(failed(state, error))
  chrome.notifications.create(NOTIFY.translationFailed.id, {
    ...NOTIFICATION_STYLE,
    title: NOTIFY.translationFailed.title,
    message: failureCopy({ kind: 'translation', error, bridge: state.bridge }),
  })
}

async function start() {
  const requested = requestStart(state)
  if (requested === state) return
  const settings = await readSettings()
  await dispatch(requested)
  try {
    if (state.bridge !== 'connected') await connectBridge()
    await withTimeout(connectHost(), TIMEOUT.host, '启动本地翻译服务超时：请重试或查看宿主日志。')
    await dispatch(hostReady(state))
    const plan = buildDirections(settings)
    const response = await withTimeout(
      toOffscreen({
        type: 'li:start',
        plan,
        uplinkPaused: state.meetingMuted === true,
        server: serverConfig(),
      }),
      TIMEOUT.start,
      '连接翻译服务超时：请检查网络后重试。'
    )
    await dispatch(
      started(state, {
        directions: response.directions,
        server: serverConfig(),
        languages: languagesOf(settings),
        at: Date.now(),
      })
    )
    chrome.notifications.create(NOTIFY.ready.id, {
      ...NOTIFICATION_STYLE,
      title: NOTIFY.ready.title,
      message: readyCopy({ plan, meetingMuted: state.meetingMuted }),
    })
  } catch (err) {
    // 桥失败已在 connectBridge 里通知过，不再重复报翻译层失败
    if (state.bridge === 'failed') throw err
    await failTranslation(classifyError(err))
    throw err
  }
}

async function stop() {
  const requested = requestStop(state)
  if (requested === state) return
  await dispatch(requested)
  try {
    await toOffscreen({ type: 'li:stop' })
  } catch {
    // 离屏已不可用：翻译层无论如何都算停了
  }
  disconnectHost()
  await dispatch(stopped(state))
}

async function disconnectAll() {
  if (state.phase === 'on' || state.phase === 'starting') await stop()
  disconnectHost()
  try {
    await toOffscreen({ type: 'li:disconnect' })
  } catch {
    // 离屏已不可用
  }
  if (await hasOffscreen()) await chrome.offscreen.closeDocument()
  await dispatch(disconnected(state))
}

// 同一时刻只允许一条流程在跑：UI 已禁用按钮，这里是最后一道闸
async function exclusive(run) {
  if (busy) return { ok: false, reason: 'busy' }
  busy = true
  try {
    await run()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: classifyError(err) }
  } finally {
    busy = false
  }
}

function isTransitioning() {
  return busy || state.bridge === 'connecting' || state.phase === 'starting' || state.phase === 'stopping'
}

// ---------------------------------------------------------------- 设置与静音

async function applySettings(patch) {
  const current = await readSettings()
  const next = normalizeSettings({ ...current, ...patch })
  await chrome.storage.local.set({ settings: next })

  if (next.floorLevel !== current.floorLevel && state.bridge === 'connected') {
    await toOffscreen({ type: 'li:set-floor', level: next.floorLevel }).catch(() => {})
  }
  const before = buildDirections(current)
  const after = buildDirections(next)
  if (state.phase === 'on' && diffPlan(before, after).length > 0) {
    const response = await toOffscreen({ type: 'li:update-plan', plan: after, server: serverConfig() })
    const directions = {}
    for (const id of response.restarted ?? []) directions[id] = { status: 'running', mode: after[id].mode }
    await dispatch(planApplied(state, { directions, languages: languagesOf(next) }))
  }
  return next
}

async function applyMeetingMute(muted) {
  const changed = await dispatch(meetingMute(state, muted))
  if (!changed || state.phase !== 'on') return
  const response = await toOffscreen({
    type: 'li:set-uplink-paused',
    paused: state.meetingMuted === true,
  }).catch((err) => ({ error: err }))
  if (response?.error) {
    await failTranslation(classifyError(response.error))
    return
  }
  if ((response.restarted ?? []).includes('uplink')) await dispatch(uplinkResumed(state))
}

function recordMuteReport(tabId, muted) {
  muteReports = muteReports.filter((report) => report.tabId !== tabId)
  muteReports.push({ tabId, muted, at: Date.now() })
}

// ---------------------------------------------------------------- 事件

async function onPipelineEvent(message) {
  if (message.event === 'latency') {
    await dispatch(latency(state, { directionId: message.directionId, ms: message.payload?.ms }))
    return
  }
  if (message.event === 'uplink-suspended') {
    await dispatch(uplinkSuspended(state))
    return
  }
  if (message.event === 'uplink-resumed') {
    await dispatch(uplinkResumed(state))
    return
  }
  if (message.event === 'bridge-lost') {
    await failBridge(classifyError(message.payload))
    return
  }
  if (message.event === 'devicechange') {
    await retryBridgeAfterDeviceChange()
    return
  }
  // error / closed：翻译层失败，桥保持；绝不自动重连
  if (state.phase === 'on' || state.phase === 'starting') {
    await failTranslation(classifyError(message.payload))
  }
}

// 缺设备导致的桥失败，插回设备时自动重试一次。
// 冷却窗口保证「同一次 devicechange（系统常连发数条）至多重试一次」，
// 且失败后不自我循环——下一次重试必须由用户真的插拔设备触发。
async function retryBridgeAfterDeviceChange() {
  if (state.bridge !== 'failed' || state.bridgeError?.category !== 'device_missing') return
  const now = Date.now()
  if (now - lastDeviceRetryAt < DEVICE_RETRY_COOLDOWN_MS) return
  lastDeviceRetryAt = now
  await exclusive(() => connectBridge())
}

const UI_HANDLERS = {
  'li:power': (message) => {
    if (isTransitioning()) return Promise.resolve({ ok: false, reason: 'busy' })
    return exclusive(() => (message.on ? start() : stop()))
  },
  'li:disconnect': () => {
    if (isTransitioning()) return Promise.resolve({ ok: false, reason: 'busy' })
    return exclusive(() => disconnectAll())
  },
  'li:set-settings': async (message) => {
    const { type, to, ...patch } = message
    const settings = await applySettings(patch)
    return { ok: true, settings }
  },
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.to !== 'sw') return false

  if (message.type === 'li:meeting-mute') {
    // 只信任来自 Meet 标签页的上报
    if (!sender.tab?.url?.startsWith(MEET_ORIGIN)) return false
    recordMuteReport(sender.tab.id, parseMeetMuteState({ buttons: message.buttons }))
    void applyMeetingMute(resolveMeetingMuted(muteReports))
    return false
  }

  if (message.type === 'li:pipeline-event') {
    void onPipelineEvent(message)
    return false
  }

  const handler = UI_HANDLERS[message.type]
  if (!handler) return false
  Promise.resolve()
    .then(() => handler(message))
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: classifyError(err) }))
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => {
  const before = muteReports.length
  muteReports = muteReports.filter((report) => report.tabId !== tabId)
  if (muteReports.length !== before) void applyMeetingMute(resolveMeetingMuted(muteReports))
})

// 离屏文档的长连接：桥还在却断了连接，说明文档被 Chrome 关掉了
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'li-keepalive') return
  port.onMessage.addListener((message) => {
    if (message?.type === 'ping') port.postMessage({ type: 'pong' })
  })
  port.onDisconnect.addListener(() => {
    if (state.bridge === 'connected' || state.bridge === 'connecting') {
      void failBridge({ category: 'api_error', message: '会议音频桥意外中断，请重新开启。' })
    }
  })
})

// ---------------------------------------------------------------- 启动与恢复

async function boot() {
  const stored = await chrome.storage.session.get('runtime')
  state = { ...createInitialRuntime(), ...(stored.runtime ?? {}) }
  const recovery = planRecovery({
    runtime: state,
    hasNativePort: nativePort !== null,
    hasOffscreen: await hasOffscreen(),
  })
  if (recovery.action === 'fail-bridge') {
    await failBridge(recovery.error)
    return
  }
  if (recovery.action === 'fail-translation') {
    await failTranslation(recovery.error)
    return
  }
  if (recovery.action === 'reconnect-host') {
    try {
      await withTimeout(connectHost(), TIMEOUT.host, '重连本地翻译服务超时。')
      await toOffscreen({ type: 'li:server-changed', server: serverConfig() })
    } catch (err) {
      await failTranslation(classifyError(err))
    }
    return
  }
  await dispatch({ ...state })
}

async function initSettings() {
  const stored = await chrome.storage.local.get('settings')
  await chrome.storage.local.set({ settings: normalizeSettings(stored.settings ?? DEFAULT_SETTINGS) })
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
}

chrome.runtime.onInstalled.addListener(() => {
  void initSettings()
})
chrome.runtime.onStartup.addListener(() => {
  void initSettings()
})

// SW 每次唤醒都从 storage.session 恢复镜像；planRecovery 绝不返回占用设备的动作
void boot()
