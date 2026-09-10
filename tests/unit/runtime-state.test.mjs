import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  statusCopy,
  readyCopy,
  failureCopy,
  stripSecrets,
  BADGE_COLORS,
  NOTIFY,
  STEP_TEXT,
  RECOVERY_BRIDGE_LOST,
  RECOVERY_HALF_DONE,
} from '../../src/shared/runtime-state.mjs'
import { buildDirections } from '../../src/shared/direction-plan.mjs'

const ERR = { category: 'api_error', message: '出错了。' }
const DEVICE_ERR = { category: 'device_missing', message: '缺设备。' }
const RUNNING = { downlink: { status: 'running', mode: 'translate' }, uplink: { status: 'running', mode: 'translate' } }
const SERVER = { port: 51234, backend: 'mock' }
const LANGS = { hear: 'zh', partnerHears: 'en' }

// 冷启动到「同传进行中」的那条路径，后续用例都从这里分叉
function onState(overrides = {}) {
  let s = createInitialRuntime()
  s = requestStart(s)
  s = connectRequested(s)
  s = bridgeConnected(s)
  s = hostReady(s)
  s = started(s, { directions: RUNNING, server: SERVER, languages: LANGS, at: 1725000000000 })
  return { ...s, ...overrides }
}

test('AC-120 初始态形状', () => {
  assert.deepEqual(createInitialRuntime(), {
    bridge: 'disconnected',
    bridgeError: null,
    phase: 'off',
    startStep: null,
    error: null,
    meetingMuted: null,
    directions: { downlink: { status: 'stopped', mode: null }, uplink: { status: 'stopped', mode: null } },
    server: null,
    languages: null,
    latencyMs: null,
    since: null,
  })
})

test('AC-120 合法转换返回新对象且不改入参；非法转换返回同一引用', () => {
  const s0 = createInitialRuntime()
  const frozen = JSON.stringify(s0)
  const s1 = connectRequested(s0)
  assert.notEqual(s1, s0)
  assert.equal(s1.bridge, 'connecting')
  assert.equal(JSON.stringify(s0), frozen, '入参不得被原地修改')

  // connectRequested 只接受 disconnected / failed
  assert.equal(connectRequested(s1), s1, 'connecting 时再请求连接无效')
  const connected = bridgeConnected(s1)
  assert.equal(connectRequested(connected), connected)
  assert.equal(bridgeConnected(connected), connected, 'bridgeConnected 只在 connecting 有效')
  assert.equal(bridgeConnected(s0), s0)

  // hostReady 只在 starting 有效
  assert.equal(hostReady(connected), connected)
  assert.equal(started(connected, { directions: RUNNING }), connected, 'started 只在 starting 有效')
  assert.equal(stopped(connected), connected, 'stopped 只在 stopping 有效')
  assert.equal(requestStop(connected), connected, 'phase=off 时无可停止的翻译层')
  assert.equal(uplinkSuspended(connected), connected)
  assert.equal(uplinkResumed(connected), connected)
  assert.equal(planApplied(connected, { directions: RUNNING }), connected)
  assert.equal(latency(connected, { ms: 900 }), connected)
})

test('AC-120/AC-142 requestStart 的起始步骤取决于桥是否已连接', () => {
  const fresh = requestStart(createInitialRuntime())
  assert.equal(fresh.phase, 'starting')
  assert.equal(fresh.startStep, 'bridge')

  const warm = requestStart(bridgeConnected(connectRequested(createInitialRuntime())))
  assert.equal(warm.phase, 'starting')
  assert.equal(warm.startStep, 'host')

  // 冷启动的 startStep 序列：bridge → host → translation → null
  let s = requestStart(createInitialRuntime())
  assert.deepEqual([s.phase, s.startStep], ['starting', 'bridge'])
  s = connectRequested(s)
  assert.deepEqual([s.bridge, s.startStep], ['connecting', 'bridge'])
  s = bridgeConnected(s)
  assert.deepEqual([s.bridge, s.startStep], ['connected', 'host'])
  s = hostReady(s)
  assert.equal(s.startStep, 'translation')
  s = started(s, { directions: RUNNING, server: SERVER, languages: LANGS, at: 7 })
  assert.deepEqual([s.phase, s.startStep], ['on', null])
  assert.deepEqual(s.directions, RUNNING)
  assert.deepEqual(s.server, SERVER)
  assert.deepEqual(s.languages, LANGS)
  assert.equal(s.since, 7)

  // error 态可直接重试；失败时桥已一并撤掉，所以重试从第一步开始
  const retried = requestStart(failed(s, ERR))
  assert.equal(retried.phase, 'starting')
  assert.equal(retried.error, null)
  assert.equal(retried.startStep, 'bridge', '失败即释放桥，重试从连接会议音频开始')
})

