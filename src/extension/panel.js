import {
  statusCopy,
  HEADER_TITLE,
  HEADER_SUBTITLE,
  FOOTNOTE,
  FIELD_LABELS,
  PRIMARY_STOP,
  createInitialRuntime,
} from '/shared/runtime-state.mjs'
import { TARGET_CHOICES } from '/shared/languages.mjs'
import { DEFAULT_SETTINGS, normalizeSettings, buildDirections } from '/shared/direction-plan.mjs'

// 弹窗与侧栏共用的面板。纯接线：只把 storage 里的两份数据交给 statusCopy，
// 再把返回值填进 DOM。本文件不含任何状态判定与界面文案字面量。

const el = (id) => document.getElementById(id)

const view = {
  status: el('status'),
  title: el('status-title'),
  body: el('status-body'),
  note: el('status-note'),
  hint: el('status-hint'),
  power: el('power'),
  powerLabel: el('power-label'),
  step: el('step'),
  disconnect: el('disconnect'),
  hear: el('hear'),
  partnerHears: el('partnerHears'),
}

let settings = DEFAULT_SETTINGS
let runtime = createInitialRuntime()
let copy = statusCopy({ ...runtime, plan: buildDirections(DEFAULT_SETTINGS) })

function fillOptions(select) {
  for (const choice of TARGET_CHOICES) {
    // 「原声」不是第 14 种语言，而是「这个方向不翻译」，用分隔线与语言区隔开
    if (choice.separated) {
      const separator = document.createElement('option')
      separator.disabled = true
      separator.textContent = '─'
      select.append(separator)
    }
    const option = document.createElement('option')
    option.value = choice.id
    option.textContent = choice.label
    select.append(option)
  }
}

function render() {
  copy = statusCopy({ ...runtime, plan: buildDirections(runtime.languages ?? settings) })
  // tone = progress 即「正在开启/关闭」：按钮禁用并转圈，下拉锁住
  const busy = copy.tone === 'progress'

  view.status.dataset.tone = copy.tone
  view.title.textContent = copy.title
  view.body.textContent = copy.body
  view.note.textContent = copy.note ?? ''
  view.note.hidden = copy.note === null
  view.hint.textContent = copy.hint?.label ?? ''
  view.hint.hidden = copy.hint === null

  view.powerLabel.textContent = copy.primary
  view.power.disabled = busy
  view.power.dataset.busy = String(busy)
  view.power.dataset.variant = copy.primary === PRIMARY_STOP ? 'outline' : 'solid'
  view.step.textContent = copy.stepText ?? ''

  view.disconnect.textContent = copy.secondary ?? ''
  view.disconnect.hidden = copy.secondary === null

  view.hear.value = settings.hear
  view.partnerHears.value = settings.partnerHears
  view.hear.disabled = busy
  view.partnerHears.disabled = busy
}

async function load() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get('settings'),
    chrome.storage.session.get('runtime'),
  ])
  settings = normalizeSettings(local.settings ?? DEFAULT_SETTINGS)
  runtime = { ...createInitialRuntime(), ...(session.runtime ?? {}) }
  render()
}

function send(message) {
  return chrome.runtime.sendMessage({ ...message, to: 'sw' }).catch(() => undefined)
}

view.power.addEventListener('click', () => {
  // 开还是关由 statusCopy 给出的主按钮决定，这里只搬运
  send({ type: 'li:power', on: copy.primary !== PRIMARY_STOP })
})

view.disconnect.addEventListener('click', () => send({ type: 'li:disconnect' }))

view.hint.addEventListener('click', () => chrome.runtime.openOptionsPage())
el('settings').addEventListener('click', () => chrome.runtime.openOptionsPage())

el('dock').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  await chrome.sidePanel.open({ tabId: tab.id })
  window.close()
})

for (const key of ['hear', 'partnerHears']) {
  view[key].addEventListener('change', () => {
    settings = { ...settings, [key]: view[key].value }
    send({ type: 'li:set-settings', [key]: view[key].value })
  })
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) settings = normalizeSettings(changes.settings.newValue ?? DEFAULT_SETTINGS)
  if (changes.runtime) runtime = { ...createInitialRuntime(), ...(changes.runtime.newValue ?? {}) }
  render()
})

el('brand').textContent = HEADER_TITLE
el('brand-sub').textContent = HEADER_SUBTITLE
el('footnote').textContent = FOOTNOTE
el('hear-label').textContent = FIELD_LABELS.hear
el('partner-label').textContent = FIELD_LABELS.partnerHears
fillOptions(view.hear)
fillOptions(view.partnerHears)
load()
