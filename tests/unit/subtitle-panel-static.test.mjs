import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/web')

async function readPanels() {
  const html = await readFile(path.join(WEB_DIR, 'index.html'), 'utf8')
  const panels = html.split('<div class="panel">').slice(1)
  const find = (marker) => {
    const panel = panels.find((p) => p.includes(marker))
    assert.ok(panel, `未找到含「${marker}」的面板`)
    return panel
  }
  return { html, downlink: find('下行 ·'), uplink: find('上行 ·') }
}

test('AC-001/AC-002 上下行字幕元素各归各的面板', async () => {
  const { downlink, uplink } = await readPanels()
  for (const id of ['subtitle-current-downlink', 'subtitle-history-downlink']) {
    assert.ok(downlink.includes(`id="${id}"`), `下行面板缺少 ${id}`)
    assert.ok(!uplink.includes(id), `上行面板不得出现 ${id}`)
  }
  for (const id of ['subtitle-current-uplink', 'subtitle-history-uplink']) {
    assert.ok(uplink.includes(`id="${id}"`), `上行面板缺少 ${id}`)
    assert.ok(!downlink.includes(id), `下行面板不得出现 ${id}`)
  }
})

test('AC-005 上行面板新增字幕文案为中文', async () => {
  const { uplink } = await readPanels()
  const label = uplink.match(/<div class="subtitle-label">([^<]+)<\/div>/)
  assert.ok(label, '上行面板缺少字幕区文案')
  assert.match(label[1], /[一-龥]/, '新增文案必须是中文')
  assert.ok(!/[A-Za-z]{2,}/.test(label[1]), `新增文案不得含英文词：${label[1]}`)
})

test('AC-003 src/web 只接线：字幕按方向取自 shared，不在 web 层做判定', async () => {
  const app = await readFile(path.join(WEB_DIR, 'app.js'), 'utf8')
  assert.match(app, /createDirectionSubtitles\b/, 'app.js 应使用 shared 的按方向字幕状态')
  assert.ok(
    !/createSubtitles\s*\(/.test(app),
    'app.js 不得自行实例化裸 createSubtitles（方向隔离由 shared 负责）'
  )
  assert.match(
    app,
    /subtitles:\s*subtitles\.for\(directionId\)/,
    '每个方向的会话必须只拿到该方向的字幕缓冲'
  )
  assert.match(
    app,
    /subtitle-current-\$\{directionId\}[\s\S]{0,200}subtitle-history-\$\{directionId\}/,
    '渲染必须按 directionId 定位各自的字幕元素'
  )
  assert.ok(!/slice\(-\s*\d/.test(app), '历史条数上限属于判定逻辑，不得写在 src/web')
})