test('AC-120/AC-147/AC-148 桥失败把翻译层一并打停；关闭、取消、翻译失败的终态都不留桥', () => {
  const s = onState()
  const after = bridgeFailed(s, DEVICE_ERR)
  assert.equal(after.bridge, 'failed')
  assert.deepEqual(after.bridgeError, DEVICE_ERR)
  assert.equal(after.phase, 'error')
  assert.deepEqual(after.error, DEVICE_ERR)
  assert.equal(after.startStep, null)
  assert.deepEqual(after.directions, createInitialRuntime().directions)
  assert.equal(after.server, null)
  assert.equal(after.languages, null)

  // phase=off 时桥失败不制造翻译层错误
  const idle = bridgeConnected(connectRequested(createInitialRuntime()))
  const idleFailed = bridgeFailed(idle, DEVICE_ERR)
  assert.equal(idleFailed.bridge, 'failed')
  assert.equal(idleFailed.phase, 'off')
  assert.equal(idleFailed.error, null)

  // 非开启状态不占用设备：翻译层失败与关闭的终态里桥一律是 disconnected（AC-147/AC-148）
  const failedState = failed(meetingMute(onState(), true), ERR)
  assert.deepEqual(failedState, { ...createInitialRuntime(), meetingMuted: true, phase: 'error', error: ERR })
  const stoppedState = stopped(requestStop(meetingMute(onState(), true)))
  assert.deepEqual(stoppedState, { ...createInitialRuntime(), meetingMuted: true }, '关闭回到初始，只保留会议静音态')
  // 开启途中取消（AC-146）：starting → stopping → 初始，不论桥走到了哪一步
  for (const midway of [requestStart(createInitialRuntime()), connectRequested(requestStart(createInitialRuntime())), hostReady(bridgeConnected(connectRequested(requestStart(createInitialRuntime()))))]) {
    const stopping = requestStop(midway)
    assert.equal(stopping.phase, 'stopping', `从 startStep=${midway.startStep} 取消必须先进入 stopping`)
    assert.deepEqual(stopped(stopping), createInitialRuntime())
  }
  // bridgeFailed 只从 connecting / connected 出发
  const never = createInitialRuntime()
  assert.equal(bridgeFailed(never, ERR), never)
})

test('AC-120 disconnected 回到初始形状但保留 meetingMuted', () => {
  const s = meetingMute(onState(), true)
  const after = disconnected(s)
  assert.deepEqual(after, { ...createInitialRuntime(), meetingMuted: true })
  assert.equal(disconnected(meetingMute(s, null)).meetingMuted, null)
})

test('AC-120/AC-131 meetingMute 在任何 phase 都只改一个字段', () => {
  for (const base of [createInitialRuntime(), requestStart(createInitialRuntime()), onState()]) {
    const after = meetingMute(base, true)
    assert.equal(after.meetingMuted, true)
    assert.deepEqual({ ...after, meetingMuted: base.meetingMuted }, base, '除 meetingMuted 外不得有任何变化')
  }
  const on = onState()
  assert.equal(meetingMute(on, null), on, '值未变化时返回同一引用（接线层据此判重）')
  const muted = meetingMute(on, true)
  assert.equal(meetingMute(muted, true), muted, '重复上报同一静音态不产生新状态')
  assert.equal(meetingMute(on, 'yes').meetingMuted, null, '非 true/false 一律视为未知')
})

test('AC-120/AC-133 uplinkSuspended 只在确实暂停时生效，resumed 回到 running', () => {
  const on = onState()
  assert.equal(uplinkSuspended(on), on, 'meetingMuted !== true 时 closed 不是挂起而是掉线')
  const muted = meetingMute(on, true)
  const suspended = uplinkSuspended(muted)
  assert.equal(suspended.directions.uplink.status, 'suspended')
  assert.equal(suspended.directions.downlink.status, 'running', '下行不受影响')
  assert.equal(suspended.phase, 'on')
  assert.equal(uplinkSuspended(suspended), suspended, '重复挂起返回同一引用')
  const resumed = uplinkResumed(suspended)
  assert.equal(resumed.directions.uplink.status, 'running')
  assert.equal(uplinkResumed(resumed), resumed)
})

