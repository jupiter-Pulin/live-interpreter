import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 零依赖图标生成：手写最小 PNG 编码器（IHDR + IDAT + IEND，RGBA8），
// 把设计稿里的均衡器符号光栅化成 4 个尺寸。产物提交进仓库，构建只负责拷贝。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'src', 'extension', 'icons')
const SIZES = [16, 32, 48, 128]

const TILE = [0x17, 0x19, 0x1d] // #17191d 深色底（浅色/深色工具栏都能看清）
const GLYPH = [0x4f, 0xd6, 0xb8] // #4fd6b8 品牌青

// 设计稿的 24 单位视图：两条短横 + 三条竖线，描边宽 2（圆头 → 胶囊）
const STROKES = [
  [3, 12, 5, 12],
  [8, 8, 8, 16],
  [12, 4, 12, 20],
  [16, 8, 16, 16],
  [19, 12, 21, 12],
]
const STROKE_WIDTH = 2
const VIEW = 24

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 点到线段的距离：描边按胶囊（圆头）判定，省掉单独画圆角
function distanceToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function insideRoundedTile(px, py, radius) {
  const cx = Math.min(Math.max(px, radius), VIEW - radius)
  const cy = Math.min(Math.max(py, radius), VIEW - radius)
  if (px >= 0 && px <= VIEW && py >= 0 && py <= VIEW) {
    const dx = px - cx
    const dy = py - cy
    return dx * dx + dy * dy <= radius * radius
  }
  return false
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = 4
  const radius = VIEW * 0.22
  const half = STROKE_WIDTH / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tileHits = 0
      let glyphHits = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = ((x + (sx + 0.5) / samples) / size) * VIEW
          const py = ((y + (sy + 0.5) / samples) / size) * VIEW
          if (insideRoundedTile(px, py, radius)) tileHits++
          for (const stroke of STROKES) {
            if (distanceToSegment(px, py, stroke) <= half) {
              glyphHits++
              break
            }
          }
        }
      }
      const total = samples * samples
      const tileAlpha = tileHits / total
      const glyphAlpha = (glyphHits / total) * tileAlpha
      const alpha = tileAlpha
      const at = (y * size + x) * 4
      for (let channel = 0; channel < 3; channel++) {
        rgba[at + channel] = Math.round(TILE[channel] * (1 - glyphAlpha) + GLYPH[channel] * glyphAlpha)
      }
      rgba[at + 3] = Math.round(alpha * 255)
    }
  }
  return encodePng(size, rgba)
}

await mkdir(OUT_DIR, { recursive: true })
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`)
  await writeFile(file, render(size))
  console.log(`[gen:icons] ${path.relative(ROOT, file)}`)
}
