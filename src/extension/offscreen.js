import { startCapture, createPlayer, enumerateAudioDevices } from './audio.js'
import { openTranslationSession } from './session.js'
import { preflight } from '/shared/device-preflight.mjs'
import { buildFloorConstraints, forwardMicAudio, resolveSinkId } from '/shared/audio-routing.mjs'
import { DIRECTIONS } from '/shared/directions.mjs'
import { diffPlan } from '/shared/direction-plan.mjs'
import { selectSessionEndpoint } from '/shared/session-endpoint.mjs'
import { createDirectionSubtitles } from '/shared/direction-subtitles.mjs'
import { createLatencyTracker } from '/shared/latency.mjs'
import { classifyError, classifyMediaError } from '/shared/errors.mjs'

// 离屏文档：音频桥与翻译层的宿主。只做接线，判定全部来自 /shared。
//
// 桥（常驻）：每个方向一条 getUserMedia → MediaStreamSource → floorGain → 已 setSinkId
//   的 destination 的直通路。翻译只通过同一个 destination 混入，绝不断开直通。
// 翻译层（可撤）：每个 translate 方向一个会话 + 一路 24k 采集。撤它不动桥。

const KEEPALIVE_MS = 20000

const bridge = { roles: null, labels: null, dirs: null }
const live = { downlink: null, uplink: null }
const subtitles = createDirectionSubtitles()
const latency = createLatencyTracker()
let uplinkPaused = false
let plan = null
let server = null
let devicechangeBound = false
// 在途启动的世代号：撤翻译层（li:stop / li:disconnect）时自增，让还卡在 await 里的
// startDirection 知道自己已被作废——否则它会在宿主早已退出、SW 早已 error 之后继续
// 采集送音计费，并把译文 enqueue 进会议，还会覆盖 live[id] 让旧会话永不 close。
let epoch = 0
// 被作废不是真失败：SW 那边早已走完超时/失败流程，这个 reject 没人接
const CANCELLED = { category: 'api_error', message: '启动已被取消。' }

function cancelPendingStarts() {
  epoch += 1
}

function emit(event, directionId, payload) {
  chrome.runtime.sendMessage({ type: 'li:pipeline-event', to: 'sw', event, directionId, payload }).catch(() => {})
}

// ---------------------------------------------------------------- 桥

async function connectBridge({ deviceOverrides, floorLevel }) {
  // 幂等：失败态的 devicechange 重试会再发一次 li:connect，直接覆盖 bridge.dirs
  // 会把上一套 AudioContext / 直通 stream / 会话全部漏掉，每次拔插累积一份占用
  disconnectBridge()
  const devices = await enumerateAudioDevices()
  const conclusion = preflight(devices, deviceOverrides ?? {})
  if (conclusion.category !== 'ok') throw conclusion

  const dirs = {}
  const built = []
  try {
    // 设备角色来自方向表；桥与语言选择无关，所以用默认方向表的角色骨架
    for (const direction of Object.values(DIRECTIONS)) {
      const inputId = conclusion.roles[direction.inputRole]
      const stream = await navigator.mediaDevices.getUserMedia(buildFloorConstraints(inputId, direction.inputRole))
      let player
      try {
        player = await createPlayer(resolveSinkId(direction.id, conclusion.roles), {
          floorLevel,
          onPlaybackError: (err) => emit('bridge-lost', direction.id, classifyError(err)),
        })
      } catch (err) {
        // 播放器没建起来就没人接管这条 stream（逆序收尾只认已入册的方向），
        // 不在这里 stop 就会一直占着麦克风/虚拟声卡
        for (const track of stream.getTracks()) track.stop()
        throw err
      }
      player.attachFloor(stream)
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () =>
          emit('bridge-lost', direction.id, {
            category: 'device_missing',
            message: '会议音频设备已断开：请检查耳机与虚拟声卡后重新开启。',
          })
        )
      }
      dirs[direction.id] = { player, floorStream: stream }
      built.push(dirs[direction.id])
    }
  } catch (err) {
    // 逆序收尾：任何一路失败都不留半座桥
    for (const entry of built.reverse()) {
      try {
        entry.player.stop()
      } catch {
        // 已关闭的上下文忽略
      }
    }
    // getUserMedia / setSinkId 抛的是 DOMException（没有 category），不按名字分类就会被
    // classifyError 压成 api_error：通知文案与「无法连接会议音频」自相矛盾，
    // 且 device_missing 才触发的 devicechange 一次重试永远不会发生
    const category = classifyMediaError(err?.name)
    throw category === null ? err : { category }
  }

  bridge.roles = conclusion.roles
  bridge.labels = conclusion.labels
  bridge.dirs = dirs

  // 设备变化只上报，重试与否由 SW 决定（离屏不自作主张占用设备）
  if (!devicechangeBound) {
    devicechangeBound = true
    navigator.mediaDevices.addEventListener('devicechange', () => emit('devicechange', null, null))
  }
  return { roles: conclusion.roles, labels: conclusion.labels }
}