test('AC-109 planApplied 只更新给到的方向与语言', () => {
  const on = onState()
  const next = planApplied(on, {
    directions: { downlink: { status: 'running', mode: 'translate' } },
    languages: { hear: 'ja', partnerHears: 'en' },
  })
  assert.equal(next.languages.hear, 'ja')
  assert.equal(next.directions.uplink, on.directions.uplink, '未提及的方向保持原引用')
  assert.equal(latency(on, { ms: 1234 }).latencyMs, 1234)
})

test('AC-121/AC-147 badgeFor：失败 > 过渡 > 静音 > 同传 > 未开启（未开启一律无角标）', () => {
  const initial = createInitialRuntime()
  const connecting = connectRequested(initial)
  const connected = bridgeConnected(connecting)
  const starting = requestStart(connected)
  const on = onState()
  const onMuted = meetingMute(on, true)
  const stopping = requestStop(on)
  const errored = failed(on, ERR)
  const bridgeDown = bridgeFailed(on, DEVICE_ERR)

  assert.deepEqual(badgeFor(initial), { text: '' })
  assert.deepEqual(badgeFor(connecting), { text: '…', color: BADGE_COLORS.idle })
  assert.deepEqual(badgeFor(connected), { text: '' }, '桥不会脱离同传单独存在，未开启一律无角标')
  assert.deepEqual(badgeFor(stopped(requestStop(on))), { text: '' })
  assert.deepEqual(badgeFor(starting), { text: '…', color: BADGE_COLORS.idle })
  assert.deepEqual(badgeFor(on), { text: '●', color: BADGE_COLORS.live })
  assert.deepEqual(badgeFor(onMuted), { text: '●', color: BADGE_COLORS.muted })
  assert.deepEqual(badgeFor(stopping), { text: '…', color: BADGE_COLORS.idle })
  assert.deepEqual(badgeFor(errored), { text: '!', color: BADGE_COLORS.danger })
  assert.deepEqual(badgeFor(bridgeDown), { text: '!', color: BADGE_COLORS.danger })
  assert.deepEqual(BADGE_COLORS, { danger: '#f07a68', idle: '#6b7380', muted: '#e6b45a', live: '#4fd6b8' })
})

test('AC-122/AC-139 planRecovery：四种条件逐项相等，且绝不要求占用设备', () => {
  const initial = createInitialRuntime()
  assert.deepEqual(planRecovery({ runtime: initial, hasNativePort: false, hasOffscreen: false }), { action: 'none' })

  const connected = bridgeConnected(connectRequested(initial))
  assert.deepEqual(planRecovery({ runtime: connected, hasNativePort: false, hasOffscreen: false }), {
    action: 'fail-bridge',
    error: { category: 'api_error', message: RECOVERY_BRIDGE_LOST },
  })
  assert.deepEqual(planRecovery({ runtime: connectRequested(initial), hasNativePort: false, hasOffscreen: false }), {
    action: 'fail-bridge',
    error: { category: 'api_error', message: RECOVERY_BRIDGE_LOST },
  })

  assert.deepEqual(planRecovery({ runtime: onState(), hasNativePort: false, hasOffscreen: true }), {
    action: 'reconnect-host',
  })
  assert.deepEqual(planRecovery({ runtime: onState(), hasNativePort: true, hasOffscreen: true }), { action: 'none' })

  for (const runtime of [requestStart(connected), requestStop(onState())]) {
    assert.deepEqual(planRecovery({ runtime, hasNativePort: true, hasOffscreen: true }), {
      action: 'fail-translation',
      error: { category: 'api_error', message: RECOVERY_HALF_DONE },
    })
  }
  assert.deepEqual(planRecovery({ runtime: bridgeFailed(connected, ERR), hasNativePort: false, hasOffscreen: true }), {
    action: 'none',
  })
  // SW 在开启刚开始、桥还没动时被终止：同样按失败收尾，不留卡死的「正在开启」
  for (const hasOffscreen of [true, false]) {
    assert.deepEqual(planRecovery({ runtime: requestStart(initial), hasNativePort: false, hasOffscreen }), {
      action: 'fail-translation',
      error: { category: 'api_error', message: RECOVERY_HALF_DONE },
    })
  }

  // 任何返回值都不得要求建桥或开启翻译（否则就是未经用户触发的占用）
  const actions = new Set()
  for (const runtime of [initial, connected, connectRequested(initial), onState(), requestStart(connected), requestStop(onState()), bridgeFailed(connected, ERR)]) {
    for (const hasNativePort of [true, false]) {
      for (const hasOffscreen of [true, false]) {
        actions.add(planRecovery({ runtime, hasNativePort, hasOffscreen }).action)
      }
    }
  }
  for (const forbidden of ['connect', 'start']) {
    assert.ok(!actions.has(forbidden), `planRecovery 绝不返回 ${forbidden}`)
  }
})

