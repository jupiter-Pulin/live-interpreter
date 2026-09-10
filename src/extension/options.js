import { enumerateAudioDevices } from './audio.js'
import { preflight } from '/shared/device-preflight.mjs'
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  DEVICE_ROLES,
  DEFAULT_ASSIGNMENT_LABEL,
} from '/shared/direction-plan.mjs'
import { FLOOR_LEVEL_LABELS, FLOOR_NOTE } from '/shared/floor.mjs'
import { classifyNativeError } from '/shared/native-errors.mjs'

// 选项页：设备角色、衬底档位、本地服务自检。纯接线——设备分配由 preflight 判定，
// 角色与端点类型来自 DEVICE_ROLES，档位文案来自 floor.mjs，宿主失败分类来自 native-errors。

const HOST_NAME = 'com.live_interpreter.host'
const PROBE_TIMEOUT_MS = 10000

const el = (id) => document.getElementById(id)
let settings = DEFAULT_SETTINGS
let devices = []

function setConclusion(node, tone, text) {
  node.dataset.tone = tone
  node.textContent = text
  node.hidden = false
}

function renderDevices() {
  const host = el('devices')
  host.textContent = ''
  for (const role of DEVICE_ROLES) {
    const card = document.createElement('div')
    card.className = 'card'

    const meta = document.createElement('div')
    meta.className = 'meta'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = role.title
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = role.hint
    meta.append(name, hint)

    const select = document.createElement('select')
    const auto = document.createElement('option')
    auto.value = ''
    auto.textContent = DEFAULT_ASSIGNMENT_LABEL
    select.append(auto)
    for (const device of devices.filter((d) => d.kind === role.kind)) {
      const option = document.createElement('option')
      option.value = device.deviceId
      option.textContent = device.label || device.deviceId
      select.append(option)
    }
    select.value = settings.deviceOverrides[role.role] ?? ''
    select.addEventListener('change', () => {
      const overrides = { ...settings.deviceOverrides }
      if (select.value === '') delete overrides[role.role]
      else overrides[role.role] = select.value
      void save({ deviceOverrides: overrides })
    })

    card.append(meta, select)
    host.append(card)
  }
  renderConclusion()
}

function renderConclusion() {
  const conclusion = preflight(devices, settings.deviceOverrides)
  if (conclusion.category === 'ok') {
    const summary = DEVICE_ROLES.map((role) => `${role.title}：${conclusion.labels[role.role]}`).join('\n')
    setConclusion(el('conclusion'), 'ok', `设备已就绪。\n${summary}`)
    el('conclusion').style.whiteSpace = 'pre-line'
    return
  }
  setConclusion(el('conclusion'), 'bad', conclusion.message)
}

function renderFloor() {
  const host = el('floor')
  host.textContent = ''
  for (const entry of FLOOR_LEVEL_LABELS) {
    const label = document.createElement('label')
    label.className = 'choice'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'floorLevel'
    input.checked = settings.floorLevel === entry.level
    input.addEventListener('change', () => void save({ floorLevel: entry.level }))
    const text = document.createElement('span')
    text.textContent = entry.label
    label.append(input, text)
    host.append(label)
  }
  el('floor-note').textContent = FLOOR_NOTE
}

async function save(patch) {
  settings = normalizeSettings({ ...settings, ...patch })
  await chrome.runtime.sendMessage({ type: 'li:set-settings', to: 'sw', ...patch })
  renderConclusion()
}

// 自检：拉起宿主拿到 ready 就立刻断开，绝不留着进程
function probeHost() {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let port
    try {
      port = chrome.runtime.connectNative(HOST_NAME)
    } catch (err) {
      finish({ ok: false, error: classifyNativeError(err?.message) })
      return
    }
    const timer = setTimeout(() => {
      try {
        port.disconnect()
      } catch {
        // 端口可能已断
      }
      finish({ ok: false, error: classifyNativeError('') })
    }, PROBE_TIMEOUT_MS)
    port.onMessage.addListener((frame) => {
      if (frame?.type !== 'ready') return
      clearTimeout(timer)
      port.disconnect()
      finish({ ok: true, frame })
    })
    port.onDisconnect.addListener(() => {
      clearTimeout(timer)
      finish({ ok: false, error: classifyNativeError(chrome.runtime.lastError?.message) })
    })
  })
}

el('probe').addEventListener('click', async () => {
  const node = el('probe-result')
  setConclusion(node, 'idle', '正在检测…')
  const result = await probeHost()
  if (result.ok) {
    setConclusion(
      node,
      'ok',
      `本地服务可用：后端 ${result.frame.backend}，端口 ${result.frame.port}，版本 ${result.frame.version}。检测完成后已立即退出。`
    )
    return
  }
  setConclusion(node, 'bad', result.error.message)
})

async function load() {
  const stored = await chrome.storage.local.get('settings')
  settings = normalizeSettings(stored.settings ?? DEFAULT_SETTINGS)
  renderFloor()
  // 打开页面即枚举设备：这会触发浏览器的麦克风授权提示，之后离屏文档就不再弹窗
  devices = await enumerateAudioDevices()
  renderDevices()
}

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.settings) return
  settings = normalizeSettings(changes.settings.newValue ?? DEFAULT_SETTINGS)
  renderConclusion()
})

load()