function disconnectBridge() {
  cancelPendingStarts()
  stopTranslation()
  for (const entry of Object.values(bridge.dirs ?? {})) {
    try {
      entry.player.stop()
    } catch {
      // 忽略重复关闭
    }
    for (const track of entry.floorStream.getTracks()) track.stop()
  }
  bridge.roles = null
  bridge.labels = null
  bridge.dirs = null
}

// ---------------------------------------------------------------- 翻译层

function stopDirection(directionId) {
  const entry = live[directionId]
  live[directionId] = null
  if (!entry) return
  try {
    entry.capture?.stop()
  } catch {
    // 采集已停
  }
  try {
    entry.session?.close()
  } catch {
    // 会话已关
  }
  bridge.dirs?.[directionId]?.player.flush()
}

function stopTranslation() {
  cancelPendingStarts()
  for (const id of Object.keys(live)) stopDirection(id)
}

function onSessionEvent(directionId, name, payload) {
  if (name === 'latency') {
    emit('latency', directionId, { ms: latency.getCurrentLatencyMs(directionId) })
    return
  }
  if (name !== 'error') return
  // 暂停期间上行被对端关闭是挂起而不是掉线：置空以便取消静音时重建
  if (directionId === 'uplink' && uplinkPaused) {
    stopDirection('uplink')
    emit('uplink-suspended', 'uplink', payload)
    return
  }
  emit('error', directionId, classifyError(payload))
}

async function startDirection(directionId) {
  const mine = epoch
  const direction = plan[directionId]
  // passthrough：不建会话、不采集、从不 enqueue，因此直通增益恒为 1.0
  if (direction.mode !== 'translate') return
  const endpoint = selectSessionEndpoint(server, { baseUrl: server.baseUrl, launchToken: server.launchToken })
  const session = await openTranslationSession({
    endpoint,
    directionId,
    directionTable: plan,
    audioSink: (bytes) => {
      if (directionId !== 'uplink') {
        bridge.dirs[directionId].player.enqueue(bytes)
        return
      }
      // 暂停期间到达的上行译文帧一律丢弃
      forwardMicAudio({ muted: uplinkPaused, chunk: bytes, sink: (b) => bridge.dirs.uplink.player.enqueue(b) })
    },
    subtitles: subtitles.for(directionId),
    latency,
    onEvent: (name, payload) => onSessionEvent(directionId, name, payload),
  })
  // 就绪判定：这个方向的会话真的 open 了、采集也起来了，才算可用
  try {
    await new Promise((resolve, reject) => {
      if (session.getState() === 'running') {
        resolve()
        return
      }
      session.on('open', resolve)
      session.on('error', reject)
      session.on('closed', reject)
    })
  } catch (err) {
    session.close()
    throw err
  }
  // 等 open 期间 li:stop / li:disconnect 作废了这次启动：别再去占采集设备
  if (mine !== epoch) {
    session.close()
    return
  }
  const capture = await startCapture(bridge.roles[direction.inputRole], (chunk) => {
    if (directionId === 'uplink') {
      forwardMicAudio({ muted: uplinkPaused, chunk, sink: (c) => session.sendAudio(c) })
      return
    }
    session.sendAudio(chunk)
  })
  // startCapture 也是异步的：写 live 之前再比一次，否则旧会话被覆盖后永不 close
  if (mine !== epoch) {
    capture.stop()
    session.close()
    return
  }
  live[directionId] = { session, capture }
}