test('AC-125 stripSecrets 只留 port 与 backend', () => {
  assert.deepEqual(
    stripSecrets({ port: 51234, backend: 'mock', launchToken: 'secret', mockWsUrl: 'ws://x', baseUrl: 'http://x' }),
    { port: 51234, backend: 'mock' }
  )
  assert.equal(stripSecrets(null), null)
  assert.equal(stripSecrets(undefined), null)
  const stripped = JSON.stringify(stripSecrets({ port: 1, backend: 'real', launchToken: 'tok-abc' }))
  assert.ok(!stripped.includes('tok-abc'))
  assert.ok(!stripped.includes('launchToken'))
})

test('AC-143 readyCopy：两方向 translate / 已静音 / 原声方向', () => {
  const plan = buildDirections({ hear: 'zh', partnerHears: 'en' })
  assert.equal(
    readyCopy({ plan, meetingMuted: false }),
    '本地翻译服务已启动，双向连接成功。对方说的会翻成中文进你的耳机，你说的话会翻成 English 送进会议。'
  )
  assert.equal(readyCopy({ plan, meetingMuted: null }), readyCopy({ plan, meetingMuted: false }))
  assert.equal(
    readyCopy({ plan, meetingMuted: true }),
    '本地翻译服务已启动，双向连接成功。对方说的会翻成中文进你的耳机，你在会议里已静音，取消静音后你说的话会翻成 English 送进会议。'
  )
  const upOriginal = buildDirections({ hear: 'zh', partnerHears: 'original' })
  assert.ok(readyCopy({ plan: upOriginal, meetingMuted: false }).includes('你的原声会直接送进会议'))
  const downOriginal = buildDirections({ hear: 'original', partnerHears: 'en' })
  assert.ok(readyCopy({ plan: downOriginal, meetingMuted: false }).includes('对方的原声会直接进你的耳机'))
  // 目标语言换成日语时文案随之变化，排除硬编码
  const ja = buildDirections({ hear: 'ja', partnerHears: 'ko' })
  assert.ok(readyCopy({ plan: ja, meetingMuted: false }).includes('翻成日本語进你的耳机'))
  assert.ok(readyCopy({ plan: ja, meetingMuted: false }).includes('翻成한국어送进会议'))
})

test('AC-148 failureCopy：失败后插件已撤掉一切，正文只说明原因（标题区分桥失败与翻译失败）', () => {
  assert.equal(failureCopy({ kind: 'translation', error: ERR, bridge: 'connected' }), '出错了。')
  assert.equal(failureCopy({ kind: 'translation', error: ERR }), '出错了。')
  assert.equal(failureCopy({ kind: 'bridge', error: DEVICE_ERR }), '缺设备。')
  assert.equal(failureCopy({}), '')
})

test('AC-145 通知契约：三处通知的 id 与标题固定', () => {
  assert.equal(NOTIFY.ready.id, 'li-ready')
  assert.equal(NOTIFY.ready.title, '同传已就绪')
  assert.equal(NOTIFY.translationFailed.id, 'li-failed')
  assert.equal(NOTIFY.translationFailed.title, '无法开启同传')
  assert.equal(NOTIFY.bridgeFailed.id, 'li-failed')
  assert.equal(NOTIFY.bridgeFailed.title, '无法连接会议音频')
})

test('AC-127/AC-149 statusCopy：已关闭 / 桥失败；没有「断开」入口', () => {
  const plan = buildDirections({ hear: 'zh', partnerHears: 'en' })
  const off = statusCopy({ ...createInitialRuntime(), plan })
  assert.equal(off.title, '同传已关闭')
  assert.equal(
    off.body,
    '开启后，对方说的话会翻成你要听的语言进你的耳机，你说的话会翻译后送进会议。关闭时插件不占用麦克风，也不转送会议声音。'
  )
  assert.equal(off.primary, '开启同传')
  assert.equal(off.action, 'start')
  assert.equal(off.variant, 'solid')
  assert.equal(off.spinner, false)
  assert.equal(off.lockFields, false)
  assert.ok(!('secondary' in off), '面板不再有「断开会议音频」次入口')
  assert.equal(off.stepText, null)

  const bridgeDown = statusCopy({ ...bridgeFailed(bridgeConnected(connectRequested(createInitialRuntime())), DEVICE_ERR), plan })
  assert.equal(bridgeDown.title, '无法连接会议音频')
  assert.equal(bridgeDown.tone, 'danger')
  assert.equal(bridgeDown.body, '缺设备。')
  assert.equal(bridgeDown.primary, '开启同传')
  assert.equal(bridgeDown.action, 'start')
  assert.equal(bridgeDown.hint.label, '音频设置')

  const permission = statusCopy({
    ...bridgeFailed(bridgeConnected(connectRequested(createInitialRuntime())), {
      category: 'permission_denied',
      message: '没授权。',
    }),
    plan,
  })
  assert.equal(permission.hint.label, '去授权麦克风')

  // 桥不会脱离同传单独存在；即便出现也按已关闭渲染，绝不展示「原声直通」这种关闭后仍占麦的状态
  const orphan = statusCopy({ ...bridgeConnected(connectRequested(createInitialRuntime())), plan })
  assert.deepEqual(orphan, off)
})

