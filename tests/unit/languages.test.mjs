import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OUTPUT_LANGUAGES,
  ORIGINAL,
  ORIGINAL_LABEL,
  labelFor,
  isOutputLanguage,
  isTargetChoice,
  padLabel,
} from '../../src/shared/languages.mjs'

const UPSTREAM_CODES = ['en', 'es', 'pt', 'fr', 'de', 'it', 'ru', 'zh', 'ja', 'ko', 'hi', 'id', 'vi']

test('AC-135 语言目录：恰好上游 13 种输出语言，标签非空且两两不同', () => {
  const ids = OUTPUT_LANGUAGES.map((l) => l.id)
  assert.deepEqual([...ids].sort(), [...UPSTREAM_CODES].sort())
  assert.equal(new Set(ids).size, 13)
  const labels = OUTPUT_LANGUAGES.map((l) => l.label)
  for (const label of labels) assert.ok(typeof label === 'string' && label.length > 0)
  assert.equal(new Set(labels).size, 13)
})

test('AC-135 原声是第 14 个选项而不是第 14 种语言', () => {
  assert.equal(ORIGINAL, 'original')
  assert.ok(!OUTPUT_LANGUAGES.some((l) => l.id === ORIGINAL))
  assert.equal(isTargetChoice(ORIGINAL), true)
  assert.equal(isOutputLanguage(ORIGINAL), false)
  assert.equal(labelFor(ORIGINAL), ORIGINAL_LABEL)
  assert.equal(ORIGINAL_LABEL, '原声（不翻译）')
  for (const id of UPSTREAM_CODES) {
    assert.equal(isOutputLanguage(id), true, `${id} 应为输出语言`)
    assert.equal(isTargetChoice(id), true)
    assert.ok(labelFor(id).length > 0)
  }
  for (const bad of ['xx', '', undefined, null, 7, {}]) {
    assert.equal(isOutputLanguage(bad), false)
    assert.equal(isTargetChoice(bad), false)
    assert.equal(labelFor(bad), '')
  }
})

test('AC-143/AC-127 标签夹进中文句子：拉丁/西里尔两侧补空格，中日韩不补', () => {
  assert.equal(padLabel('English'), ' English ')
  assert.equal(padLabel('Español'), ' Español ')
  assert.equal(padLabel('Русский'), ' Русский ')
  assert.equal(padLabel('Bahasa Indonesia'), ' Bahasa Indonesia ')
  assert.equal(padLabel('中文'), '中文')
  assert.equal(padLabel('日本語'), '日本語')
  assert.equal(padLabel('한국어'), '한국어')
  assert.equal(padLabel('हिन्दी'), 'हिन्दी')
  assert.equal(padLabel(undefined), '')
})
