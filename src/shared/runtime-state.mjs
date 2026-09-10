import { labelFor, padLabel } from './languages.mjs'

// 运行态：两层状态机 + 全部界面/通知文案，纯转换。
//
// 桥（bridge）= 同传开启期间的音频直通；翻译层（phase）= 叠在桥上的翻译会话。
// 桥只在「开启中 / 进行中 / 关闭中」存在：关闭、取消、任何失败的终态都不留桥，
// 插件在这些状态下不占用麦克风与任何音频设备（2026-09-10 实机反馈）。
// 合法转换返回新对象且不修改入参；非法转换返回同一引用（接线层据此判重、少写一次 storage）。

export const BRIDGE_DISCONNECTED = 'disconnected'
export const BRIDGE_CONNECTING = 'connecting'
export const BRIDGE_CONNECTED = 'connected'
export const BRIDGE_FAILED = 'failed'

const DIRECTION_IDS = ['downlink', 'uplink']

function stoppedDirections() {
  const out = {}
  for (const id of DIRECTION_IDS) out[id] = { status: 'stopped', mode: null }
  return out
}

export function createInitialRuntime() {
  return {
    bridge: BRIDGE_DISCONNECTED,
    bridgeError: null,
    phase: 'off',
    startStep: null,
    error: null,
    meetingMuted: null,
    directions: stoppedDirections(),
    server: null,
    languages: null,
    latencyMs: null,
    since: null,
  }
}

// ---------------------------------------------------------------- 桥

export function connectRequested(state) {
  if (state.bridge !== BRIDGE_DISCONNECTED && state.bridge !== BRIDGE_FAILED) return state
  return {
    ...state,
    bridge: BRIDGE_CONNECTING,
    bridgeError: null,
    startStep: state.phase === 'starting' ? 'bridge' : state.startStep,
  }
}

export function bridgeConnected(state) {
  if (state.bridge !== BRIDGE_CONNECTING) return state
  return {
    ...state,
    bridge: BRIDGE_CONNECTED,
    bridgeError: null,
    startStep: state.phase === 'starting' ? 'host' : state.startStep,
  }
}

export function bridgeFailed(state, error) {
  if (state.bridge !== BRIDGE_CONNECTING && state.bridge !== BRIDGE_CONNECTED) return state
  const next = { ...state, bridge: BRIDGE_FAILED, bridgeError: error }
  if (state.phase !== 'off') {
    next.phase = 'error'
    next.error = error
    next.startStep = null
    next.directions = stoppedDirections()
    next.server = null
    next.languages = null
  }
  return next
}

// 回到初始：只保留会议静音态（它由会议页面决定，与桥无关）
export function disconnected(state) {
  return { ...createInitialRuntime(), meetingMuted: state.meetingMuted }
}

// ---------------------------------------------------------------- 翻译层

export function requestStart(state) {
  if (state.phase !== 'off' && state.phase !== 'error') return state
  return {
    ...state,
    phase: 'starting',
    error: null,
    startStep: state.bridge === BRIDGE_CONNECTED ? 'host' : 'bridge',
  }
}

export function hostReady(state) {
  if (state.phase !== 'starting') return state
  return { ...state, startStep: 'translation' }
}

export function started(state, { directions, server, languages, at } = {}) {
  if (state.phase !== 'starting') return state
  return {
    ...state,
    phase: 'on',
    startStep: null,
    error: null,
    directions: { ...stoppedDirections(), ...directions },
    server: server ?? null,
    languages: languages ?? null,
    since: at ?? Date.now(),
  }
}

export function latency(state, { ms } = {}) {
  if (state.phase !== 'on') return state
  if (state.latencyMs === ms) return state
  return { ...state, latencyMs: ms }
}

// 上行被对端关闭：只有确实处于暂停（会议已静音）时才记为 suspended，
// 否则这是一次真实掉线，应走 failed 而不是静默挂起。
export function uplinkSuspended(state) {
  if (state.phase !== 'on' || state.meetingMuted !== true) return state
  if (state.directions.uplink.status === 'suspended') return state
  return {
    ...state,
    directions: { ...state.directions, uplink: { ...state.directions.uplink, status: 'suspended' } },
  }
}

export function uplinkResumed(state) {
  if (state.phase !== 'on') return state
  if (state.directions.uplink.status === 'running') return state
  return {
    ...state,
    directions: { ...state.directions, uplink: { ...state.directions.uplink, status: 'running' } },
  }
}

export function planApplied(state, { directions, languages } = {}) {
  if (state.phase !== 'on') return state
  return {
    ...state,
    directions: { ...state.directions, ...directions },
    languages: languages ?? state.languages,
  }
}

export function requestStop(state) {
  if (state.phase !== 'on' && state.phase !== 'starting' && state.phase !== 'error') return state
  return { ...state, phase: 'stopping', startStep: null }
}