test('AC-127/AC-142/AC-146 statusCopy：开启中三段步骤文案 + 可点的「取消开启」；关闭中不可点', () => {
  const plan = buildDirections({ hear: 'zh', partnerHears: 'en' })
  const steps = { bridge: '正在连接会议音频…', host: '正在启动本地翻译服务…', translation: '正在连接翻译服务…' }
  assert.deepEqual(STEP_TEXT, steps)
  for (const [startStep, stepText] of Object.entries(steps)) {
    const copy = statusCopy({ ...createInitialRuntime(), phase: 'starting', startStep, plan })
    assert.equal(copy.title, '正在开启同传')
    assert.equal(copy.primary, '取消开启')
    assert.equal(copy.action, 'cancel', '开启中主按钮必须可点，用来取消')
    assert.equal(copy.spinner, true)
    assert.equal(copy.variant, 'outline')
    assert.equal(copy.lockFields, true)
    assert.equal(copy.stepText, stepText)
    assert.equal(copy.tone, 'progress')
    assert.ok(copy.body.includes('可随时取消'))
  }

  const stopping = statusCopy({ ...requestStop(onState()), plan })
  assert.equal(stopping.primary, '正在关闭…')
  assert.equal(stopping.action, null, '关闭中按钮不可点')
  assert.equal(stopping.spinner, true)
  assert.equal(stopping.lockFields, true)
  assert.ok(stopping.body.includes('释放麦克风'))
})

test('AC-127 statusCopy：进行中 / 已静音 / 静音未知 / 恢复中 / 翻译失败', () => {
  const plan = buildDirections({ hear: 'zh', partnerHears: 'en' })
  const on = statusCopy({ ...meetingMute(onState(), false), plan })
  assert.equal(on.title, '同传进行中')
  assert.equal(on.body, '对方说的会翻成中文进你的耳机，你说的话会翻成 English 送进会议。翻译播放时原声会压低。')
  assert.equal(on.tone, 'live')
  assert.equal(on.primary, '关闭同传')
  assert.equal(on.action, 'stop')
  assert.equal(on.variant, 'outline')
  assert.equal(on.spinner, false)
  assert.ok(!('secondary' in on))
  assert.equal(on.note, null)

  const muted = statusCopy({ ...meetingMute(onState(), true), plan })
  assert.equal(muted.body, '会议已静音 · 暂停翻译你的话。对方说的仍会翻成中文进你的耳机。')
  assert.equal(muted.tone, 'warning')
  assert.equal(muted.title, '同传进行中')

  const unknown = statusCopy({ ...onState(), plan })
  assert.equal(unknown.note, '未感知到会议静音（仅支持 Google Meet）')

  const resuming = statusCopy({ ...meetingMute(uplinkSuspended(meetingMute(onState(), true)), false), plan })
  assert.equal(resuming.note, '正在恢复翻译…')

  const downOriginal = buildDirections({ hear: 'original', partnerHears: 'en' })
  assert.ok(statusCopy({ ...meetingMute(onState(), false), plan: downOriginal }).body.includes('对方的原声会直接进你的耳机'))
  const upOriginal = buildDirections({ hear: 'zh', partnerHears: 'original' })
  assert.ok(statusCopy({ ...meetingMute(onState(), false), plan: upOriginal }).body.includes('你的原声会直接送进会议'))

  const errored = statusCopy({ ...failed(onState(), ERR), plan })
  assert.equal(errored.title, '无法开启同传')
  assert.equal(errored.tone, 'danger')
  assert.equal(errored.body, '出错了。')
  assert.equal(errored.primary, '开启同传')
  assert.equal(errored.action, 'start')
})
