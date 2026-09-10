import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { buildDirections, DEFAULT_SETTINGS } from '../../src/shared/direction-plan.mjs'
import { FLOOR_RELEASE_MS } from '../../src/shared/floor.mjs'

// 离屏文档的整体验证：用假的 Web Audio / mediaDevices / WebSocket / chrome API
// 跑真正的 offscreen.js + audio.js + session.js + 全部 shared 纯逻辑。
//
// 覆盖的是 SW 之下、真实音频硬件之上的那一层：桥的建立与幂等、就绪判定（等 open
// 再采集、全部就绪才回 ok）、在途启动的取消、上行暂停的门控与衬底、失败收尾的资源释放。
// 真实设备行为（getUserMedia 能否并存、setSinkId 是否生效、ramp 听感）只能实机验证。
//
// 加载方式与 background-flow.test.mjs 一致：offscreen.js / audio.js / session.js 里的
// '/shared/x.mjs' 是扩展根绝对路径，Node 解析不了，因此把 import 说明符改写成本仓库的
// file:// 路径后再 import——除说明符外一字不改。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SHARED_URL = pathToFileURL(path.join(ROOT, 'src', 'shared')).href
const EXT_FILES = ['offscreen.js', 'audio.js', 'session.js']
const PLAN = buildDirections(DEFAULT_SETTINGS)
const SERVER = {
  baseUrl: 'http://127.0.0.1:51234',
  backend: 'mock',
  mockWsUrl: 'ws://127.0.0.1:51235',
  launchToken: 'launch-token-must-not-leak',
  port: 51234,
}
// 两块 BlackHole（2ch/16ch）+ 真耳机 + 真麦克风：preflight 的最小通过集合
const DEVICES = [
  { deviceId: 'bh2-in', kind: 'audioinput', label: 'BlackHole 2ch', groupId: 'bh2' },
  { deviceId: 'bh2-out', kind: 'audiooutput', label: 'BlackHole 2ch', groupId: 'bh2' },
  { deviceId: 'bh16-in', kind: 'audioinput', label: 'BlackHole 16ch', groupId: 'bh16' },
  { deviceId: 'bh16-out', kind: 'audiooutput', label: 'BlackHole 16ch', groupId: 'bh16' },
  { deviceId: 'hp-out', kind: 'audiooutput', label: '真耳机', groupId: 'hp' },
  { deviceId: 'hp-in', kind: 'audioinput', label: '真麦克风', groupId: 'hp' },
]

let loadCounter = 0

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settle(times = 12) {
  for (let i = 0; i < times; i++) await tick()
}

// ---------------------------------------------------------------- 假 Web Audio

function createFakeAudio() {
  const contexts = []

  class FakeAudioParam {
    constructor() {
      this.value = 1
      this.ramps = []
    }
    cancelScheduledValues() {}
    setValueAtTime(value) {
      this.value = value
    }
    linearRampToValueAtTime(target, at) {
      this.ramps.push({ target, at })
      // 假上下文不跑时钟：ramp 目标立即生效，便于断言最终增益
      this.value = target
    }
    setTargetAtTime(target) {
      this.ramps.push({ target, at: null })
      this.value = target
    }
  }

  class FakeAudioContext {
    constructor(options = {}) {
      this.options = options
      this.sampleRate = options.sampleRate ?? 48000
      this.state = 'suspended'
      this.createdAt = Date.now()
      this.destination = { id: 'destination' }
      this.gains = []
      this.sources = []
      this.streamSources = []
      this.processors = []
      this.sinkId = null
      this.resumed = 0
      this.listeners = new Map()
      this.closed = false
      contexts.push(this)
      if (FakeAudioContext.onCreate) FakeAudioContext.onCreate(this)
    }
    // 真实上下文的时钟按真实时间走；用例全在毫秒级完成，所以断言都落在头 0.7 s 内
    get currentTime() {
      return this.closed ? 0 : (Date.now() - this.createdAt) / 1000
    }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, [])
      this.listeners.get(name).push(fn)
    }
    async setSinkId(id) {
      if (FakeAudioContext.sinkIdFailure) throw FakeAudioContext.sinkIdFailure
      this.sinkId = id
    }
    async resume() {
      this.resumed += 1
      this.state = 'running'
    }
    createGain() {
      const gain = {
        gain: new FakeAudioParam(),
        connected: [],
        connect: (node) => gain.connected.push(node),
        disconnect: () => gain.connected.splice(0),
      }
      this.gains.push(gain)
      return gain
    }
    createMediaStreamSource(stream) {
      const node = {
        stream,
        connected: [],
        connect: (target) => node.connected.push(target),
        disconnect: () => node.connected.splice(0),
      }
      this.streamSources.push(node)
      return node
    }
    createBuffer(channels, frames, rate) {
      const data = new Float32Array(frames)
      return { duration: frames / rate, getChannelData: () => data }
    }
    createBufferSource() {
      const src = {
        buffer: null,
        started: null,
        stopped: 0,
        onended: null,
        connect: () => {},
        disconnect: () => {},
        start: (at) => {
          src.started = at
        },
        stop: () => {
          src.stopped += 1
        },
      }
      this.sources.push(src)
      return src
    }
    createScriptProcessor() {
      const processor = { onaudioprocess: null, connect: () => {}, disconnect: () => {} }
      this.processors.push(processor)
      return processor
    }
    close() {
      this.closed = true
      this.state = 'closed'
    }
  }
  FakeAudioContext.sinkIdFailure = null
  FakeAudioContext.onCreate = null

  return { contexts, FakeAudioContext }
}

