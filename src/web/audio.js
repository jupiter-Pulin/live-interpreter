import { buildCaptureConstraints } from '/shared/audio-routing.mjs'

// 浏览器音频接线：采集为 24kHz PCM16 块；播放端按 sinkId 定向输出。
// 判定逻辑一律在 src/shared/，此处只碰真实浏览器 API。

const SAMPLE_RATE = 24000

export async function startCapture(deviceId, onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia(buildCaptureConstraints(deviceId))
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  source.connect(processor)
  // 接零增益节点保证 onaudioprocess 触发，同时不外放采集到的声音
  const silent = ctx.createGain()
  silent.gain.value = 0
  processor.connect(silent)
  silent.connect(ctx.destination)
  processor.onaudioprocess = (e) => {
    const f32 = e.inputBuffer.getChannelData(0)
    const pcm = new Uint8Array(f32.length * 2)
    const view = new DataView(pcm.buffer)
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]))
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    onChunk(pcm)
  }
  return {
    stop() {
      processor.disconnect()
      source.disconnect()
      for (const track of stream.getTracks()) track.stop()
      ctx.close()
    },
  }
}

export async function createPlayer(sinkId) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  if (typeof ctx.setSinkId === 'function' && sinkId) {
    await ctx.setSinkId(sinkId)
  }
  let playhead = 0
  return {
    enqueue(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const frames = bytes.byteLength / 2
      const buffer = ctx.createBuffer(1, frames, SAMPLE_RATE)
      const ch = buffer.getChannelData(0)
      for (let i = 0; i < frames; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime, playhead)
      src.start(startAt)
      playhead = startAt + buffer.duration
    },
    stop() {
      ctx.close()
    },
  }
}

export async function enumerateAudioDevices() {
  // 先取一次权限，否则 enumerateDevices 的 label 为空
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
  } catch {
    // 权限被拒时仍返回列表，由 preflight 判为 permission_denied
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
    .map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label, groupId: d.groupId }))
}