// 关闭 / 取消完成：桥随翻译层一起撤掉，回到初始
export function stopped(state) {
  if (state.phase !== 'stopping') return state
  return disconnected(state)
}

// 翻译层失败：接线层已把宿主、会话、桥与离屏文档一并撤掉，这里只留下错误供面板与通知展示
export function failed(state, error) {
  return {
    ...disconnected(state),
    phase: 'error',
    error,
  }
}

// 会议静音态：任何 phase 都只改这一个字段
export function meetingMute(state, muted) {
  const value = muted === true || muted === false ? muted : null
  if (state.meetingMuted === value) return state
  return { ...state, meetingMuted: value }
}

// ---------------------------------------------------------------- 角标

export const BADGE_COLORS = {
  danger: '#f07a68',
  idle: '#6b7380',
  muted: '#e6b45a',
  live: '#4fd6b8',
}

export function badgeFor(state) {
  if (state.bridge === BRIDGE_FAILED || state.phase === 'error') return { text: '!', color: BADGE_COLORS.danger }
  if (state.bridge === BRIDGE_CONNECTING || state.phase === 'starting' || state.phase === 'stopping') {
    return { text: '…', color: BADGE_COLORS.idle }
  }
  if (state.phase === 'on' && state.meetingMuted === true) return { text: '●', color: BADGE_COLORS.muted }
  if (state.phase === 'on') return { text: '●', color: BADGE_COLORS.live }
  return { text: '' }
}

// ---------------------------------------------------------------- 恢复

export const RECOVERY_BRIDGE_LOST = '会议音频桥意外中断，请重新开启。'
export const RECOVERY_HALF_DONE = '上次操作未完成，已重置为关闭。'

// SW 顶层唤醒时调用：绝不返回任何需要占用设备的动作（connect / start 永不出现）。
// 开启/关闭做到一半时 SW 被终止，不论桥走到哪一步都按失败收尾（撤掉一切），不留半启动状态。
export function planRecovery({ runtime, hasNativePort, hasOffscreen }) {
  const bridge = runtime.bridge
  if ((bridge === BRIDGE_CONNECTED || bridge === BRIDGE_CONNECTING) && !hasOffscreen) {
    return { action: 'fail-bridge', error: { category: 'api_error', message: RECOVERY_BRIDGE_LOST } }
  }
  if (bridge === BRIDGE_CONNECTED && runtime.phase === 'on' && !hasNativePort) {
    return { action: 'reconnect-host' }
  }
  if (runtime.phase === 'starting' || runtime.phase === 'stopping') {
    return { action: 'fail-translation', error: { category: 'api_error', message: RECOVERY_HALF_DONE } }
  }
  return { action: 'none' }
}

// ---------------------------------------------------------------- 文案

export const HEADER_TITLE = '会议同传'
export const HEADER_SUBTITLE = 'Live Interpreter'
export const FOOTNOTE = '开启时会在本机启动翻译服务，对话会多一到两秒延迟。'

export const FIELD_LABELS = { hear: '你想听的语言', partnerHears: '对方听的语言' }

export const TITLE_OFF = '同传已关闭'
export const TITLE_ON = '同传进行中'
export const TITLE_STARTING = '正在开启同传'
export const TITLE_STOPPING = '正在关闭同传'
export const TITLE_TRANSLATION_FAILED = '无法开启同传'
export const TITLE_BRIDGE_FAILED = '无法连接会议音频'
export const TITLE_READY = '同传已就绪'

export const PRIMARY_START = '开启同传'
export const PRIMARY_STOP = '关闭同传'
export const PRIMARY_CANCEL = '取消开启'
export const PRIMARY_STOPPING = '正在关闭…'

export const BODY_OFF =
  '开启后，对方说的话会翻成你要听的语言进你的耳机，你说的话会翻译后送进会议。关闭时插件不占用麦克风，也不转送会议声音。'
export const BODY_STARTING = '正在连接会议音频与翻译服务，就绪后会有系统通知；可随时取消。'
export const BODY_STOPPING = '正在结束翻译与本地服务，并释放麦克风。'

export const SUFFIX_DUCKING = '翻译播放时原声会压低。'

export const NOTE_NO_MUTE_SENSE = '未感知到会议静音（仅支持 Google Meet）'
export const NOTE_RESUMING = '正在恢复翻译…'

export const STEP_TEXT = {
  bridge: '正在连接会议音频…',
  host: '正在启动本地翻译服务…',
  translation: '正在连接翻译服务…',
}

export const HINTS = {
  device_missing: '音频设置',
  permission_denied: '去授权麦克风',
}

export const NOTIFY = {
  ready: { id: 'li-ready', title: TITLE_READY },
  translationFailed: { id: 'li-failed', title: TITLE_TRANSLATION_FAILED },
  bridgeFailed: { id: 'li-failed', title: TITLE_BRIDGE_FAILED },
}

const MUTED_PREFIX = '会议已静音 · 暂停翻译你的话。'