function makeTrack(label) {
  return {
    label,
    readyState: 'live',
    listeners: [],
    addEventListener(name, fn) {
      this.listeners.push({ name, fn })
    },
    stop() {
      this.readyState = 'ended'
    },
    end() {
      this.readyState = 'ended'
      for (const entry of this.listeners) if (entry.name === 'ended') entry.fn()
    },
  }
}

// ---------------------------------------------------------------- 假 WebSocket

function createFakeWebSocket() {
  const instances = []
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url
      this.protocols = protocols
      this.readyState = 0
      this.sent = []
      this.closedTimes = 0
      this.listeners = new Map()
      instances.push(this)
      if (FakeWebSocket.autoOpen) queueMicrotask(() => this.fireOpen())
    }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, [])
      this.listeners.get(name).push(fn)
    }
    dispatch(name, event) {
      for (const fn of this.listeners.get(name) ?? []) fn(event)
    }
    fireOpen() {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.dispatch('open', {})
    }
    // 喂一帧译文音频（base64 的 PCM16）
    feedAudio(bytes = 480) {
      const buffer = new Uint8Array(bytes)
      const delta = Buffer.from(buffer).toString('base64')
      this.dispatch('message', { data: JSON.stringify({ type: 'session.output_audio.delta', delta }) })
    }
    send(data) {
      this.sent.push(data)
    }
    close() {
      this.closedTimes += 1
      this.readyState = 3
      this.dispatch('close', {})
    }
  }
  FakeWebSocket.autoOpen = true
  return { instances, FakeWebSocket }
}

// ---------------------------------------------------------------- 环境

function createEnv() {
  const { contexts, FakeAudioContext } = createFakeAudio()
  const { instances: sockets, FakeWebSocket } = createFakeWebSocket()
  const events = []
  const streams = []
  const swListeners = []
  const deviceChangeListeners = []
  let getUserMediaFailure = null

  const mediaDevices = {
    enumerateDevices: async () => DEVICES,
    getUserMedia: async (constraints) => {
      if (getUserMediaFailure) throw getUserMediaFailure
      const track = makeTrack(constraints.audio.deviceId.exact)
      const stream = { constraints, tracks: [track], getTracks: () => [track] }
      streams.push(stream)
      return stream
    },
    addEventListener: (name, fn) => {
      if (name === 'devicechange') deviceChangeListeners.push(fn)
    },
  }

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => swListeners.push(fn) },
      sendMessage: async (message) => {
        events.push(message)
        return { ok: true }
      },
      connect: () => ({ onMessage: { addListener() {} }, postMessage() {} }),
    },
  }

  const env = {
    contexts,
    sockets,
    events,
    streams,
    FakeAudioContext,
    FakeWebSocket,
    mediaDevices,
    chrome,
    failGetUserMedia: (err) => {
      getUserMediaFailure = err
    },
    fireDeviceChange: async () => {
      for (const fn of deviceChangeListeners) fn()
      await settle()
    },
    // 播放器上下文 = 没有强制采样率的那些；采集上下文 = 24k 的那些
    players: () => contexts.filter((c) => c.options.sampleRate === undefined),
    captures: () => contexts.filter((c) => c.options.sampleRate === 24000),
    openPlayers: () => env.players().filter((c) => !c.closed),
    floorGainOf: (ctx) => ctx.gains[0],
    async send(message) {
      let response
      for (const listener of swListeners) {
        const kept = listener({ ...message, to: 'offscreen' }, {}, (value) => {
          response = value
        })
        if (kept === true) {
          for (let i = 0; i < 60 && response === undefined; i++) await tick()
        }
      }
      await settle()
      return response
    },
    // 不等回执地发出去：用来制造「li:start 还在途中就收到 li:stop」
    sendNoWait(message) {
      let response
      const done = { settled: false, value: undefined }
      for (const listener of swListeners) {
        listener({ ...message, to: 'offscreen' }, {}, (value) => {
          response = value
          done.settled = true
          done.value = value
        })
      }
      return done
    },
    connect: (overrides = {}) => env.send({ type: 'li:connect', deviceOverrides: {}, floorLevel: 0.25, ...overrides }),
  }
  return env
}

