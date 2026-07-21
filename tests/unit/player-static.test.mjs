import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const AUDIO_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/web/audio.js')

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
