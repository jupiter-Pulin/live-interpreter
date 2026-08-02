import { buildCaptureConstraints } from '/shared/audio-routing.mjs'
import { needsPermissionProbe } from '/shared/permission-probe.mjs'

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

export async function createPlayer(sinkId, { onPlaybackError } = {}) {
  // 不强制构造采样率：交由浏览器按设备实际输出率重采样，避免部分蓝牙耳机在非常规采样率下无声
  const ctx = new AudioContext()
  if (typeof ctx.setSinkId === 'function' && sinkId) {
    await ctx.setSinkId(sinkId)
  }
  if (ctx.state !== 'running') {
    await ctx.resume()
  }
  console.log(`[player] sink=${sinkId ?? '(default)'} state=${ctx.state} sampleRate=${ctx.sampleRate}`)
  // 挂起看门狗：Chrome 可能把后台标签页中输出到虚拟声卡（BlackHole）的上下文
  // 判为“不可闻”而挂起——字幕照常滚动但音频进不了虚拟麦克风（实机踩过：
  // 录音中段 10s 无声）。一旦挂起立即恢复并留日志。
  let closedByUs = false
  ctx.addEventListener('statechange', () => {
    console.log(`[player] statechange -> ${ctx.state}`)
    if (!closedByUs && ctx.state === 'suspended') {
      ctx.resume().catch((err) => onPlaybackError?.(err))
    }
  })
  let playhead = 0
  return {
    enqueue(bytes) {
      try {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {})
        }
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
      } catch (err) {
        onPlaybackError?.(err)
      }
    },
    stop() {
      closedByUs = true
      ctx.close()
    },
  }
}

async function listAudioDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
    .map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label, groupId: d.groupId }))
}

export async function enumerateAudioDevices() {
  let devices = await listAudioDevices()
  if (needsPermissionProbe(devices)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
    } catch {
      // 权限被拒时仍返回列表，由 preflight 判为 permission_denied
    }
    devices = await listAudioDevices()
  }
  return devices
}