// 只改写 import 说明符，其余源码原样运行
async function loadOffscreen(env) {
  const dir = await mkdtemp(path.join(tmpdir(), 'li-off-'))
  for (const name of EXT_FILES) {
    const source = await readFile(path.join(ROOT, 'src', 'extension', name), 'utf8')
    const rewritten = source.replace(/from '\/shared\//g, `from '${SHARED_URL}/`)
    assert.equal(
      rewritten.replace(new RegExp(SHARED_URL, 'g'), '/shared').length,
      source.length,
      `${name}：除 import 说明符外不得改动任何字符`
    )
    await writeFile(path.join(dir, name), rewritten)
  }
  globalThis.chrome = env.chrome
  globalThis.AudioContext = env.FakeAudioContext
  globalThis.WebSocket = env.FakeWebSocket
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: env.mediaDevices },
    configurable: true,
    writable: true,
  })
  // keepalive 的 setInterval 不得拖住测试进程；定时器本身保留，只 unref
  const realSetInterval = globalThis.setInterval
  const timers = []
  globalThis.setInterval = (fn, ms) => {
    const timer = realSetInterval(fn, ms)
    timer.unref?.()
    timers.push(timer)
    return timer
  }
  try {
    loadCounter += 1
    await import(pathToFileURL(path.join(dir, 'offscreen.js')).href)
  } finally {
    globalThis.setInterval = realSetInterval
  }
  await settle()
  return env
}

// 每个用例一份独立模块实例：offscreen.js 的 bridge/live/epoch 都是模块级状态
async function freshOffscreen() {
  const env = createEnv()
  await loadOffscreen(env)
  return env
}

// 驱动一次采集回调（ScriptProcessor 在真实环境由音频线程触发）
function pumpCapture(ctx) {
  const processor = ctx.processors[0]
  assert.ok(processor?.onaudioprocess, '采集上下文必须挂上 onaudioprocess')
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(240) } })
}

test('AC-136 li:connect：两方向各一条直通路，约束分角色，输出已 setSinkId', async () => {
  const env = await freshOffscreen()
  const response = await env.connect()

  assert.equal(response.ok, true)
  assert.deepEqual(response.roles, { capture: 'bh2-in', virtualMic: 'bh16-out', monitor: 'hp-out', mic: 'hp-in' })
  assert.equal(env.players().length, 2, '每个方向一个播放器上下文')
  assert.equal(env.captures().length, 0, '建桥阶段不得起采集（那是翻译层的事）')

  // 直通约束：capture 三项处理全关，mic 开 AEC/NS、关 AGC
  assert.deepEqual(env.streams[0].constraints.audio, {
    deviceId: { exact: 'bh2-in' },
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
  })
  assert.deepEqual(env.streams[1].constraints.audio, {
    deviceId: { exact: 'hp-in' },
    echoCancellation: true,
    autoGainControl: false,
    noiseSuppression: true,
  })
  assert.deepEqual(
    env.players().map((c) => c.sinkId),
    ['hp-out', 'bh16-out'],
    'downlink 出耳机、uplink 出虚拟麦克风'
  )

  // 直通路：MediaStreamSource → floorGain → destination，增益 1.0
  for (const ctx of env.players()) {
    const floorGain = env.floorGainOf(ctx)
    assert.equal(ctx.streamSources.length, 1)
    assert.deepEqual(ctx.streamSources[0].connected, [floorGain])
    assert.ok(floorGain.connected.includes(ctx.destination))
    assert.equal(floorGain.gain.value, 1, '刚建好的直通增益必须是 1.0')
  }
  // 建桥期间不得建会话
  assert.equal(env.sockets.length, 0)
})

test('AC-136 li:connect 幂等：连发两次不得叠出第二套 AudioContext 与直通 stream', async () => {
  const env = await freshOffscreen()
  await env.connect()
  const firstContexts = env.players()
  const firstStreams = [...env.streams]

  // 失败态的 devicechange 重试会再发一次 li:connect
  const again = await env.connect()
  assert.equal(again.ok, true)

  assert.equal(env.openPlayers().length, 2, `连发两次 li:connect 后仍只能有两个活上下文，实际 ${env.openPlayers().length}`)
  assert.equal(env.players().length, 4, '第二次确实新建了一套（旧的必须已关闭）')
  for (const ctx of firstContexts) assert.equal(ctx.closed, true, '上一套 AudioContext 必须关闭')
  for (const stream of firstStreams) {
    for (const track of stream.getTracks()) {
      assert.equal(track.readyState, 'ended', '上一套直通 track 必须停止，否则麦克风一直被占')
    }
  }
})

test('AC-136 createPlayer 失败：已拿到的直通 stream 必须释放，错误按媒体名归类', async () => {
  const env = await freshOffscreen()
  const failure = Object.assign(new Error('sink 不可用'), { name: 'NotFoundError' })
  env.FakeAudioContext.sinkIdFailure = failure

  const response = await env.connect()
  assert.equal(response.ok, false)
  assert.equal(response.error.category, 'device_missing', 'DOMException 必须按 name 归类，不得压成 api_error')
  assert.ok(env.streams.length > 0, '失败前已经 getUserMedia 过')
  for (const stream of env.streams) {
    for (const track of stream.getTracks()) {
      assert.equal(track.readyState, 'ended', 'createPlayer 失败时没人接管这条 stream，必须在原地停掉')
    }
  }
})

test('AC-143 li:start：每个 translate 方向都 open 且 startCapture 返回后才回 ok', async () => {
  const env = await freshOffscreen()
  await env.connect()
  env.FakeWebSocket.autoOpen = false

  const pending = env.sendNoWait({ type: 'li:start', plan: PLAN, uplinkPaused: false, server: SERVER })
  await settle()
  assert.equal(env.sockets.length, 1, '方向是串行起的：第一条会话 open 之前不得建第二条')
  assert.equal(env.captures().length, 0, 'open 之前绝不 startCapture')
  assert.equal(pending.settled, false, 'open 之前不得回 ok')

  env.sockets[0].fireOpen()
  await settle()
  assert.equal(env.captures().length, 1, 'open 之后才起采集')
  assert.equal(env.sockets.length, 2, '第一个方向就绪后才轮到第二个')
  assert.equal(pending.settled, false, '只有一个方向就绪时仍不得回 ok')

  env.sockets[1].fireOpen()
  await settle()
  assert.equal(pending.settled, true)
  assert.deepEqual(pending.value, {
    ok: true,
    directions: {
      downlink: { status: 'running', mode: 'translate' },
      uplink: { status: 'running', mode: 'translate' },
    },
  })
  assert.equal(env.captures().length, 2)
  // 每个方向的 session.update 带本方向的目标语言
  for (const [index, id] of ['downlink', 'uplink'].entries()) {
    const update = JSON.parse(env.sockets[index].sent[0])
    assert.equal(update.type, 'session.update')
    assert.equal(update.session.audio.output.language, PLAN[id].target)
  }
})

test('AC-143 在途启动可取消：等 open 期间收到 li:stop 后会话与采集都不得留下', async () => {
  const env = await freshOffscreen()
  await env.connect()
  env.FakeWebSocket.autoOpen = false

  const pending = env.sendNoWait({ type: 'li:start', plan: PLAN, uplinkPaused: false, server: SERVER })
  await settle()
  env.sockets[0].fireOpen()
  await settle()
  assert.equal(env.sockets.length, 2, '此刻 uplink 正卡在等 open')

  // SW 侧 li:start 超时 / 桥失败 → 发 li:stop
  assert.deepEqual(await env.send({ type: 'li:stop' }), { ok: true })
  assert.equal(env.captures()[0].closed, true, 'downlink 的采集必须停')
  assert.equal(env.sockets[0].closedTimes, 1, 'downlink 的会话必须关')

  // 迟到的 open：在途的 startDirection 必须就地收尾，不得占设备、不得写 live
  env.sockets[1].fireOpen()
  await settle()
  assert.equal(env.sockets[1].closedTimes, 1, '被作废的会话必须 close，否则一直挂着计费')
  for (const ctx of env.captures()) {
    assert.equal(ctx.closed, true, `被作废的采集必须 stop，实际还有活的采集上下文`)
  }
  assert.equal(pending.settled, true)
  assert.equal(pending.value.ok, false, '被作废的启动不得回 ok')

  // live.uplink 确实为空：取消暂停时会按需重建正是这个证据
  env.FakeWebSocket.autoOpen = true
  const resumed = await env.send({ type: 'li:set-uplink-paused', paused: false })
  assert.deepEqual(resumed.restarted, ['uplink'], 'live.uplink 必须已是 null（否则不会重建）')
})

test('AC-132/AC-143 取消静音的重建也能被作废：迟到的 open 不得占走麦克风', async () => {
  const env = await freshOffscreen()
  await env.connect()
  await env.send({ type: 'li:start', plan: PLAN, uplinkPaused: false, server: SERVER })

  // 静音 → 上行被对端关闭 → 挂起（live.uplink 置空，等取消静音时重建）
  await env.send({ type: 'li:set-uplink-paused', paused: true })
  env.events.length = 0
  env.sockets[1].close()
  await settle()
  assert.deepEqual(
    env.events.map((e) => e.event),
    ['uplink-suspended'],
    '暂停期间被对端关闭只算挂起，不算掉线'
  )
  const capturesBeforeRebuild = env.captures().length

  // 取消静音触发重建，但重建还卡在等 open 时桥失败/停止同传就到了
  env.FakeWebSocket.autoOpen = false
  const rebuilding = env.sendNoWait({ type: 'li:set-uplink-paused', paused: false })
  await settle()
  assert.equal(env.sockets.length, 3, '必须真的在重建上行会话')
  assert.equal(env.captures().length, capturesBeforeRebuild, 'open 之前不得起采集')

  await env.send({ type: 'li:stop' })
  env.sockets[2].fireOpen()
  await settle()

  // 这条路径不经 startTranslation，只有 startDirection 自己的作废检查能救
  assert.equal(env.sockets[2].closedTimes, 1, '被作废的重建会话必须 close')
  assert.equal(
    env.captures().length,
    capturesBeforeRebuild,
    `被作废的重建不得再 startCapture（否则麦克风被一条无人管的采集占着），实际多出 ${env.captures().length - capturesBeforeRebuild} 条`
  )
  for (const ctx of env.captures()) assert.equal(ctx.closed, true, '撤翻译层后不得留任何活的采集上下文')
  assert.equal(rebuilding.settled, true)
})

test('AC-131 li:set-uplink-paused：只掐上行，下行对象引用与数据流不受影响', async () => {
  const env = await freshOffscreen()
  await env.connect()
  const [downCtx, upCtx] = env.players()
  await env.send({ type: 'li:start', plan: PLAN, uplinkPaused: false, server: SERVER })
  const [downSocket, upSocket] = env.sockets

  // 暂停前：上行送音与译文入队都正常
  pumpCapture(env.captures()[1])
  upSocket.feedAudio()
  await settle()
  const sentBefore = upSocket.sent.length
  assert.ok(sentBefore > 1, '暂停前上行必须真的在送音')
  assert.equal(upCtx.sources.length, 1, '暂停前上行译文必须真的在入队')
  const queued = upCtx.sources[0]

  const paused = await env.send({ type: 'li:set-uplink-paused', paused: true })
  assert.deepEqual(paused, { ok: true, restarted: [] })

  // flush：已排队的译文立即停声
  assert.equal(queued.stopped, 1, '暂停必须 flush 掉已排队的上行译文')
  // holdFloorFull(true)：上行直通抬回 1.0 且不再压低
  const upFloor = env.floorGainOf(upCtx)
  assert.equal(upFloor.gain.value, 1, '暂停期间上行直通必须是 1.0')

  // 门控：送音与入队都不再发生
  pumpCapture(env.captures()[1])
  upSocket.feedAudio()
  await settle()
  assert.equal(upSocket.sent.length, sentBefore, '暂停期间不得再调用 session.sendAudio')
  assert.equal(upCtx.sources.length, 1, '暂停期间到达的上行译文帧必须丢弃')
  assert.equal(upFloor.gain.value, 1, '丢弃译文后上行直通仍是 1.0')

  // 下行：对象引用不变、数据流照常
  assert.equal(env.players()[0], downCtx, '下行播放器引用不得变化')
  assert.equal(env.captures()[0].closed, false, '下行采集不得被牵连')
  pumpCapture(env.captures()[0])
  downSocket.feedAudio()
  await settle()
  assert.equal(downCtx.sources.length, 1, '下行译文必须继续入队')
  assert.ok(
    env.floorGainOf(downCtx).gain.value < 1,
    '下行衬底照常：播译文时把直通压低'
  )

  // 取消暂停：会话还 running 就不重建
  const resumed = await env.send({ type: 'li:set-uplink-paused', paused: false })
  assert.deepEqual(resumed, { ok: true, restarted: [] })
  assert.equal(env.players().length, 2, '取消暂停不得新建播放器')
  pumpCapture(env.captures()[1])
  await settle()
  assert.ok(upSocket.sent.length > sentBefore, '取消暂停后必须立即恢复送音')
})

test('AC-137 衬底不得在上下文时钟头 0.7 s 里误判「正在播译文」', async () => {
  const env = await freshOffscreen()
  await env.connect()
  // ctx.currentTime 仍是 0，远小于 FLOOR_RELEASE_MS：此时归零的 playhead 不得被当成「在播」
  for (const ctx of env.players()) {
    assert.equal(env.floorGainOf(ctx).gain.value, 1, 'attachFloor 之后直通必须满音量')
  }

  await env.send({ type: 'li:start', plan: PLAN, uplinkPaused: false, server: SERVER })
  const upCtx = env.players()[1]
  env.sockets[1].feedAudio()
  await settle()
  assert.ok(env.floorGainOf(upCtx).gain.value < 1, '播译文时必须压低')

  // flush（暂停或撤翻译层）→ 立刻回 1.0，而不是等 0.7 s 的释放窗口
  assert.ok(upCtx.currentTime < FLOOR_RELEASE_MS / 1000, '本用例必须落在上下文时钟的头 0.7 s 内')
  await env.send({ type: 'li:stop' })
  for (const ctx of env.players()) {
    assert.equal(env.floorGainOf(ctx).gain.value, 1, 'flush 之后直通必须立即回 1.0')
  }
})

test('AC-110 passthrough 方向：不建会话、不采集、直通恒为 1.0', async () => {
  const env = await freshOffscreen()
  await env.connect()
  const plan = buildDirections({ ...DEFAULT_SETTINGS, partnerHears: 'original' })

  const response = await env.send({ type: 'li:start', plan, uplinkPaused: false, server: SERVER })
  assert.deepEqual(response.directions, {
    downlink: { status: 'running', mode: 'translate' },
    uplink: { status: 'running', mode: 'passthrough' },
  })
  assert.equal(env.sockets.length, 1, 'passthrough 方向不得建 WebSocket')
  assert.equal(env.captures().length, 1, 'passthrough 方向不得采集')
  assert.equal(env.floorGainOf(env.players()[1]).gain.value, 1, 'passthrough 方向直通恒为 1.0')
})

test('AC-133 直通 track 被系统结束 → 上报 bridge-lost；devicechange 只上报不自作主张', async () => {
  const env = await freshOffscreen()
  await env.connect()
  env.events.length = 0

  await env.fireDeviceChange()
  assert.deepEqual(
    env.events.map((e) => e.event),
    ['devicechange'],
    '离屏对设备变化只上报，重试与否由 SW 决定'
  )
  assert.equal(env.players().length, 2, '离屏不得自己重建桥')

  env.events.length = 0
  env.streams[0].getTracks()[0].end()
  await settle()
  assert.equal(env.events.length, 1)
  assert.equal(env.events[0].event, 'bridge-lost')
  assert.equal(env.events[0].payload.category, 'device_missing')
})

test('AC-140 li:disconnect：撤翻译层后停全部播放器与直通 track', async () => {
  const env = await freshOffscreen()
  await env.connect()
  await env.send({ type: 'li:start', plan: PLAN, uplinkPaused: false, server: SERVER })

  assert.deepEqual(await env.send({ type: 'li:disconnect' }), { ok: true })
  for (const ctx of env.players()) assert.equal(ctx.closed, true, '播放器上下文必须全部关闭')
  for (const ctx of env.captures()) assert.equal(ctx.closed, true, '采集上下文必须全部关闭')
  for (const socket of env.sockets) assert.equal(socket.closedTimes, 1, '会话必须全部关闭')
  for (const stream of env.streams) {
    for (const track of stream.getTracks()) assert.equal(track.readyState, 'ended')
  }
})
