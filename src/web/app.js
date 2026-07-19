import { selectSessionEndpoint } from '/shared/session-endpoint.mjs'
import { preflight } from '/shared/device-preflight.mjs'
import { createInitialState, start, stop, toggleMute } from '/shared/session-state.mjs'
import { forwardMicAudio, resolveSinkId } from '/shared/audio-routing.mjs'
import { createSubtitles } from '/shared/subtitles.mjs'
import { createLatencyTracker } from '/shared/latency.mjs'
import { enumerateAudioDevices, startCapture, createPlayer } from '/audio.js'
import { openTranslationSession } from '/session.js'

// 薄接线：UI 事件 → shared 纯函数 → 渲染；不重复实现任何判定逻辑。

let state = createInitialState()
let config = null
const subtitles = createSubtitles()
const latency = createLatencyTracker()
const live = { downlink: null, uplink: null } // { session, capture, player }

const $ = (id) => document.getElementById(id)
const ROLE_IDS = ['capture', 'monitor', 'mic', 'virtualMic']

function showError(message) {
  $('error-area').textContent = message ?? ''
}

function render() {
  $('status-downlink').textContent = state.downlink.status === 'running' ? '运行中' : '已停止'
  $('status-uplink').textContent = state.uplink.status === 'running' ? '运行中' : '已停止'
  $('btn-downlink').textContent = state.downlink.status === 'running' ? '停止下行' : '启动下行'
  $('btn-downlink').classList.toggle('stop', state.downlink.status === 'running')
  $('btn-uplink').textContent = state.uplink.status === 'running' ? '停止上行' : '启动上行'
  $('btn-uplink').classList.toggle('stop', state.uplink.status === 'running')
  $('btn-mute').textContent = state.uplink.muted ? '已静音（点击开始翻译）' : '翻译中（点击静音）'
  $('btn-mute').classList.toggle('muted', state.uplink.muted)
  $('subtitle-current').textContent = subtitles.getCurrentLine()
  $('subtitle-history').textContent = subtitles.getHistory().slice(-8).join('\n')
  const ms = latency.getCurrentLatencyMs('downlink')
  $('latency').textContent = ms === null ? '—' : `${Math.round(ms)} ms`
}

function currentOverrides() {
  const overrides = {}
  for (const role of ROLE_IDS) {
    const v = $(`sel-${role}`).value
    if (v !== '') overrides[role] = v
  }
  return overrides
}

async function populateDevices() {
  const devices = await enumerateAudioDevices()
  for (const role of ROLE_IDS) {
    const sel = $(`sel-${role}`)
    sel.innerHTML = '<option value="">（默认分配）</option>'
    const wantKind = role === 'capture' || role === 'mic' ? 'audioinput' : 'audiooutput'
    for (const d of devices.filter((x) => x.kind === wantKind)) {
      const opt = document.createElement('option')
      opt.value = d.deviceId
      opt.textContent = d.label || d.deviceId
      sel.appendChild(opt)
    }
  }
  return devices
}

function onSessionEvent(kind, payload) {
  if (kind === 'error') showError(payload?.message)
  render()
}

async function startDirection(directionId) {
  const devices = await enumerateAudioDevices()
  const result = preflight(devices, currentOverrides())
  if (result.category !== 'ok') {
    showError(result.message)
    return
  }
  showError('')
  try {
    const endpoint = selectSessionEndpoint(config)
    const sinkId = resolveSinkId(directionId, result.roles)
    const player = await createPlayer(sinkId)
    const session = await openTranslationSession({
      endpoint,
      directionId,
      audioSink: (bytes) => player.enqueue(bytes),
      subtitles,
      latency,
      onEvent: onSessionEvent,
    })
    const inputDeviceId = directionId === 'downlink' ? result.roles.capture : result.roles.mic
    const capture = await startCapture(inputDeviceId, (chunk) => {
      if (directionId === 'uplink') {
        forwardMicAudio({ muted: state.uplink.muted, chunk, sink: (c) => session.sendAudio(c) })
      } else {
        session.sendAudio(chunk)
      }
    })
    live[directionId] = { session, capture, player }
    state = start(state, directionId)
  } catch (err) {
    showError(err?.message ?? '启动失败，请检查设备与网络。')
  }
  render()
}

function stopDirection(directionId) {
  const handles = live[directionId]
  if (handles) {
    handles.capture.stop()
    handles.session.close()
    handles.player.stop()
    live[directionId] = null
  }
  state = stop(state, directionId)
  showError('')
  render()
}

async function main() {
  config = await (await fetch('/api/config')).json()
  $('backend-label').textContent = config.backend
  await populateDevices()

  $('btn-downlink').addEventListener('click', () => {
    state.downlink.status === 'running' ? stopDirection('downlink') : startDirection('downlink')
  })
  $('btn-uplink').addEventListener('click', () => {
    state.uplink.status === 'running' ? stopDirection('uplink') : startDirection('uplink')
  })
  $('btn-mute').addEventListener('click', () => {
    state = toggleMute(state)
    render()
  })
  render()
}

main().catch((err) => showError(`初始化失败：${err?.message ?? err}`))
