import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyNativeError, HOST_LOG_HINT } from '../../src/shared/native-errors.mjs'
import { CATEGORIES, USER_MESSAGES } from '../../src/shared/errors.mjs'

test('AC-105 host_unavailable 是一类独立错误，文案给出可执行的下一步', () => {
  assert.ok(CATEGORIES.includes('host_unavailable'))
  assert.ok(USER_MESSAGES.host_unavailable.includes('npm run install:host'))
})

test('AC-105 宿主 manifest 未安装 / ID 不符：提示重跑安装命令', () => {
  for (const raw of [
    'Specified native messaging host not found.',
    'Access to the specified native messaging host is forbidden.',
  ]) {
    const r = classifyNativeError(raw)
    assert.equal(r.category, 'host_unavailable')
    assert.equal(r.message, USER_MESSAGES.host_unavailable)
  }
})

test('AC-105 宿主启动即退出：额外提示去看启动日志', () => {
  for (const raw of ['Native host has exited.', 'Error when communicating with the native messaging host.']) {
    const r = classifyNativeError(raw)
    assert.equal(r.category, 'host_unavailable')
    assert.ok(r.message.endsWith(HOST_LOG_HINT), `应附日志提示：${r.message}`)
    assert.ok(r.message.includes('npm run install:host'))
  }
})

test('AC-105 未知/缺失的 lastError 一律兜底，不抛出', () => {
  for (const raw of [undefined, null, '', 7, {}, '莫名其妙的错误']) {
    assert.doesNotThrow(() => classifyNativeError(raw))
    assert.equal(classifyNativeError(raw).category, 'host_unavailable')
    assert.ok(classifyNativeError(raw).message.length > 0)
  }
})
