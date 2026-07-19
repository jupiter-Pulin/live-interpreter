// 设备预检：设备列表 + 用户覆盖 → 四角色分配（capture/virtualMic/monitor/mic）
// 全部失败路径返回结论对象、不抛异常；分配结果与列表顺序无关。

const ROLES = ['capture', 'monitor', 'mic', 'virtualMic']

function isBlackHole(entry) {
  return typeof entry.label === 'string' && entry.label.includes('BlackHole')
}

function physKey(entry) {
  return entry.groupId && entry.groupId !== '' ? `g:${entry.groupId}` : `l:${entry.label}`
}

function fail(category, message) {
  return { category, message }
}

function parseChannels(label) {
  const m = /(\d+)\s*ch/i.exec(label)
  return m ? Number(m[1]) : null
}

export function preflight(devices, overrides = {}) {
  // 规则 0：权限/枚举异常优先于一切设备判定
  if (devices.length === 0 || devices.every((d) => d.label === '')) {
    return fail('permission_denied', '设备列表不可用（列表为空或设备名全为空），请先授予浏览器麦克风权限后重试。')
  }

  // 规则 0'：覆盖值必须真实存在
  const byId = new Map(devices.map((d) => [d.deviceId, d]))
  for (const role of ROLES) {
    const id = overrides[role]
    if (id !== undefined && !byId.has(id)) {
      return fail('device_missing', `角色 ${role} 选择的设备已失效（在当前设备列表中不存在），请重新选择。`)
    }
  }

  // 规则 1：BlackHole 条目按物理设备归并（同一块声卡有 input/output 两条记录）
  const blocks = new Map()
  for (const d of devices.filter(isBlackHole)) {
    const key = physKey(d)
    if (!blocks.has(key)) blocks.set(key, [])
    blocks.get(key).push(d)
  }

  // 规则 2：物理块数不足（无条件判定，覆盖不绕过）
  if (blocks.size === 0) {
    return fail(
      'device_missing',
      '未检测到 BlackHole 虚拟声卡：请先安装 BlackHole（建议 2ch 与 16ch 各一块），并在「音频 MIDI 设置」中创建多输出设备后重试。'
    )
  }
  if (blocks.size === 1) {
    return fail(
      'device_missing',
      '只检测到一块 BlackHole 设备：还缺第二个 BlackHole 设备（用作虚拟麦克风），请再安装一个不同通道数的变体（如 16ch）。'
    )
  }

  // 规则 3：确定性排序（通道数升序，退化为块内最小 deviceId 字典序）
  const sortedBlocks = [...blocks.values()].sort((a, b) => {
    const ca = parseChannels(a[0].label)
    const cb = parseChannels(b[0].label)
    if (ca !== null && cb !== null && ca !== cb) return ca - cb
    const ida = a.map((d) => d.deviceId).sort()[0]
    const idb = b.map((d) => d.deviceId).sort()[0]
    return ida < idb ? -1 : 1
  })

  function pickFromBlock(block, kind) {
    return block
      .filter((d) => d.kind === kind)
      .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1))[0]
  }

  // 规则 4/5：capture 取第一块的 audioinput，virtualMic 取第二块的 audiooutput
  let captureEntry
  if (overrides.capture !== undefined) {
    captureEntry = byId.get(overrides.capture)
    if (captureEntry.kind !== 'audioinput') {
      return fail('device_missing', '角色 capture 必须选择一个输入端点（audioinput），当前选择不是输入设备。')
    }
  } else {
    captureEntry = pickFromBlock(sortedBlocks[0], 'audioinput')
    if (!captureEntry) {
      return fail('device_missing', '角色 capture 在所选 BlackHole 设备上取不到输入端点（缺少 audioinput 条目）。')
    }
  }

  let virtualMicEntry
  if (overrides.virtualMic !== undefined) {
    virtualMicEntry = byId.get(overrides.virtualMic)
    if (virtualMicEntry.kind !== 'audiooutput') {
      return fail('device_missing', '角色 virtualMic 必须选择一个输出端点（audiooutput），当前选择不是输出设备。')
    }
  } else {
    virtualMicEntry = pickFromBlock(sortedBlocks[1], 'audiooutput')
    if (!virtualMicEntry) {
      return fail('device_missing', '角色 virtualMic 在所选 BlackHole 设备上取不到输出端点（缺少 audiooutput 条目）。')
    }
  }

  // 规则 4：两角色必须分属不同物理设备（仅 deviceId 不同不足以通过）
  if (physKey(captureEntry) === physKey(virtualMicEntry)) {
    return fail('device_missing', 'capture 与 virtualMic 必须使用两块不同的 BlackHole 设备：当前选择落在同一块物理设备上。')
  }

  // 规则 6/7：monitor / mic 取非 BlackHole 条目中 deviceId 字典序最小者
  function pickNonBlackHole(kind, roleLabel, emptyMessage) {
    const overrideId = overrides[roleLabel]
    if (overrideId !== undefined) {
      const entry = byId.get(overrideId)
      // 规则 8：自听回环防线
      if (isBlackHole(entry)) {
        return fail('device_missing', `角色 ${roleLabel} 不能使用 BlackHole 设备：这会造成自听回环，请选择真实的耳机或麦克风。`)
      }
      if (entry.kind !== kind) {
        return fail('device_missing', `角色 ${roleLabel} 选择的设备类型不符（需要 ${kind}），请重新选择。`)
      }
      return entry
    }
    const candidates = devices
      .filter((d) => d.kind === kind && !isBlackHole(d))
      .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1))
    if (candidates.length === 0) return fail('device_missing', emptyMessage)
    return candidates[0]
  }

  const monitorEntry = pickNonBlackHole(
    'audiooutput',
    'monitor',
    '找不到可用的耳机/扬声器输出设备（非 BlackHole）：monitor 角色无可选设备。'
  )
  if (monitorEntry.category) return monitorEntry
  const micEntry = pickNonBlackHole(
    'audioinput',
    'mic',
    '找不到可用的麦克风输入设备（非 BlackHole）：mic 角色无可选设备。'
  )
  if (micEntry.category) return micEntry

  return {
    category: 'ok',
    roles: {
      capture: captureEntry.deviceId,
      virtualMic: virtualMicEntry.deviceId,
      monitor: monitorEntry.deviceId,
      mic: micEntry.deviceId,
    },
    labels: {
      capture: captureEntry.label,
      virtualMic: virtualMicEntry.label,
      monitor: monitorEntry.label,
      mic: micEntry.label,
    },
  }
}