async function startTranslation(message) {
  plan = message.plan
  server = message.server
  uplinkPaused = message.uplinkPaused === true
  const directions = {}
  const mine = epoch
  try {
    for (const id of Object.keys(plan)) {
      // 每轮开头与每次 await 之后都确认这次启动还算数：被作废就不得回 ok，
      // 否则 SW 会把早已收尾的方向标成 running
      if (mine !== epoch) throw CANCELLED
      await startDirection(id)
      if (mine !== epoch) throw CANCELLED
      directions[id] = { status: 'running', mode: plan[id].mode }
    }
  } catch (err) {
    // 一个方向失败即整体失败：已开的会话全部关掉，桥不动
    stopTranslation()
    throw err
  }
  applyPauseGate()
  return directions
}

// 暂停上行只影响上行：门控送音、丢弃已排队的译文、直通抬回 1.0 且不再压低
function applyPauseGate() {
  const dir = bridge.dirs?.uplink
  if (!dir) return
  if (uplinkPaused) dir.player.flush()
  dir.player.holdFloorFull(uplinkPaused)
}

async function setUplinkPaused(paused) {
  uplinkPaused = paused === true
  applyPauseGate()
  const restarted = []
  if (!uplinkPaused && plan?.uplink?.mode === 'translate' && live.uplink === null) {
    await startDirection('uplink')
    restarted.push('uplink')
  }
  return restarted
}

async function updatePlan(message) {
  const next = message.plan
  server = message.server ?? server
  const changed = diffPlan(plan, next)
  for (const id of changed) {
    stopDirection(id)
    plan = { ...plan, [id]: next[id] }
    await startDirection(id)
  }
  plan = next
  applyPauseGate()
  return changed
}

// ---------------------------------------------------------------- 消息

const HANDLERS = {
  'li:connect': (message) => connectBridge(message),
  'li:disconnect': () => {
    disconnectBridge()
    return {}
  },
  'li:start': (message) => startTranslation(message).then((directions) => ({ directions })),
  'li:stop': () => {
    stopTranslation()
    for (const entry of Object.values(bridge.dirs ?? {})) entry.player.holdFloorFull(false)
    return {}
  },
  'li:update-plan': (message) => updatePlan(message).then((restarted) => ({ restarted })),
  'li:set-uplink-paused': (message) => setUplinkPaused(message.paused).then((restarted) => ({ restarted })),
  'li:set-floor': (message) => {
    for (const entry of Object.values(bridge.dirs ?? {})) entry.player.setFloorLevel(message.level)
    return {}
  },
  'li:server-changed': (message) => {
    server = message.server
    return {}
  },
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.to !== 'offscreen') return false
  const handler = HANDLERS[message.type]
  if (!handler) return false
  Promise.resolve()
    .then(() => handler(message))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: classifyError(err) }))
  return true
})

// 长连接：SW 靠它感知离屏文档是否还在（桥已连时端口断开 = 文档被 Chrome 关掉）；
// 定时 ping 同时把空闲 30s 就终止的 SW 顶住。
const port = chrome.runtime.connect({ name: 'li-keepalive' })
setInterval(() => {
  try {
    port.postMessage({ type: 'ping' })
  } catch {
    // 端口已断，SW 会在 onDisconnect 里处理
  }
}, KEEPALIVE_MS)
