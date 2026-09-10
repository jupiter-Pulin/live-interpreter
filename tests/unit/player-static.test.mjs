import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const AUDIO_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/extension/audio.js')

async function readPlayerSource() {
  const src = await readFile(AUDIO_JS, 'utf8')
  const start = src.indexOf('export async function createPlayer')
  assert.ok(start >= 0, 'createPlayer 未找到')
  const end = src.indexOf('\nasync function listAudioDevices', start)
  const stop = end >= 0 ? end : src.indexOf('\nexport async function enumerateAudioDevices', start)
  assert.ok(stop > start, '无法定位 createPlayer 函数边界')
  return src.slice(start, stop)
}

test('AC-004 createPlayer：resume 防线 + enqueue try/catch 上报 + 一次性诊断日志', async () => {
  const fn = await readPlayerSource()
  assert.ok(
    /ctx\.state\s*!==\s*['"]running['"][\s\S]{0,40}await ctx\.resume\(\)/.test(fn),
    '必须在 state 非 running 时 await ctx.resume()'
  )
  assert.ok(/console\.log\([\s\S]*sinkId[\s\S]*ctx\.state[\s\S]*ctx\.sampleRate/.test(fn.replace(/\n/g, ' ')), '缺少一次性诊断摘要（sinkId/state/sampleRate）')
  const enqueueStart = fn.indexOf('enqueue(bytes)')
  assert.ok(enqueueStart >= 0, 'enqueue 未找到')
  const enqueueBody = fn.slice(enqueueStart)
  assert.ok(/try\s*\{/.test(enqueueBody), 'enqueue 必须 try/catch 包裹')
  assert.ok(/catch\s*\(err\)\s*\{\s*onPlaybackError\?\.\(err\)/.test(enqueueBody), 'enqueue 异常必须经 onPlaybackError 上报而非静默/外抛')
})

test('AC-005 player AudioContext 不再强制 sampleRate:24000，createBuffer 仍声明 24000', async () => {
  const fn = await readPlayerSource()
  assert.ok(!/new AudioContext\(\s*\{\s*sampleRate/.test(fn), 'player 的 AudioContext 不得强制构造 sampleRate')
  assert.ok(/createBuffer\(1,\s*frames,\s*(SAMPLE_RATE|24000)\)/.test(fn), 'createBuffer 仍需以 24000 声明帧数据采样率')
})

test('AC-031 createPlayer 挂起看门狗：statechange 时自动 resume，stop 后不再抢救', async () => {
  // 实机踩坑：Chrome 将后台标签页中输出到虚拟声卡的上下文判为不可闻而挂起，
  // 字幕正常滚动但译文音频进不了 BlackHole（录音中段大段无声）。
  const fn = await readPlayerSource()
  assert.ok(/addEventListener\(\s*['"]statechange['"]/.test(fn), '必须监听 AudioContext statechange')
  const compact = fn.replace(/\s+/g, ' ')
  assert.ok(
    /statechange[\s\S]*state === 'suspended'[\s\S]*ctx\.resume\(\)/.test(fn),
    '挂起时必须自动 resume'
  )
  assert.ok(/closedByUs/.test(fn) && /stop\(\) \{ closedByUs = true/.test(compact), '主动 stop 后看门狗必须失效，不得复活已关闭的上下文')
  const enqueueStart = fn.indexOf('enqueue(bytes)')
  const enqueueBody = fn.slice(enqueueStart, fn.indexOf('stop()', enqueueStart))
  assert.ok(/suspended/.test(enqueueBody) && /resume/.test(enqueueBody), 'enqueue 遇挂起状态也要触发 resume 兜底')
})

test('AC-133 createPlayer 返回对象恰含 enqueue / flush / attachFloor / setFloorLevel / holdFloorFull / stop', async () => {
  const fn = await readPlayerSource()
  const returnStart = fn.indexOf('return {')
  assert.ok(returnStart >= 0, 'createPlayer 必须返回对象字面量')
  const returned = fn.slice(returnStart)
  const keys = [...returned.matchAll(/^\s{4}([A-Za-z]\w*)\(/gm)].map((m) => m[1])
  assert.deepEqual(keys.sort(), ['attachFloor', 'enqueue', 'flush', 'holdFloorFull', 'setFloorLevel', 'stop'])
})

test('AC-133 flush：维护 source 集合、逐个 stop、清空、playhead 归零并立即更新衬底', async () => {
  const fn = await readPlayerSource()
  assert.ok(/new Set\(\)/.test(fn), '必须维护已调度的 BufferSource 集合')
  const enqueueBody = fn.slice(fn.indexOf('enqueue(bytes)'), fn.indexOf('flush()'))
  assert.ok(/\.add\(src\)/.test(enqueueBody), 'enqueue 必须把 BufferSource 记入集合')
  const flushBody = fn.slice(fn.indexOf('flush()'), fn.indexOf('attachFloor(stream)'))
  assert.ok(/for \(const \w+ of \w+\)[\s\S]{0,80}\.stop\(\)/.test(flushBody), 'flush 必须逐个停止已调度的源')
  assert.ok(/\.clear\(\)/.test(flushBody), 'flush 必须清空集合')
  assert.ok(/playhead = 0/.test(flushBody), 'flush 必须把 playhead 归零')
  assert.ok(/scheduleFloor\(\)/.test(flushBody), 'flush 后必须立即按 floorTarget 更新直通增益')
})

test('AC-133 stop 同时停止直通 track；attachFloor 把直通接到衬底增益', async () => {
  const fn = await readPlayerSource()
  const stopBody = fn.slice(fn.lastIndexOf('stop() {'))
  assert.ok(/for \(const track of \w+\) track\.stop\(\)/.test(stopBody), 'stop 必须停止直通 track（否则麦克风不释放）')
  assert.ok(/ctx\.close\(\)/.test(stopBody))
  const attachBody = fn.slice(fn.indexOf('attachFloor(stream)'), fn.indexOf('setFloorLevel('))
  assert.ok(
    /createMediaStreamSource\(stream\)[\s\S]{0,120}connect\(floorGain\)/.test(attachBody),
    'attachFloor 必须 MediaStreamSource → floorGain'
  )
  assert.ok(/floorGain\.connect\(ctx\.destination\)/.test(fn), 'floorGain 必须接到已 setSinkId 的 destination')
})

test('AC-137 衬底增益：ramp 平滑且目标值只来自 shared 的 floorTarget/isTranslating', async () => {
  const src = await readFile(AUDIO_JS, 'utf8')
  assert.ok(
    /import\s*\{[^}]*floorTarget[^}]*\}\s*from\s*['"]\/shared\/floor\.mjs['"]/s.test(src),
    'floorTarget 必须从 /shared/floor.mjs 导入'
  )
  assert.ok(/import\s*\{[^}]*isTranslating[^}]*\}\s*from\s*['"]\/shared\/floor\.mjs['"]/s.test(src))
  const fn = await readPlayerSource()
  assert.ok(
    /linearRampToValueAtTime|setTargetAtTime/.test(fn),
    '增益必须用 ramp 改变，直接赋值会爆音'
  )
  assert.ok(/floorTarget\(\{/.test(fn), '目标增益必须调用 floorTarget 得出')
  assert.ok(/isTranslating\(\{/.test(fn), '是否在播译文必须调用 isTranslating 判定')
  // 判定不得在接线层重写
  assert.ok(!/playhead \+ 0\.7/.test(fn), '0.7s 释放窗口的判定不得在 audio.js 内重算')
  assert.ok(/setFloorLevel\(next\)\s*\{[\s\S]{0,80}scheduleFloor\(\)/.test(fn), 'setFloorLevel 必须即时生效')
  assert.ok(/holdFloorFull\(on\)\s*\{[\s\S]{0,80}scheduleFloor\(\)/.test(fn), 'holdFloorFull 必须即时生效')
})
