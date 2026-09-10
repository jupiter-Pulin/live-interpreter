import {
  createInitialRuntime,
  connectRequested,
  bridgeConnected,
  bridgeFailed,
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
// 只在同传开启期间占用设备：创建离屏文档、getUserMedia、connectNative 只由
// li:power {on:true} 触发；关闭、开启途中取消、任何失败都经 releaseAll 把宿主、
// 翻译层、桥与离屏文档一次撤干净，插件在非开启状态下不占用麦克风。

const HOST_NAME = 'com.live_interpreter.host'
const MEET_ORIGIN = 'https://meet.google.com/'
const OFFSCREEN_PATH = 'offscreen.html'

const TIMEOUT = { connect: 10000, host: 10000, start: 15000, recover: 15000 }

let state = createInitialRuntime()
let nativePort = null
// connectNative 已发出、还没等到 ready 的宿主端口：取消开启时也要能把它断掉，否则宿主进程留着
let pendingHostPort = null
let hostReadyFrame = null
let muteReports = []
let busy = false
// 我们自己在关离屏文档的窗口：此间 keepalive 端口断开是预期的，不是桥丢失
let closingOffscreen = false
// 在途的一次开启（见 beginStart）：取消开启靠它让 start() 的所有长等待立刻结束
let currentStart = null

// 被取消的开启不是失败：不落 error、不发通知，收尾由 cancelStart 统一完成
const START_CANCELLED = { category: 'api_error', message: '已取消开启。' }

// ---------------------------------------------------------------- 基础设施

// 超时与取消都会让等待立刻结束；run 为本次开启的取消令牌（可缺省）
function withTimeout(promise, ms, message, run) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject({ category: 'api_error', message }), ms)
    const settle = (finish) => (value) => {
      clearTimeout(timer)
      finish(value)
    }
    promise.then(settle(resolve), settle(reject))
    run?.aborted.catch(settle(reject))
  })
}

// 一次开启的取消令牌：abort() 让所有挂在 withTimeout 上的长等待以 START_CANCELLED 立刻结束；
// done 在 start() 退栈时兑现，取消方据此确认它之后不会再有任何副作用
function beginStart() {
  const run = { cancelled: false }
  run.aborted = new Promise((_, reject) => {
    run.abort = () => {
      run.cancelled = true
      reject(START_CANCELLED)
    }
  })
  run.aborted.catch(() => {})
  run.done = new Promise((resolve) => {
    run.finish = resolve
  })
  currentStart = run
  return run
}