function isTranslate(direction) {
  return direction?.mode === 'translate'
}

// 「对方说的会翻成{听}进你的耳机，」/「对方的原声会直接进你的耳机，」
function downlinkSentence(plan, { still = false } = {}) {
  if (!isTranslate(plan?.downlink)) return '对方的原声会直接进你的耳机，'
  const verb = still ? '对方说的仍会翻成' : '对方说的会翻成'
  return `${verb}${padLabel(labelFor(plan.downlink.target))}进你的耳机，`
}

// 「你说的话会翻成{对方听}送进会议。」/「你的原声会直接送进会议。」
function uplinkSentence(plan, { muted = false } = {}) {
  if (!isTranslate(plan?.uplink)) return '你的原声会直接送进会议。'
  const target = padLabel(labelFor(plan.uplink.target))
  if (muted) return `你在会议里已静音，取消静音后你说的话会翻成${target}送进会议。`
  return `你说的话会翻成${target}送进会议。`
}

// 就绪通知正文：按实际计划与会议静音态生成
export function readyCopy({ plan, meetingMuted } = {}) {
  const head = '本地翻译服务已启动，双向连接成功。'
  return `${head}${downlinkSentence(plan)}${uplinkSentence(plan, { muted: meetingMuted === true })}`
}

// 失败通知/面板正文：失败后插件已撤掉一切，正文只说明原因（桥失败与翻译失败靠标题区分）
export function failureCopy({ error } = {}) {
  return typeof error?.message === 'string' && error.message.length > 0 ? error.message : ''
}

function runningBody(plan, meetingMuted) {
  if (meetingMuted === true) {
    return `${MUTED_PREFIX}${downlinkSentence(plan, { still: true }).replace(/，$/, '。')}`
  }
  return `${downlinkSentence(plan)}${uplinkSentence(plan)}${SUFFIX_DUCKING}`
}

function hintFor(error) {
  const label = HINTS[error?.category]
  return label ? { label, category: error.category } : null
}

// 主按钮的四种形态：接线层只按 action 发消息、按 disabled/spinner/variant 设样式，不做判定。
// action：start = 开启；stop = 关闭；cancel = 开启途中取消（同样发 li:power {on:false}）；null = 不可点
const BUTTON_START = { primary: PRIMARY_START, action: 'start', variant: 'solid', spinner: false, lockFields: false }
const BUTTON_STOP = { primary: PRIMARY_STOP, action: 'stop', variant: 'outline', spinner: false, lockFields: false }
const BUTTON_CANCEL = { primary: PRIMARY_CANCEL, action: 'cancel', variant: 'outline', spinner: true, lockFields: true }
const BUTTON_STOPPING = { primary: PRIMARY_STOPPING, action: null, variant: 'outline', spinner: true, lockFields: true }

// 面板渲染的唯一真值：接线层不再做任何状态判定，只把返回值填进 DOM。
export function statusCopy({ bridge, bridgeError, phase, startStep, error, plan, meetingMuted, directions } = {}) {
  const quiet = { stepText: null, note: null, hint: null }

  if (phase === 'starting') {
    return {
      ...BUTTON_CANCEL,
      ...quiet,
      title: TITLE_STARTING,
      body: BODY_STARTING,
      tone: 'progress',
      stepText: STEP_TEXT[startStep] ?? null,
    }
  }

  if (phase === 'stopping') {
    return { ...BUTTON_STOPPING, ...quiet, title: TITLE_STOPPING, body: BODY_STOPPING, tone: 'progress' }
  }

  if (bridge === BRIDGE_FAILED) {
    return {
      ...BUTTON_START,
      ...quiet,
      title: TITLE_BRIDGE_FAILED,
      body: failureCopy({ error: bridgeError }),
      tone: 'danger',
      hint: hintFor(bridgeError),
    }
  }

  if (phase === 'error') {
    return {
      ...BUTTON_START,
      ...quiet,
      title: TITLE_TRANSLATION_FAILED,
      body: failureCopy({ error }),
      tone: 'danger',
      hint: hintFor(error),
    }
  }

  if (phase === 'on') {
    const resuming = meetingMuted !== true && directions?.uplink?.status === 'suspended'
    let note = null
    if (resuming) note = NOTE_RESUMING
    else if (meetingMuted === null) note = NOTE_NO_MUTE_SENSE
    return {
      ...BUTTON_STOP,
      ...quiet,
      title: TITLE_ON,
      body: runningBody(plan, meetingMuted),
      tone: meetingMuted === true ? 'warning' : 'live',
      note,
    }
  }

  return { ...BUTTON_START, ...quiet, title: TITLE_OFF, body: BODY_OFF, tone: 'idle' }
}

// 写进 storage.session 的 server 只留这两项：launchToken / mockWsUrl / baseUrl 绝不落盘
export function stripSecrets(server) {
  if (!server) return null
  return { port: server.port, backend: server.backend }
}