// 每个副作用之前都确认本次开启还算数：取消发生在两次 await 之间也不会漏做收尾之外的事
function checkpoint(run) {
  if (run.cancelled) throw START_CANCELLED
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

// 已就绪的与还在等 ready 的宿主端口一并断开：端口一断，Chrome 就结束宿主进程
function disconnectHost() {
  const ports = [nativePort, pendingHostPort].filter(Boolean)
  nativePort = null
  pendingHostPort = null
  hostReadyFrame = null
  for (const port of ports) {
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
    pendingHostPort = port
    port.onMessage.addListener((frame) => {
      // 已被取消开启断掉的端口：迟到的 ready 一律不认
      if (settled || pendingHostPort !== port) return
      if (frame?.type === 'ready') {
        settled = true
        pendingHostPort = null
        nativePort = port
        hostReadyFrame = frame
        resolve(frame)
        return
      }
      if (frame?.type === 'error') {
        settled = true
        pendingHostPort = null
        reject(classifyError(frame))
      }
    })
    port.onDisconnect.addListener(() => {
      const reason = classifyNativeError(chrome.runtime.lastError?.message)
      if (!settled) {
        settled = true
        if (pendingHostPort === port) pendingHostPort = null
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

// ---------------------------------------------------------------- 流程

// 不在同传中就不占任何设备：关闭、取消、失败都经这里把宿主、翻译层、桥与离屏文档一次撤干净。
// 最后落盘的终态由调用方给出（关闭/取消 → 初始；失败 → error），且在关离屏文档的窗口内落盘，
// 这样关文档必然掉的 keepalive 端口不会被误判成桥丢失。
async function releaseAll(finalState) {
  disconnectHost()
  // li:disconnect 先撤翻译层（作废在途启动、关会话与采集）再停播放器与直通 track
  await toOffscreen({ type: 'li:disconnect' }).catch(() => {})
  closingOffscreen = true
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument()
    await dispatch(finalState())
  } finally {
    closingOffscreen = false
  }
}

async function connectBridge(run) {
  const settings = await readSettings()
  checkpoint(run)
  await dispatch(connectRequested(state))
  try {
    await ensureOffscreen()
    checkpoint(run)
    const response = await withTimeout(
      toOffscreen({
        type: 'li:connect',
        deviceOverrides: settings.deviceOverrides,
        floorLevel: settings.floorLevel,
      }),
      TIMEOUT.connect,
      '连接会议音频超时：请检查音频设备后重试。',
      run
    )
    checkpoint(run)
    await dispatch(bridgeConnected(state))
    return response
  } catch (err) {
    // 取消由 cancelStart 统一收尾，这里不报桥失败
    if (run.cancelled) throw START_CANCELLED
    await failBridge(classifyError(err))
    throw err
  }
}

// 桥失败（预检、授权、设备断开、离屏丢失）：撤掉一切并通知
async function failBridge(error) {
  await releaseAll(() => bridgeFailed(state, error))
  chrome.notifications.create(NOTIFY.bridgeFailed.id, {
    ...NOTIFICATION_STYLE,
    title: NOTIFY.bridgeFailed.title,
    message: failureCopy({ kind: 'bridge', error }),
  })
}

// 翻译层失败（宿主、凭证、网络、改语言重建）：同样撤掉一切并通知，失败态不占用麦克风
async function failTranslation(error) {
  await releaseAll(() => failed(state, error))
  chrome.notifications.create(NOTIFY.translationFailed.id, {
    ...NOTIFICATION_STYLE,
    title: NOTIFY.translationFailed.title,
    message: failureCopy({ kind: 'translation', error }),
  })
}

async function start() {
  const requested = requestStart(state)
  if (requested === state) return
  const run = beginStart()
  try {
    await dispatch(requested)
    const settings = await readSettings()
    checkpoint(run)
    await connectBridge(run)
    await withTimeout(connectHost(), TIMEOUT.host, '启动本地翻译服务超时：请重试或查看宿主日志。', run)
    checkpoint(run)
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
      '连接翻译服务超时：请检查网络后重试。',
      run
    )
    checkpoint(run)
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
    // 被取消：cancelStart 负责收尾，不落 error、不发通知
    if (run.cancelled) return
    // 桥失败已在 connectBridge 里撤干净并通知过，不再重复报翻译层失败
    if (state.bridge === 'failed') throw err
    await failTranslation(classifyError(err))
    throw err
  } finally {
    if (currentStart === run) currentStart = null
    run.finish()
  }
}

// 开启途中点「取消开启」：先让在途的 start() 所有长等待立刻结束、退栈后不再有副作用，
// 再把已经建起来的一切（桥、宿主、会话、离屏文档）撤干净，回到初始且不发任何通知
async function cancelStart() {
  const run = currentStart
  if (!run || run.cancelled) return { ok: false, reason: 'busy' }
  run.abort()
  await dispatch(requestStop(state))
  await run.done
  await releaseAll(() => stopped(state))
  return { ok: true }
}

// 关闭同传：翻译、本地服务、麦克风与音频设备全部释放
async function stop() {
  const requested = requestStop(state)
  if (requested === state) return
  await dispatch(requested)
  await releaseAll(() => stopped(state))
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
    let response
    try {
      response = await toOffscreen({ type: 'li:update-plan', plan: after, server: serverConfig() })
    } catch (err) {
      // 按新计划重建失败：翻译层整体 failed，桥不受影响
      await failTranslation(classifyError(err))
      return next
    }
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
    // 已撤掉的桥迟到的上报不再算数，否则会多弹一条失败通知
    if (state.bridge === 'connected' || state.bridge === 'connecting') await failBridge(classifyError(message.payload))
    return
  }
  // 设备变化不触发任何动作：不在同传中不占设备；同传中设备真掉了会由 bridge-lost 上报
  if (message.event === 'devicechange') return
  // error / closed：翻译层失败，撤掉一切；绝不自动重连
  if (state.phase === 'on' || state.phase === 'starting') {
    await failTranslation(classifyError(message.payload))
  }
}

const UI_HANDLERS = {
  'li:power': (message) => {
    // 开启途中点「取消开启」：唯一允许在过渡态进来的操作
    if (message.on === false && state.phase === 'starting') return cancelStart()
    if (isTransitioning()) return Promise.resolve({ ok: false, reason: 'busy' })
    return exclusive(() => (message.on ? start() : stop()))
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
    // 只信任来自 Meet 标签页的上报。本扩展没有 tabs 权限、也没有 meet 的 host
    // permission（content_scripts.matches 不算），Chrome 会把 sender.tab.url 裁成
    // undefined；sender.url 与 sender.tab.id 都不被裁剪，所以两处任一命中即可信。
    if (!sender.tab?.url?.startsWith(MEET_ORIGIN) && !sender.url?.startsWith(MEET_ORIGIN)) return false
    if (sender.tab?.id === undefined) return false
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

// 离屏文档的长连接：桥还在却断了连接，说明文档被 Chrome 关掉了（我们自己关的除外）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'li-keepalive') return
  port.onMessage.addListener((message) => {
    if (message?.type === 'ping') port.postMessage({ type: 'pong' })
  })
  port.onDisconnect.addListener(() => {
    if (closingOffscreen) return
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
