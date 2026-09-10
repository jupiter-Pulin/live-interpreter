# Tech Spec: 会议同传浏览器插件（Live Interpreter Extension）

## Summary

把需要在 `http://localhost:5173/` 手动选设备、分别点「启动下行 / 启动上行 / 解除静音」的网页版，改成 Chrome 扩展。用户点「开启同传」时插件冷启动：连接会议音频（建桥）→ 通过 Native Messaging 拉起本地 Node 翻译服务 → 为两方向建立翻译会话，界面分步转圈，全部就绪后弹系统通知「同传已就绪」。桥是一座常驻的**音频桥**：两方向原声直通，翻译叠在上面——翻译播放时原声压低、停顿时恢复，任何状态不断声；「关闭同传」只撤翻译与本地服务，桥不动；翻译层失败不影响桥。用户在 Google Meet 里静音时，只读探测脚本上报静音态，插件暂停翻译用户的话、继续翻译对方。不自动连接。面板照 `design/extension/Main.dc.html`（弹窗 380×600）与 `Docked.dc.html`（侧栏 360 宽）实现。`OPENAI_API_KEY` 只存在于 Node 进程。语言能力以 OpenAI 官方文档为准：输入自动识别，面板只选两个目标语言（13 种或原声）。网页版及其专用代码、测试一并移除。方案取舍见 `./0-feasibility-study.md`，产品规则与上游限制见 `./1-requirements.md`。

## 变更记录

### 2026-09-10 实机反馈：关闭即释放、开启可取消

实机试用后用户决定两处修改。本节优先于下文中与之冲突的旧表述；旧 AC 编号保留不重排，并在行首标注被哪条新 AC 取代。

1. **关闭即释放**：插件只在同传「开启中 / 进行中 / 关闭中」占用麦克风与音频设备。「关闭同传」、开启途中取消、任何失败（翻译层或桥）的终态，都撤掉宿主、翻译层、桥与离屏文档，macOS 的橙色麦克风指示随之消失。「断开会议音频」入口与「原声直通中」状态取消；桥因缺设备失败后不再在插回设备时自动重连，因为那会在非开启状态下重新占用麦克风。代价：关闭后插件不再转送任何声音，会议里的麦克风若仍选着 BlackHole 16ch，对方听不到你。
2. **开启可取消**：开启中主按钮是可点的「取消开启」（带转圈，三段步骤文案照常）。点击即作废在途的建桥、宿主与会话，回到「同传已关闭」，不发任何通知，之后可立刻重新开启。

取代关系：AC-102 → AC-147；AC-104 中「开启中收到 `li:power {on:false}` 返回 busy」→ AC-146；AC-138 → AC-148；AC-140 → AC-147、AC-149；AC-141 后半（`devicechange` 自动重试）→ AC-148；AC-126、AC-127 中「原声直通中 / 原声仍在直通 / 断开会议音频 / 正在开启… / 未连接会议音频」等文案 → AC-149；AC-121 中「桥已连未翻译显示灰点」→ AC-149。

## Context

现状代码流：

- `src/web/app.js`：页面控制器，「预检 → 端点 → 播放器 → 会话 → 采集」纯接线。本次删除。
- `src/web/audio.js`：`startCapture`（getUserMedia + ScriptProcessor → PCM16@24k，供翻译输入）、`createPlayer`（AudioContext + `setSinkId` + 挂起看门狗；只有 `enqueue`/`stop`）、`enumerateAudioDevices`。本次迁入 `src/extension/`，`createPlayer` 扩展为「直通 + 译文」混音器。
- `src/web/session.js`：`openTranslationSession`（mock 直连或 token 换取后连 OpenAI）。本次迁入 `src/extension/`。
- `src/shared/*`：纯逻辑。`DIRECTIONS` 固定语言对；`audio-routing.mjs` 的 `forwardMicAudio({ muted })` 已实现「静音时绝不调用 sink」、`buildCaptureConstraints` 关闭全部处理；`device-preflight.mjs` 拒绝 monitor/mic 使用 BlackHole 或多输出/聚合设备（自听回环防线）——直通复用同一规则即不会成环；`session-state.mjs` 是网页版状态机（本次删除）。
- `src/server/index.mjs`：`createServer({ backend, apiKey, exchangeToken, mockWsUrl })`：静态文件 + `/api/config` + `/api/session-token`（无鉴权）+ CLI 入口。静态托管、`/api/config`、CLI 只服务网页版，本次删除。
- `src/server/mock-realtime.mjs`、`tools/e2e-real.mjs`：不变。

上游能力（OpenAI Live Translation guide 与 Cookbook，2026-09 核对）：

- 输入语言自动识别、70+ 种，API 无输入语言字段；输出语言 `session.audio.output.language`，13 种：en es pt fr de it ru zh ja ko hi id vi（码以实测为准）。
- 「Create one translation session for each target language」；未说明可否中途改语言 → 改语言一律重建该方向会话。
- 「tries not to translate speech that is already in the selected output language … may not produce translated audio for that segment」；官方建议保留原声并在译文播放时压低（duck）。本 spec 的衬底规则即此。
- 输入 24 kHz PCM16 持续 append，无 commit；按送入音频时长计费；未给会话时长/空闲上限。

扩展运行时约束（Chrome 官方文档；本机 Chrome 152，Node 22.23.1）：

- SW 无 DOM；离屏文档可用 getUserMedia / AudioContext，但只能用 `chrome.runtime`。`USER_MEDIA` reason 无寿命限制（不用 `AUDIO_PLAYBACK`）。`getContexts` 需 Chrome 116+。
- SW 空闲 30 秒终止；`connectNative` 端口与长连接消息维持 SW 存活。
- Native Messaging：4 字节小端长度 + UTF-8 JSON；宿主 → 扩展单帧 ≤ 1 MB；宿主随端口生灭；stdout 只写协议；cwd = 可执行文件目录；Dock 启动的 Chrome PATH 极简。
- 扩展无法读取其它标签页的 DOM/媒体轨道；感知 Meet 静音只能靠 `content_scripts`（`matches` 即授予注入权，不需额外 `host_permissions`）。Google Meet 的麦克风/摄像头按钮带 `data-is-muted`，图标为 Material 连字文本 `mic` / `mic_off`（与界面语言无关）——开发前在真实会议页验证。
- `chrome.notifications` 需 `notifications` 权限。Web Audio：同一 `AudioContext` 内 `MediaStreamSource → GainNode → destination` 直通约 10–30 ms，可与 `BufferSource` 译文混音。
- 最低支持版本 Chrome 116。

## Goals

- MUST 不自动连接：连接会议音频、占用麦克风、拉起本地服务只发生在用户点「开启同传」之后；浏览器启动后插件无动作。
- MUST 开启分步冷启动（连接会议音频 → 启动本地翻译服务 → 连接翻译服务），每步在面板有文案、按钮转圈、角标 `…`；就绪判定为桥已连接且每个翻译方向会话已打开、采集已启动；就绪后弹系统通知「同传已就绪」，正文按实际计划与 Meet 静音态生成；失败亦弹通知说明原因。
- MUST 同传进行中两方向原声直通；翻译叠在桥上，翻译播放时直通增益压到 `floorLevel`（0 / 0.25 / 0.5，默认 0.25），译文队列播完 0.7 s 后恢复 1.0。桥只随同传存在：「关闭同传」、开启途中取消、任何失败都撤掉宿主、翻译层、桥与离屏文档，非开启状态不占用麦克风（2026-09-10 变更）。
- MUST Meet 静音感知：只读探测脚本上报 `meetingMuted`；翻译中且 `meetingMuted === true` 时暂停上行翻译（不送麦克风音频、丢弃并清空译文、直通保持 1.0），下行不受影响；取消静音即恢复，暂停期间上行会话被对端关闭则自动重建；静音态未知时不暂停并明示。
- MUST 「开启」时由扩展拉起本地 Node 翻译服务，「关闭」时该进程退出；`OPENAI_API_KEY` 只在 Node 进程；扩展只持有短期凭证与启动令牌。
- MUST 面板提供「你想听的语言 / 对方听的语言」两个下拉，各为 13 种之一或「原声（不翻译）」，持久化，默认 `zh` / `en`；不提供「你说的语言」。
- MUST 桥失败与翻译失败分开展示（标题不同），文案可行动。
- MUST 开启中可取消：主按钮为「取消开启」，点击即作废在途的建桥、宿主与会话并回到初始，不发通知（2026-09-10 变更）。
- MUST 不向会议页面注入任何 UI、不改 DOM、不碰媒体轨道；唯一的内容脚本只读取 Meet 麦克风按钮的静音态。
- MUST 移除网页版：页面、控制器、静态托管、`/api/config`、CLI 入口、`npm start`/`start:real`、`session-state.mjs` 及其专用测试；扩展仍在用的公共能力保留。
- SHOULD 弹窗可停靠侧栏；选项页承接设备角色、授权、衬底音量、本地服务自检。

## Non-goals

- 不改音频路由方案（两块 BlackHole + 多输出设备，手动安装）。
- 不做插件自带静音按钮；不感知 Meet 以外平台的静音。
- 不消除「每句开头 1–2 s 原声尚未压低」。
- 不做自动连接、自动重连（暂停期间上行按需重建、设备变化后重试除外）；不做字幕上屏；不在面板显示字幕与延迟。
- 不做 Web Store 发布；不支持 Firefox / Safari / Windows / Linux。
- 不把 `OPENAI_API_KEY` 放进扩展；不改 `session-protocol.mjs` 的消息形态与 idle-commit 语义；不改 `device-preflight.mjs` 规则；不改 `mock-realtime.mjs`。
- 不引入打包器、框架或新的运行时依赖。
- 不保留网页版作为调试面。

## Contract

### Core Invariants

- **原声是底，翻译是顶**：同传进行中每个方向始终存在一条直通路（输入设备 → 增益 → 输出设备）；翻译只通过同一输出混入，并只在译文播放期间把直通增益压到 `floorLevel`。
- **非开启不占用**（2026-09-10 变更）：`phase ∉ { starting, on, stopping }` 时不存在离屏文档、getUserMedia 流与宿主进程；关闭、取消、失败统一经 `releaseAll` 撤掉一切后才落终态。
- **用户触发才占用**：浏览器启动、扩展安装、SW 唤醒都不得调用 getUserMedia、创建离屏文档或 `connectNative`；这些只由 `li:power {on:true}` 触发；UI 没有只建桥不翻译的入口，也没有只断开桥的入口；设备变化不触发任何动作。
- 判定逻辑只在 `src/shared/`（设备预检、方向计划、语言目录、端点选择、运行态状态机、衬底目标增益、协议帧、错误分类、静音门控 `forwardMicAudio`、Meet 静音态解析）；SW / 离屏 / 面板 / 选项页 / 探测脚本只做接线。
- 翻译层失败（宿主、凭证、WS、网络、改语言重建、恢复时发现半启动）终态为 `phase = error`、`bridge = disconnected`；桥失败（预检、授权、播放上下文丢失、直通 track 结束、离屏文档丢失）终态为 `bridge = failed`、`phase = error`；两者都已撤掉一切。
- 暂停上行只改变上行：采集块经 `forwardMicAudio({ muted: uplinkPaused })` 门控、到达的上行译文帧丢弃、上行播放器 `flush()`、上行直通 `holdFloorFull(true)`；下行对象引用与数据流不受任何影响。
- Meet 探测脚本只读：不创建/修改/删除任何 DOM 节点或样式，不访问网络，不访问媒体设备，只 `querySelector` 与 `MutationObserver` 读取麦克风按钮的 `data-is-muted`，只向本扩展 `sendMessage`。
- `DIRECTIONS` 由 `buildDirections(DEFAULT_SETTINGS)` 定义，`source` 一律 `'auto'`；`createSession` 不传 `directionTable` 时行为不变。
- 服务端 `createServer` 未传 `launchToken` 时 `/api/session-token` 行为与现在一致；传了则必须带 `Authorization: Bearer <launchToken>`，否则 401 且不调用 `exchangeToken`。
- `OPENAI_API_KEY` 与 `launchToken` 都不写入 `chrome.storage`；`launchToken` 只存在于 SW 内存、发往离屏的消息与离屏内存。
- manifest：`permissions` 恰为 `offscreen`、`nativeMessaging`、`storage`、`sidePanel`、`notifications`；`host_permissions` 恰为 `http://127.0.0.1/*`；`content_scripts` 恰一条，`matches` 恰为 `https://meet.google.com/*`。
- 每条 `chrome.runtime` 消息带 `to`（`sw` / `offscreen` / `ui`）；非己方消息返回 `false` 且不 `sendResponse`。
- 宿主 stdout 只写协议帧，日志走 stderr。

### API / Entry Points

新增 / 修改：

| Endpoint / Function | Change | Notes |
| --- | --- | --- |
| `src/extension/manifest.json` | add | MV3；固定 `key`；`action.default_popup = popup.html`；`side_panel.default_path = sidepanel.html`；`options_ui.page = options.html`；`background.service_worker = background.js`, `type: module`；`content_scripts: [{ matches: ['https://meet.google.com/*'], js: ['meet-mute.js'], run_at: 'document_idle' }]`；`minimum_chrome_version: "116"` |
| `src/extension/background.js` | add | SW：桥与翻译层编排（冷启动步骤）、native 端口、离屏文档、状态镜像、badge、通知、恢复、Meet 静音态接收与暂停转发、设备变化重试 |
| `src/extension/offscreen.html` + `offscreen.js` | add | 桥（直通 + 播放器）与翻译层（会话 + 采集）宿主；上行暂停门控；挂起/重建 |
| `src/extension/meet-mute.js` | add | 只读 Meet 静音探测脚本 |
| `src/extension/audio.js` | move + modify | 自 `src/web/audio.js` 迁入；`createPlayer(sinkId, { onPlaybackError, floorLevel })` 新增 `attachFloor(stream)`、`setFloorLevel(level)`、`holdFloorFull(on)`、`flush()`；其余不变 |
| `src/extension/session.js` | move + modify | 自 `src/web/session.js` 迁入；`endpoint.url ?? endpoint.path` + `endpoint.headers`；可选 `directionTable` |
| `src/extension/popup.html`, `sidepanel.html`, `panel.js`, `panel.css` | add | 弹窗与侧栏共用；步骤文案、取消开启、暂停提示 |
| `src/extension/options.html` + `options.js` | add | 设备角色、授权、衬底音量、本地服务自检、静音感知与限制提示 |
| `src/extension/icons/icon{16,32,48,128}.png` | add | `tools/gen-icons.mjs` 生成并提交 |
| `src/server/native-host.mjs` | add | Native Messaging 宿主入口 |
| `src/server/index.mjs` `createServer({ backend, apiKey, exchangeToken, launchToken })` | modify | 删静态托管、`/api/config`、`mockWsUrl`、CLI；加 `launchToken`；其它路径 404 JSON |
| `src/shared/languages.mjs` | add | `OUTPUT_LANGUAGES`（13）、`ORIGINAL`、`ORIGINAL_LABEL`、`labelFor`、`isOutputLanguage`、`isTargetChoice` |
| `src/shared/direction-plan.mjs` | add | `DEFAULT_SETTINGS`、`normalizeSettings`、`buildDirections`、`diffPlan` |
| `src/shared/directions.mjs` | modify | `DIRECTIONS = buildDirections(DEFAULT_SETTINGS)`；`source: 'auto'`；`mode` |
| `src/shared/floor.mjs` | add | `FLOOR_LEVELS = [0, 0.25, 0.5]`、`floorTarget({ translating, holdFull, level })`、`isTranslating({ now, playhead, releaseMs })`、`FLOOR_ATTACK_MS = 50`、`FLOOR_RELEASE_MS = 700`、`FLOOR_RECOVER_MS = 200` |
| `src/shared/meeting-mute.mjs` | add | `parseMeetMuteState({ buttons })`（纯函数：从 `[{ dataIsMuted, text }]` 列表中找图标文本含 `mic`/`mic_off` 的按钮，返回 `true/false/null`）、`resolveMeetingMuted(reports)`（按最近上报取值，缺省 `null`） |
| `src/shared/audio-routing.mjs` | modify | 新增 `buildFloorConstraints(deviceId, inputRole)`：`capture` → 三项处理全关；`mic` → `echoCancellation: true, noiseSuppression: true, autoGainControl: false` |
| `src/shared/session-endpoint.mjs` | modify | 第二参 `{ baseUrl, launchToken }`；返回 `url`、`headers` |
| `src/shared/session-protocol.mjs` | modify | 可选 `directionTable` |
| `src/shared/errors.mjs` | modify | 新增 `host_unavailable` |
| `src/shared/native-errors.mjs` | add | `classifyNativeError(lastErrorMessage)` |
| `src/shared/native-protocol.mjs` | add | `encodeFrame`、`createFrameDecoder({ maxBytes, onFrame, onError })` |
| `src/shared/runtime-state.mjs` | add | 桥 + 翻译层状态机（含 `startStep`、`meetingMuted`）、`badgeFor`、`planRecovery`、`statusCopy`、`readyCopy`、`failureCopy`、`stripSecrets` |
| `tools/build-extension.mjs`、`install-native-host.mjs`、`extension-id.mjs`、`gen-ext-key.mjs`、`gen-icons.mjs` | add | 零依赖工具链 |
| `package.json` scripts | modify | 删 `start`、`start:real`；加 `build:ext`、`install:host`、`gen:icons`；保留 `test`、`e2e:real` |
| `.gitignore` | modify | `dist` |
| `README.md` | modify | 删网页版；新增「浏览器插件」：安装、开启（冷启动与就绪通知）、原声直通与关闭、Meet 静音、语言能力与限制、建议耳机、安装提示说明 |

删除：

| Path | Reason |
| --- | --- |
| `src/web/index.html`、`src/web/app.js`、`src/web/`（目录） | 网页版入口；接线文件迁入 `src/extension/` 后目录为空 |
| `src/shared/session-state.mjs` | 由 `runtime-state.mjs` 取代 |
| `src/server/index.mjs` 中 `serveStatic`、`CONTENT_TYPES`、`/api/config`、CLI 启动块 | 只服务网页版 |
| `tests/unit/subtitle-panel-static.test.mjs` | 只测网页版 DOM |

### 扩展内消息（`chrome.runtime.sendMessage` / `connect`）

```jsonc
// UI → SW
{ "type": "li:power", "to": "sw", "on": true }       // 冷启动：建桥 → 宿主 → 会话；→ { ok } | { ok:false, reason:'busy' }
{ "type": "li:power", "to": "sw", "on": false }      // 进行中 = 关闭并释放一切；开启中 = 取消；关闭中 → busy
{ "type": "li:set-settings", "to": "sw", "hear": "ja", "partnerHears": "en", "floorLevel": 0.25, "deviceOverrides": { … } }
//   任意子集；normalizeSettings 后写 storage.local；语言变化且 phase=on → li:update-plan；floorLevel 变化且 bridge=connected → li:set-floor

// 探测脚本 → SW（sender.tab 必须存在且 url 为 meet.google.com）
{ "type": "li:meeting-mute", "to": "sw", "platform": "meet", "muted": true | false | null }
//   null = 页面上找不到麦克风按钮 / 页面卸载；SW 记录 { tabId, muted }，resolveMeetingMuted 得到 runtime.meetingMuted

// SW → 离屏
{ "type": "li:connect", "to": "offscreen", "deviceOverrides": { … }, "floorLevel": 0.25 }
//   → { ok:true, roles, labels } | { ok:false, error }（离屏已自行收尾）
{ "type": "li:disconnect", "to": "offscreen" }       // 先撤翻译再撤直通与播放器 → { ok:true }；关闭、取消、失败都经 releaseAll 发它，随后关闭离屏文档
{ "type": "li:start", "to": "offscreen", "plan": { … }, "uplinkPaused": false,
  "server": { "baseUrl", "backend", "mockWsUrl", "launchToken" } }
//   → { ok:true, directions: { downlink: { status:'running', mode }, uplink: { … } } } | { ok:false, error }（只撤翻译层）
//   就绪判定在离屏：每个 translate 方向的 session 收到 'open' 且 startCapture 返回后才回复 ok
{ "type": "li:stop", "to": "offscreen" }             // 只撤翻译层，直通回 1.0 → { ok:true }（SW 已不再发送，保留为离屏能力）
{ "type": "li:update-plan", "to": "offscreen", "plan": { … }, "server": { … } }   // → { ok:true, restarted: ["downlink"] }
{ "type": "li:set-uplink-paused", "to": "offscreen", "paused": false }             // → { ok:true, restarted: [] | ["uplink"] }
{ "type": "li:set-floor", "to": "offscreen", "level": 0 }                          // → { ok:true }
{ "type": "li:server-changed", "to": "offscreen", "server": { … } }

// 离屏 → SW
{ "type": "li:pipeline-event", "to": "sw",
  "event": "error" | "closed" | "latency" | "uplink-suspended" | "uplink-resumed" | "bridge-lost" | "devicechange",
  "directionId": "uplink", "payload": { "category": "network_unavailable", "message": "…" } }

// 离屏 ↔ SW 长连接：连接成功后 chrome.runtime.connect({ name: "li-keepalive" })，每 20 s ping/pong；
// bridge ∈ { connected, connecting } 时端口断开 = 离屏文档丢失（见 AC-122）。
```

### Meet 静音探测脚本契约（`src/extension/meet-mute.js`）

- 运行于 `https://meet.google.com/*`，`document_idle`。
- 每 1 s 或 DOM 变化时收集 `document.querySelectorAll('[data-is-muted]')` 的 `{ dataIsMuted: el.getAttribute('data-is-muted'), text: el.textContent }` 列表，交给 `parseMeetMuteState` 得到 `true/false/null`，**仅在值变化时** `sendMessage({ type: 'li:meeting-mute', to: 'sw', platform: 'meet', muted })`；`pagehide` 时上报 `null`。
- 禁止：`createElement`、`appendChild`、`insertBefore`、`innerHTML`、`outerHTML`、`textContent =`、`style.`、`setAttribute`、`classList`、`fetch`、`XMLHttpRequest`、`WebSocket`、`getUserMedia`、`mediaDevices`、`addEventListener` 于 `click`/`keydown` 等输入事件。
- SW 侧：收到消息时校验 `sender.tab?.url` 以 `https://meet.google.com/` 开头，否则忽略；记录 `{ tabId: sender.tab.id, muted }`；`chrome.tabs.onRemoved` 移除该 tab 记录。

### 系统通知契约（`chrome.notifications`）

| 时机 | id | title | message（由纯函数生成） |
| --- | --- | --- | --- |
| 就绪（`started` 后） | `li-ready` | 同传已就绪 | `readyCopy({ plan, meetingMuted })`：「本地翻译服务已启动，双向连接成功。对方说的会翻成{听}进你的耳机，你说的话会翻成{对方听}送进会议。」原声方向改为「对方的原声会直接进你的耳机」/「你的原声会直接送进会议」；`meetingMuted === true` 时第二句改为「你在会议里已静音，取消静音后你说的话会翻成{对方听}送进会议。」 |
| 翻译层失败（`failed`） | `li-failed` | 无法开启同传 | `failureCopy({ kind: 'translation', error })`：`error.message` |
| 桥失败（`bridgeFailed`） | `li-failed` | 无法连接会议音频 | `failureCopy({ kind: 'bridge', error })`：`error.message` |

`type: 'basic'`，`iconUrl: 'icons/icon128.png'`；同 id 覆盖前一条；关闭（`stopped`）与取消不通知。

### Native Messaging 宿主协议（stdin/stdout，4 字节小端长度前缀 + UTF-8 JSON）

```jsonc
// 宿主 → 扩展
{ "type": "ready", "port": 51234, "backend": "mock" | "real", "mockWsUrl": "ws://127.0.0.1:51235" | null,
  "launchToken": "<base64url, 32 随机字节>", "pid": 12345, "version": "0.1.0" }
{ "type": "error", "category": "config_missing" | "api_error", "message": "…" }     // 随后 exit 1
{ "type": "pong" }
// 扩展 → 宿主
{ "type": "shutdown" }   // 关闭 HTTP 与 mock WS 后 exit 0；stdin EOF 等价
{ "type": "ping" }
```

宿主名 `com.live_interpreter.host`；manifest 由安装脚本生成（`path` 指向 `<repo>/dist/native-host/host.sh`，`allowed_origins` 为 `chrome-extension://<extensionIdFromKey(manifest.key)>/`）；wrapper `cd <repo>`、存在 `.env` 则加 `--env-file=.env`、`exec "<process.execPath>" src/server/native-host.mjs "$@"`。宿主只在同传开启期间存在，每次开启冷启动。

### `chrome.storage` 结构

```jsonc
// chrome.storage.local（持久）
{ "settings": { "schemaVersion": 1, "hear": "zh", "partnerHears": "en", "floorLevel": 0.25,
                "deviceOverrides": { "capture": "id?", "monitor": "id?", "mic": "id?", "virtualMic": "id?" } } }

// chrome.storage.session（内存；只由 SW 写，UI 只读）
{ "runtime": { "bridge": "disconnected" | "connecting" | "connected" | "failed",
               "bridgeError": null | { "category": "…", "message": "…" },
               "phase": "off" | "starting" | "on" | "stopping" | "error",      // 翻译层
               "startStep": null | "bridge" | "host" | "translation",           // 仅 starting 时非空
               "error": null | { "category": "…", "message": "…" },
               "meetingMuted": null | true | false,                             // Meet 静音态；null = 未知
               "directions": { "downlink": { "status": "stopped" | "running", "mode": null | "translate" | "passthrough" },
                               "uplink":   { "status": "stopped" | "running" | "suspended", "mode": null | "…" } },
               "server": null | { "port": 51234, "backend": "mock" | "real" },   // 经 stripSecrets
               "languages": null | { "hear": "zh", "partnerHears": "en" },
               "latencyMs": null | 1234, "since": null | 1725000000000 } }
// 派生：uplinkPaused = phase === 'on' && meetingMuted === true（由 statusCopy/badgeFor 计算，不存储）
```

### 语言目录（`src/shared/languages.mjs`）

```jsonc
[ { "id": "zh", "label": "中文" }, { "id": "en", "label": "English" }, { "id": "ja", "label": "日本語" },
  { "id": "ko", "label": "한국어" }, { "id": "es", "label": "Español" }, { "id": "fr", "label": "Français" },
  { "id": "pt", "label": "Português" }, { "id": "de", "label": "Deutsch" }, { "id": "it", "label": "Italiano" },
  { "id": "ru", "label": "Русский" }, { "id": "hi", "label": "हिन्दी" }, { "id": "id", "label": "Bahasa Indonesia" },
  { "id": "vi", "label": "Tiếng Việt" } ]
// ORIGINAL = 'original'，ORIGINAL_LABEL = '原声（不翻译）'；下拉在 13 项后以分隔线列出原声
```

### 方向计划（`src/shared/direction-plan.mjs`）

```jsonc
// DEFAULT_SETTINGS = { schemaVersion: 1, hear: 'zh', partnerHears: 'en', floorLevel: 0.25, deviceOverrides: {} }
// buildDirections({ hear: 'zh', partnerHears: 'en' }) === DIRECTIONS
{ "downlink": { "id": "downlink", "source": "auto", "target": "zh", "inputRole": "capture", "outputRole": "monitor",    "mode": "translate" },
  "uplink":   { "id": "uplink",   "source": "auto", "target": "en", "inputRole": "mic",     "outputRole": "virtualMic", "mode": "translate" } }
// 规则：downlink.target = hear；uplink.target = partnerHears；值为 'original' → target = null、mode = 'passthrough'。
// diffPlan(prev, next)：target 或 mode 任一不同即列入。
// normalizeSettings(raw)：hear 非 isTargetChoice → 'zh'；partnerHears 非 isTargetChoice → 'en'；floorLevel ∉ FLOOR_LEVELS → 0.25；
//   未知键（如旧的 speak、autoConnect）丢弃；deviceOverrides 只保留四个角色键且值为非空字符串。
```

### 音频图（每个方向一个 `AudioContext`，`setSinkId(outputRole 设备)`）

```
直通（桥）：getUserMedia(buildFloorConstraints(inputId, inputRole)) → MediaStreamSource → floorGain → destination
译文（翻译层）：player.enqueue(PCM16@24k) → BufferSource（按 playhead 排队）→ destination
采集（翻译层输入）：startCapture(inputId)（独立 24 kHz ctx，buildCaptureConstraints）→ session.sendAudio
衬底：enqueue 时 floorGain → floorTarget({ translating: true, holdFull, level }) 于 FLOOR_ATTACK_MS；
      isTranslating({ now, playhead, releaseMs: FLOOR_RELEASE_MS }) 变假后 floorGain → 1.0 于 FLOOR_RECOVER_MS；
      holdFloorFull(true)（上行暂停）或 mode = passthrough（从不 enqueue）→ 始终 1.0；setFloorLevel 即时生效。
```

### 运行态状态机（`src/shared/runtime-state.mjs`，纯转换）

桥：

| 当前 bridge | 事件 | 下一 bridge | 附带变化 |
| --- | --- | --- | --- |
| disconnected / failed | `connectRequested(s)` | connecting | `bridgeError = null`；若 `phase = starting` 则 `startStep = 'bridge'` |
| connecting | `bridgeConnected(s)` | connected | 若 `phase = starting` 则 `startStep = 'host'` |
| connecting / connected | `bridgeFailed(s, err)` | failed | `bridgeError = err`；若 `phase ≠ off` → `phase = error`、`error = err`、`startStep = null`、directions 全 stopped、server/languages 清空 |
| 任意 | `disconnected(s)` | disconnected | 回到初始（保留 `meetingMuted`）：`bridgeError = null`、`phase = off`、`startStep = null`、`error = null`、directions 全 stopped、server/languages/since 清空 |

翻译层：

| 当前 phase | 事件 | 下一 phase | 附带变化 |
| --- | --- | --- | --- |
| off / error | `requestStart(s)` | starting | `error = null`；`startStep = bridge === 'connected' ? 'host' : 'bridge'` |
| starting | `hostReady(s)` | starting | `startStep = 'translation'` |
| starting | `started(s, { directions, server, languages })` | on | 填 directions/server/languages/since；`startStep = null` |
| on | `latency(s, { directionId, ms })` | on | `latencyMs` |
| on | `uplinkSuspended(s)` | on | `directions.uplink.status = 'suspended'`（仅当 `meetingMuted === true`，否则不变） |
| on | `uplinkResumed(s)` | on | `directions.uplink.status = 'running'` |
| on | `planApplied(s, { directions, languages })` | on | 更新 directions/languages |
| on / starting / error | `requestStop(s)` | stopping | `startStep = null` |
| stopping | `stopped(s)` | off | 回到初始（桥一并撤掉，只保留 `meetingMuted`）；关闭与取消共用 |
| 任意 | `failed(s, err)` | error | 回到初始后置 `phase = error`、`error = err`（桥为 disconnected，只保留 `meetingMuted`） |
| 任意 | `meetingMute(s, muted)` | 不变 | `meetingMuted = muted`（`true/false/null`）；其它字段不变 |
| 其它组合 | 任意 | 不变 | 返回同一引用 |

`badgeFor(state)`（按优先级）：`bridge = failed` 或 `phase = error` → `{ text: '!', color: '#f07a68' }`；`bridge = connecting` 或 `phase ∈ { starting, stopping }` → `{ text: '…', color: '#6b7380' }`；`phase = on` 且 `meetingMuted === true` → `{ text: '●', color: '#e6b45a' }`；`phase = on` → `{ text: '●', color: '#4fd6b8' }`；否则 `{ text: '' }`（未开启一律无角标）。

`planRecovery({ runtime, hasNativePort, hasOffscreen })`（SW 顶层启动时调用；绝不返回需要占用设备的动作）：

| 条件 | 返回 |
| --- | --- |
| `bridge ∈ { connected, connecting }` 且 `!hasOffscreen` | `{ action: 'fail-bridge', error: { category: 'api_error', message: '会议音频桥意外中断，请重新开启。' } }` |
| `bridge = connected` 且 `phase = on` 且 `!hasNativePort` | `{ action: 'reconnect-host' }` |
| `phase ∈ { starting, stopping }`（不论桥走到哪一步） | `{ action: 'fail-translation', error: { category: 'api_error', message: '上次操作未完成，已重置为关闭。' } }` |
| 其它（含浏览器刚启动的初始态） | `{ action: 'none' }` |

`statusCopy({ bridge, bridgeError, phase, startStep, error, plan, meetingMuted })` 返回 `{ title, body, tone, primary, action, variant, spinner, lockFields, stepText, note, hint }`：`action ∈ { start, stop, cancel, null }` 决定主按钮发什么（`cancel` 与 `stop` 都发 `li:power {on:false}`），`null` 即不可点；`readyCopy`、`failureCopy` 见通知契约；`stripSecrets(server)` → `{ port, backend }`。

### Data / Cache / External Services

- 数据源：`chrome.storage.local.settings`、`chrome.storage.session.runtime`、`.env`（宿主进程读取）。无缓存；运行态不持久化。
- 外部服务：OpenAI realtime translations（协议层不变；每方向一个会话；改目标语言重建会话）；宿主 HTTP 只绑 `127.0.0.1:0`，只在同传开启期间存在。
- 错误行为：翻译层失败 → `releaseAll` + `failed` + 失败通知；桥失败 → `releaseAll` + `bridgeFailed` + 失败通知；两者都关闭离屏文档、撤宿主，不保留任何设备占用；暂停期间上行 `closed` → `uplinkSuspended`；绝不自动重连，设备变化不触发任何动作（2026-09-10 变更）。
- 超时：`li:connect` 10 s；`connectNative` 到 `ready` 10 s；`li:start` 15 s；恢复重建 15 s。

### Compatibility

- 网页版：移除。`tools/e2e-real.mjs` 不变。
- 字段：`DIRECTIONS.source` 改 `'auto'`、新增 `mode`；`CATEGORIES` 新增 `host_unavailable`；`settings` 新增 `floorLevel`。
- 扩展权限：新增 `notifications`；新增一条 `content_scripts`（仅 `https://meet.google.com/*`，只读）。
- 遗留测试处理清单（只允许这些改动；其余测试文件一字不改）：

| 文件 | 处理 | 原因 |
| --- | --- | --- |
| `tests/unit/subtitle-panel-static.test.mjs` | 删除 | 只测 `src/web/index.html` 与 `app.js` |
| `tests/unit/player-static.test.mjs` | 只改 `AUDIO_JS` 路径为 `src/extension/audio.js`；断言不变；追加 `flush`/`attachFloor`/`holdFloorFull` 用例（AC-133） | 文件迁移 |
| `tests/unit/audio-permission-probe-static.test.mjs` | 只改 `AUDIO_JS` 路径；断言不变 | 文件迁移 |
| `tests/unit/routing-state.test.mjs` | 删除对 `session-state.mjs` 的 import、「AC-016 状态机」用例、AC-015 中 `createInitialState().uplink.muted` 一行；AC-016 方向表用例 `source` 断言改为 `'auto'` 并追加 `mode`；追加 `buildFloorConstraints` 用例 | `session-state` 随网页版删除；输入语言自动识别 |
| `tests/integration/mock-pipeline.test.mjs` | 删除「服务端衔接守卫」段（`createServer({ mockWsUrl })` + `GET /api/config`）；守卫意图改由 `native-host.test.mjs` 以 `ready` 帧喂 `selectSessionEndpoint` 实现 | `/api/config` 随网页版删除 |
| `tests/integration/subtitle-isolation.test.mjs` | 只改注释中的路径 | 注释 |

- 发布/迁移：无数据迁移；扩展以未打包方式加载；`npm run install:host` 幂等，升级 Node 后需重跑。

## Acceptance Criteria

AC 编号从 101 起，避免与现有测试标题沿用的旧编号混淆；新增条目追加编号，不重排既有编号。

#### 音频桥与冷启动

- [ ] AC-136: 【手测里「关闭后原声仍直通」已由 AC-147 取代】Given 已授权、设备就绪、`runtime.bridge = disconnected`，when `li:power {on:true}`（SW 的第一步向离屏发 `li:connect`），then 10 s 内 `bridge` 经 `connecting` 到 `connected`，离屏文档存在，两方向各建立一条直通路（`getUserMedia` → `MediaStreamSource` → `GainNode` 增益 1.0 → 已 `setSinkId` 的 `destination`），直通约束分别来自 `buildFloorConstraints(id, 'capture')`（三项处理全关）与 `buildFloorConstraints(id, 'mic')`（AEC、NS 开，AGC 关）；建桥完成前未 `connectNative`、未请求 token；UI 层没有只建桥不翻译的入口（`panel.js`、`options.js` 不发送 `li:connect`，静态检查）；手测：开启后再「关闭同传」，耳机听到会议原声、BlackHole 16ch 录到我的原声，端到端延迟 < 50 ms。
- [ ] AC-137: `floorTarget({ translating, holdFull, level })`：`holdFull` → 1；否则 `translating` → `level`；否则 1。`isTranslating({ now, playhead, releaseMs: 700 })` 当且仅当 `now < playhead + 0.7` 为真。`createPlayer`：`enqueue` 时 50 ms 内把直通增益 ramp 到 `floorLevel`；队列播完且经过 700 ms 后 200 ms 内 ramp 回 1.0；`setFloorLevel(0)` 时译文播放期间增益为 0、停顿后仍回 1.0；`holdFloorFull(true)` 后 `enqueue` 不再压低且增益立即回 1.0；静态检查 `audio.js` 用 `linearRampToValueAtTime`（或 `setTargetAtTime`）改增益并从 `/shared/floor.mjs` 导入 `floorTarget`/`isTranslating`。
- [ ] AC-138: 【已由 AC-148 取代：翻译层失败现在连桥一起释放，正文不再含「原声仍在直通」】Given `bridge = connected`，when 开启同传因宿主不可用 / 凭证失败 / WS 失败 / 网络断开而 `failed`，then `runtime.bridge === 'connected'`、`phase === 'error'`，两方向 player 与直通 stream 引用不变、增益回到 1.0，离屏文档仍存在，native 端口已断开；弹窗标题「无法开启同传」且说明含「原声仍在直通」；已发出 id `li-failed` 的通知，正文等于 `failureCopy({ kind: 'translation', error, bridge: 'connected' })`；手测会议音频不中断。
- [ ] AC-139: 不自动连接：`background.js` 的 `onInstalled`、`onStartup` 处理器与顶层代码不调用 `chrome.offscreen.createDocument`、`connectNative`，也不向离屏发 `li:connect`/`li:start`（静态检查）；`planRecovery` 对初始 runtime 返回 `{ action: 'none' }`，且任何返回值的 `action` 不属于 `{ connect, start }`；手测：重启 Chrome 后 macOS 无橙色麦克风指示、`getContexts` 无离屏文档、badge 空、弹窗显示「同传已关闭」与「未连接会议音频」。
- [ ] AC-140: 【已由 AC-147、AC-149 取代：不再有「断开会议音频」入口】Given `bridge = connected`（`phase` 任意），when `li:disconnect`，then 若 `phase = on` 先撤翻译层（宿主退出），随后两方向 `player.stop()`、直通 track 全部 `readyState === 'ended'`、离屏文档关闭，`runtime` 回到初始（`meetingMuted` 保留），badge 为空；弹窗显示「未连接会议音频」及「会议现在听不到你，你也听不到会议」。
- [ ] AC-141: 【前半仍有效但离屏文档现在一并关闭；后半 devicechange 自动重试已由 AC-148 取代】Given `phase = on`，when 离屏上报 `bridge-lost`，then SW 执行 `bridgeFailed`：`bridge === 'failed'`、`phase === 'error'`、`bridgeError` 与 `error` 同一 message、宿主已退出、离屏文档保留、已发出 `li-failed` 通知（正文为 `failureCopy({ kind: 'bridge', error })`）；Given `bridge = failed` 且 `bridgeError.category === 'device_missing'`，when 离屏上报 `devicechange`，then SW 自动重试一次 `li:connect`（同一次 `devicechange` 至多一次），成功则 `connected`，仍失败则保持 `failed` 且不循环。
- [ ] AC-142: 冷启动步骤：Given `bridge = disconnected`、`phase = off`，when `li:power {on:true}`，then `runtime` 依次出现 `{ phase: 'starting', startStep: 'bridge' }` → `{ bridge: 'connected', startStep: 'host' }` → （宿主 `ready` 后）`{ startStep: 'translation' }` → `{ phase: 'on', startStep: null }`；Given `bridge = connected`，同一消息从 `startStep: 'host'` 开始；每个阶段弹窗按钮禁用并转圈，按钮下方 `stepText` 分别为「正在连接会议音频…」「正在启动本地翻译服务…」「正在连接翻译服务…」，badge 为 `…`；`startStep` 的每次变化都由 `runtime-state.mjs` 的转换产生（`background.js` 不含 `startStep =` 赋值）。
- [ ] AC-143: 就绪判定与通知：离屏对 `li:start` 只在每个 `mode = translate` 方向的会话收到 `open` 事件且 `startCapture` 已返回后才回复 `{ ok: true }`；SW 随即 `started` 并发出 id `li-ready` 的通知，title「同传已就绪」，message 等于 `readyCopy({ plan, meetingMuted })`：两方向 translate（zh / en）且 `meetingMuted !== true` → 「本地翻译服务已启动，双向连接成功。对方说的会翻成中文进你的耳机，你说的话会翻成 English 送进会议。」；`meetingMuted === true` → 第二句为「你在会议里已静音，取消静音后你说的话会翻成 English 送进会议。」；uplink passthrough → 「你的原声会直接送进会议」；downlink passthrough → 「对方的原声会直接进你的耳机」；任一方向在 `open` 前 `error`/`closed` → 不发 `li-ready`，按 AC-105 失败并发 `li-failed`；`stopped`、`disconnected` 不发通知。

#### 主流程

- [ ] AC-101: Given `bridge = connected`、`phase = off`，when `li:power {on:true}`，then 5 s 内 `phase` 经 `starting` 到 `on`，两方向 `directions.*.status === 'running'`、`server.port` 等于宿主 `ready` 帧的端口，弹窗标题「同传进行中」，badge 绿 `●`（`meetingMuted === true` 时琥珀 `●` 且说明「会议已静音 · 暂停翻译你的话」）；Given `bridge = disconnected`，同一消息先完成 AC-136 再继续（AC-142 的步骤）。
- [ ] AC-102: 【已由 AC-147 取代：关闭同传现在连桥与离屏文档一起释放】Given `phase = on`，when `li:power {on:false}`，then `phase` 经 `stopping` 到 `off`，两方向 session/capture 已 close/stop，player 与直通 stream 引用不变且增益回 1.0，native 端口已断开且宿主 2 s 内退出（`pgrep -f native-host.mjs` 无结果），离屏文档仍存在，`bridge === 'connected'`，badge 灰 `●`，弹窗标题「同传已关闭」且说明含「原声直通中」；手测耳机原声与 BlackHole 16ch 原声均不中断。
- [ ] AC-103: Given `phase = on`，when 关闭弹窗再重新打开，then 弹窗直接从 `storage.session.runtime` 渲染为「同传进行中」（含暂停态），期间 mock 提示音与直通原声都不中断。
- [ ] AC-104: 【「开启中收到 li:power {on:false} 为 busy」已由 AC-146 取代；其余仍有效】Given `bridge = connecting` 或 `phase ∈ { starting, stopping }`，when 收到 `li:power`，then 响应 `{ ok: false, reason: 'busy' }` 且 runtime 不变；弹窗电源按钮禁用并转圈，显示「正在开启…」/「正在关闭…」。
- [ ] AC-105: Given 任一翻译启动步骤失败（宿主连接、凭证、WS 建连、超时），then `phase = error`、`startStep = null` 且 `error.category/message` 为对应分类，已创建的 session/capture 全部 close/stop，native 端口已断开，桥与直通保持（AC-138），已发出 `li-failed` 通知；紧接着 `li:power {on:true}` 能从 error 直接重试。
- [ ] AC-106: 面板渲染只依赖 `storage.local.settings` 与 `storage.session.runtime`，通过 `chrome.storage.onChanged` 刷新；`panel.js` 源码不含 `getUserMedia`、`enumerateDevices`、`connectNative`、`chrome.offscreen`、`chrome.notifications`，不含对 `meetingMuted`/`bridge`/`startStep` 的判定表达式（文案、按钮、步骤、可见性全部来自 `statusCopy` 返回值）。

#### 语言与方向

- [ ] AC-107: `buildDirections(DEFAULT_SETTINGS)` 与 `DIRECTIONS` 深相等，且 `DIRECTIONS.downlink` 深等于 `{ id: 'downlink', source: 'auto', target: 'zh', inputRole: 'capture', outputRole: 'monitor', mode: 'translate' }`、`DIRECTIONS.uplink.target === 'en'`；`buildDirections({ hear: 'ja', partnerHears: 'ko' })` 得 `downlink.target === 'ja'`、`uplink.target === 'ko'`、两方向 `mode === 'translate'`、`source === 'auto'`；返回值不与 `DIRECTIONS` 共享引用。
- [ ] AC-108: `buildDirections({ hear: 'original', partnerHears: 'en' }).downlink` 为 `{ target: null, mode: 'passthrough' }`，`buildDirections({ hear: 'zh', partnerHears: 'original' }).uplink` 同理；`normalizeSettings({ speak: 'zh', autoConnect: true, hear: 'xx', partnerHears: 7, floorLevel: 0.3 })` 返回 `DEFAULT_SETTINGS`（丢弃未知键，不抛出）；`normalizeSettings({ hear: 'original' }).hear === 'original'`；`diffPlan` 只列出 target 或 mode 变化的方向。
- [ ] AC-109: Given `phase = on`，when `li:set-settings { hear: 'ja' }`，then 离屏只重启 downlink（`restarted` 深等于 `['downlink']`），uplink 的 capture/session/player 引用不变，新 downlink 会话的 `session.update` 中 `audio.output.language === 'ja'`，`runtime.languages.hear === 'ja'`；when `li:set-settings { partnerHears: 'original' }`，then 只把 uplink 重启为 passthrough（不建 WebSocket、不请求 token、直通 1.0），暂停态不变。
- [ ] AC-110: `mode === 'passthrough'` 的方向不调用 `openTranslationSession`、不调用 `startCapture`，也从不 `enqueue`，因此直通增益恒为 1.0；`offscreen.js` 中 passthrough 与 translate 的分支只以 `plan[directionId].mode` 为条件。
- [ ] AC-135: `OUTPUT_LANGUAGES.map(l => l.id)` 作为集合恰等于 `{ en, es, pt, fr, de, it, ru, zh, ja, ko, hi, id, vi }`，label 非空且两两不同；`ORIGINAL === 'original'` 且不在其中；`isTargetChoice('original') === true`、`isOutputLanguage('original') === false`、`labelFor('original') === '原声（不翻译）'`；扩展各接线文件不含语言码或语言标签字面量。

#### 本地服务与协议

- [ ] AC-111: `encodeFrame(obj)` 输出为 4 字节小端长度 + UTF-8 JSON；`createFrameDecoder()` 对逐字节、半包、粘包三种切分都按序还原出相同对象序列；单帧超过 `maxBytes`（默认 1 MiB）时 `onError` 上报且不再解析后续字节。
- [ ] AC-112: 以管道 stdio spawn `node src/server/native-host.mjs`（未设 `TRANSLATE_BACKEND`），首帧为 `{ type: 'ready', port, backend: 'mock', mockWsUrl, launchToken, pid, version }`，`port` 在 1024–65535，`launchToken` 解码后 ≥ 32 字节；stdout 除协议帧外无其它字节；`ready` 帧原样喂给 `selectSessionEndpoint` 得 `kind === 'mock-ws'` 且 `url === mockWsUrl`；`GET http://127.0.0.1:{port}/` 与 `/api/config` 均 404 JSON。
- [ ] AC-113: 关闭宿主 stdin 或发送 `{ type: 'shutdown' }` 后，进程 2 s 内以 0 退出，`port` 不再可连接；收到 `{ type: 'ping' }` 回 `{ type: 'pong' }`。
- [ ] AC-114: `createServer({ backend: 'real', apiKey, exchangeToken, launchToken: 't' })` 下，`POST /api/session-token` 缺少 `Authorization` 或值不等于 `Bearer t` → 401 `{ category: 'api_error', message }` 且 `exchangeToken` 未被调用；值正确 → 现有 200/500/502 分支不变；不传 `launchToken` 时 `token-endpoint.test.mjs` 现有三个用例原样通过。

#### 扩展包、构建、安装

- [ ] AC-115: `manifest.json`：`manifest_version === 3`；`permissions` 集合恰等于 `{ offscreen, nativeMessaging, storage, sidePanel, notifications }`；`host_permissions` 深等于 `['http://127.0.0.1/*']`；`content_scripts` 恰一条且深等于 `{ matches: ['https://meet.google.com/*'], js: ['meet-mute.js'], run_at: 'document_idle' }`；无 `web_accessible_resources`；`background.type === 'module'`；含非空 `key`；`action.default_popup === 'popup.html'`；`side_panel.default_path === 'sidepanel.html'`；`options_ui.page === 'options.html'`；`minimum_chrome_version === '116'`。
- [ ] AC-116: `node tools/build-extension.mjs --out <dir>` 产出 `manifest.json`（`version` 等于 `package.json` 的）、`shared/` 下与 `src/shared/*.mjs` 同名同内容的全部文件、`audio.js`、`session.js`、`meet-mute.js`、`background.js`、`offscreen.html`、`offscreen.js`、`popup.html`、`sidepanel.html`、`panel.js`、`panel.css`、`options.html`、`options.js`、`icons/icon{16,32,48,128}.png`；不产出 `.env`、`node_modules`、`src/server` 任何文件。
- [ ] AC-117: `extensionIdFromKey(key)` 对固定向量返回固定的 32 位 a–p 字符串；`node tools/install-native-host.mjs --home <tmp>` 写入宿主 manifest（`name/description/path/type: 'stdio'/allowed_origins`），`path` 指向可执行 wrapper，wrapper 含 `process.execPath` 与仓库根绝对路径；连续执行两次产物逐字节相同；`--browser edge` 写到 `Microsoft Edge/NativeMessagingHosts/`。
- [ ] AC-118: `.gitignore` 含 `dist`；`git ls-files` 不含 `dist/`；`repo-hygiene` 的密钥扫描对 `src/extension/**` 与 `tools/**` 通过。
- [ ] AC-119: `background.js`、`offscreen.js`、`panel.js`、`options.js`、`meet-mute.js` 源码均不含 `BlackHole` 字面量、`label === ''`、`/api/session-token` 字面量；状态转换只通过 `/shared/runtime-state.mjs` 导入的函数完成（`background.js` 不含 `phase =`、`bridge =`、`startStep =`、`meetingMuted =` 赋值）；`offscreen.js` 的上行送音只经 `forwardMicAudio`、直通约束只经 `buildFloorConstraints`；`meet-mute.js` 的静音判定只经 `parseMeetMuteState`；`shared-purity` 对新增 shared 模块通过。

#### 状态与恢复

- [ ] AC-120: `runtime-state.mjs` 转换表与「运行态状态机」一节一致：合法转换返回新对象且不修改入参；非法转换返回同一引用；`connectRequested` 只接受 `disconnected`/`failed`；`requestStart` 在 `bridge = connected` 时 `startStep = 'host'`，否则 `'bridge'`；`hostReady` 只在 `starting` 有效；`bridgeFailed` 在 `phase ≠ off` 时把 `phase` 置 `error`、`startStep = null` 并清空 directions/server；`disconnected` 回到初始形状但保留 `meetingMuted`；`stopped`/`failed` 不改 `bridge`；`meetingMute` 在任何 phase 都只改 `meetingMuted`；`uplinkSuspended` 在 `meetingMuted !== true` 时返回同一引用。
- [ ] AC-121: `badgeFor` 对 disconnected / connecting / connected+off / starting / on / on+meetingMuted / stopping / error / bridge failed 九种状态的返回值与「运行态状态机」一节逐项相等（优先级：失败 > 过渡 > 静音 > 同传 > 已连接 > 未连接）；SW 每次写 runtime 后调用 `chrome.action.setBadgeText/BackgroundColor`（静态检查）。
- [ ] AC-122: `planRecovery` 四种条件的返回值与表格逐项相等，且对初始 runtime 返回 `none`；`background.js` 顶层执行 `planRecovery` 并按 `action` 分派（静态检查）。
- [ ] AC-123: 离屏上报 `li:pipeline-event { event: 'closed' | 'error', payload.category: 'network_unavailable' }` 或翻译层超时，SW 执行 `failed`（桥保持，AC-138），不自动重连（`background.js` 不含翻译层重连循环）；唯一例外：`directionId === 'uplink'` 且当前上行处于暂停（`meetingMuted === true`）的 `closed` → 离屏改报 `uplink-suspended`，SW 执行 `uplinkSuspended`，`phase` 保持 `on`。

#### 兼容与安全

- [ ] AC-124: `selectSessionEndpoint(config)` 单参调用：mock 分支 JSON 不含 `/api/session-token` 也不含 `headers`；real 分支 `url === path === '/api/session-token'`；`selectSessionEndpoint({ backend: 'real' }, { baseUrl: 'http://127.0.0.1:4321', launchToken: 't' })` 得 `url === 'http://127.0.0.1:4321/api/session-token'`、`headers.Authorization === 'Bearer t'`；mock 分支带同样第二参仍不含 token 路径与 headers。
- [ ] AC-125: `stripSecrets({ port, backend, launchToken, mockWsUrl, baseUrl })` 深等于 `{ port, backend }`；`background.js` 对 `chrome.storage.session.set` 的 `server` 字段只经 `stripSecrets` 写入，`chrome.storage.local.set` 的写入对象不含 `launchToken`（静态检查）；`npm test` 保留的全部用例通过，遗留测试改动仅限 Compatibility 清单。
- [ ] AC-134: 网页版已移除：`src/web/` 目录、`src/shared/session-state.mjs`、`tests/unit/subtitle-panel-static.test.mjs` 不存在；`src/server/index.mjs` 不含 `serveStatic`、`/api/config`、`readFile`、`process.env`；`createServer` 实例对 `GET /`、`GET /api/config`、`GET /index.html` 均 404 JSON；`package.json.scripts` 不含 `start`/`start:real`，含 `build:ext`、`install:host`、`test`、`e2e:real`；`tools/e2e-real.mjs` 不含 `mockWsUrl`。
- [ ] AC-144: 探测脚本只读：`meet-mute.js` 源码不含 `createElement`、`appendChild`、`insertBefore`、`innerHTML`、`outerHTML`、`textContent =`、`style.`、`setAttribute`、`classList`、`fetch(`、`XMLHttpRequest`、`WebSocket`、`getUserMedia`、`mediaDevices`、`addEventListener('click'`/`'keydown'`/`'keyup'`；含 `MutationObserver` 与 `chrome.runtime.sendMessage`；只向 `to: 'sw'` 发 `li:meeting-mute`；`background.js` 在处理 `li:meeting-mute` 时校验 `sender.tab?.url?.startsWith('https://meet.google.com/')`，否则忽略（静态检查）。

#### 跟随会议静音

- [ ] AC-130: `parseMeetMuteState({ buttons: [{ dataIsMuted: 'true', text: 'mic_off' }, { dataIsMuted: 'false', text: 'videocam' }] }) === true`；`[{ dataIsMuted: 'false', text: 'mic' }]` → `false`；无含 `mic`/`mic_off` 的按钮或列表为空 → `null`；`resolveMeetingMuted([])` → `null`，`resolveMeetingMuted([{ tabId: 1, muted: false, at: 1 }, { tabId: 2, muted: true, at: 2 }])` → `true`（取最近上报），移除 tab 2 后 → `false`。
- [ ] AC-131: Given `phase = on`、`meetingMuted !== true`，when SW 收到来自 Meet 标签的 `li:meeting-mute { muted: true }`，then 500 ms 内 `runtime.meetingMuted === true`、badge 琥珀 `●`、弹窗说明「会议已静音 · 暂停翻译你的话。对方说的仍会翻成中文进你的耳机。」；离屏收到 `li:set-uplink-paused { paused: true }` 后上行 `session.sendAudio` 与上行 `player.enqueue` 都不再被调用（`forwardMicAudio` 门控；passthrough 同样停送），上行 `player.flush()` 已调用，`holdFloorFull(true)` 使上行直通增益 50 ms 内回 1.0 且不再压低，暂停期间到达的上行 `audio-frame` 被丢弃；下行 capture/session/player 引用不变、译文帧继续 enqueue、衬底照常；手测：在 Meet 点静音后 QuickTime 录 BlackHole 16ch 0.5 s 内译文消失、我的原声连续；耳机里对方翻译持续。
- [ ] AC-132: Given `meetingMuted === true` 且上行暂停，when 收到 `li:meeting-mute { muted: false }`，then `holdFloorFull(false)`，上行 `session.getState() === 'running'` 时立即恢复送音（`restarted` 为 `[]`）；上行为 `suspended` 时离屏重建上行（`restarted` 深等于 `['uplink']`，期间弹窗小字「正在恢复翻译…」），完成后 `uplink.status === 'running'`；重建失败 → 按 AC-105 翻译层 `failed`，桥保持；Given `meetingMuted === null`（无 Meet 页 / 探测失败 / 其它平台），then 不暂停且弹窗说明末尾含「未感知到会议静音（仅支持 Google Meet）」；Given `phase = off` 时收到静音变化，then 只更新 `meetingMuted`，不发任何离屏消息；开启时 `li:start` 的 `uplinkPaused` 等于 `meetingMuted === true`，就绪通知按 AC-143 的静音文案生成。
- [ ] AC-133: `createPlayer()` 返回对象恰含 `enqueue`、`flush`、`attachFloor`、`setFloorLevel`、`holdFloorFull`、`stop`；`flush()` 停止所有已调度的 `AudioBufferSourceNode`（静态检查：维护 source 集合、逐个 `.stop()`、清空、`playhead` 归零）并按 `floorTarget` 立即更新直通增益；`stop()` 同时停止直通 track 并保持现有 `player-static.test.mjs` 断言的形状；`forwardMicAudio` 语义不变（现有 AC-015 用例保留部分通过）；离屏在上行暂停时收到 `closed` 不上报 `closed` 而上报 `uplink-suspended`，并把 `live.uplink.session` 置空以便重建。

#### UI 表面

- [ ] AC-126: 【文案清单已由 AC-149 更新】`popup.html` 与 `sidepanel.html` 都只加载 `panel.js`（`type="module"`）与 `panel.css`，无内联 `<script>`；`panel.js` 或其模板包含字符串：会议同传、Live Interpreter、未连接会议音频、无法连接会议音频、同传已关闭、原声直通中、同传进行中、无法开启同传、原声仍在直通、会议已静音、暂停翻译你的话、未感知到会议静音、正在恢复翻译…、正在连接会议音频…、正在启动本地翻译服务…、正在连接翻译服务…、你想听的语言、对方听的语言、开启同传、关闭同传、断开会议音频、正在开启…、正在关闭…、脚注全文；不含「你说的语言」、「只连接原声」、「重试」、「静音」按钮、「恢复翻译」按钮；两个下拉各渲染 13 项加「原声（不翻译）」共 14 项。
- [ ] AC-127: 【已关闭 / 桥失败 / 翻译失败 / 开启中的文案已由 AC-149 更新】`statusCopy` 纯函数：`bridge = disconnected` → title「同传已关闭」、body 含「未连接会议音频」、primary「开启同传」、无 secondary；`bridge = failed` → title「无法连接会议音频」、tone `danger`、body 为 `bridgeError.message` + 「会议现在听不到你，你也听不到会议。」、primary「开启同传」；`connected` + `phase = off` → title「同传已关闭」、body 含「原声直通中」、primary「开启同传」；`starting` → primary「正在开启…」且 `stepText` 按 `startStep` 为三段文案之一；`on` 未暂停（zh / en，两方向 translate）→ body「对方说的会翻成中文进你的耳机，你说的话会翻成 English 送进会议。翻译播放时原声会压低。」；downlink passthrough → 「对方的原声会直接进你的耳机」；uplink passthrough → 「你的原声会直接送进会议」；`on` 且 `meetingMuted === true` → body「会议已静音 · 暂停翻译你的话。对方说的仍会翻成中文进你的耳机。」、tone `warning`；`on` 且 `meetingMuted === null` → `note`「未感知到会议静音（仅支持 Google Meet）」；`phase = error`（桥正常）→ title「无法开启同传」、tone `danger`、body 为 `error.message` + 「原声仍在直通。」；`stopping` → primary「正在关闭…」。
- [ ] AC-128: 弹窗 380×600（`body[data-surface=popup]` 固定尺寸），侧栏 `body[data-surface=side]` 宽 100%、最小高 100vh；下拉菜单最大高度约 280 px 内滚动；深色默认，`prefers-color-scheme: light` 用浅色 token；错误态 danger 色；进行中脉冲绿点；开启中按钮内转圈动画与步骤文案；暂停态琥珀说明；「断开会议音频」为底部低调链接。（截图手测）
- [ ] AC-129: 选项页加载即 `enumerateAudioDevices()`（触发授权提示）；四个 `<select>` 首项「（默认分配）」并按 kind 过滤；改动即写 `settings.deviceOverrides` 并实时显示 `preflight` 结论；「同传时原声衬底」三选一写 `settings.floorLevel`；「检测本地服务」按钮 `connectNative` 后显示 `ready` 的 backend/port 或 `classifyNativeError` 的原因 + 安装命令，并立即断开端口；页面含静音感知说明（仅 Google Meet）、同语言限制与「建议耳机」提示；不含自动连接开关。
- [ ] AC-145: 通知发送纪律：`background.js` 只在 `started`、`failed`、`bridgeFailed` 三处调用 `chrome.notifications.create`，id 分别为 `li-ready`、`li-failed`、`li-failed`，message 只来自 `readyCopy`/`failureCopy`（静态检查）；手测：弹窗关闭时开启同传，就绪后 macOS 出现「同传已就绪」通知且正文与面板说明一致；卸载宿主后开启，出现「无法开启同传」通知。

#### 关闭即释放与开启可取消（2026-09-10 变更）

- [ ] AC-146: Given `phase = starting`，不论卡在连接会议音频、启动本地翻译服务还是连接翻译服务，when `li:power {on:false}`，then SW 不等任何超时立即回复 `{ ok: true }`，`runtime` 经 `stopping` 回到 `createInitialRuntime()`；离屏收到 `li:disconnect` 且文档已关闭；已发出但还没 `ready` 的宿主端口也被断开并收到 `{ type: 'shutdown' }`；不发任何通知；之后迟到的 `li:connect` 应答、`ready` 帧或 `li:start` 应答都不改变状态、不发「同传已就绪」；紧接着 `li:power {on:true}` 能正常开启。面板在开启中显示可点的「取消开启」（outline 样式、带转圈），步骤文案照常，两个下拉锁定；`statusCopy` 在 `phase = starting` 时返回 `action: 'cancel'`，在 `phase = stopping` 时返回 `action: null`。
- [ ] AC-147: Given `phase = on`，when `li:power {on:false}`，then `runtime` 经 `stopping` 回到初始（`bridge = disconnected`、`phase = off`，只保留 `meetingMuted`）；宿主端口断开且收到 shutdown；离屏收到 `li:disconnect` 后文档关闭；角标为空；不发通知；关文档必然掉的 keepalive 端口不被误判成桥丢失。手测：点「关闭同传」后 2 s 内 macOS 橙色麦克风指示消失，`pgrep -f native-host.mjs` 为空。
- [ ] AC-148: 任一翻译层失败（宿主不可用、凭证、WS、网络、改语言重建、SW 恢复时发现半启动）后 `runtime` 为 `phase = error`、`bridge = disconnected`；任一桥失败（预检、授权、`bridge-lost`、离屏文档丢失）后为 `bridge = failed`、`phase = error`；两者都已撤宿主、发 `li:disconnect` 并关闭离屏文档，各发一条 `li-failed` 通知，正文等于 `error.message`；之后的 `devicechange` 不触发任何离屏动作，迟到的 `bridge-lost` 不再发通知。
- [ ] AC-149: 面板与 `statusCopy` 不再出现「断开会议音频」「原声直通中」「原声仍在直通」「正在开启…」「未连接会议音频」；`statusCopy` 不再返回 `secondary`；已关闭时 body 为「开启后，对方说的话会翻成你要听的语言进你的耳机，你说的话会翻译后送进会议。关闭时插件不占用麦克风，也不转送会议声音。」；桥已连但未开启的状态（不应出现）按已关闭渲染；`badgeFor` 在未开启时一律返回 `{ text: '' }`；两个 HTML 模板里没有 `id="disconnect"`。
- [ ] AC-150: `background.js` 的 UI 处理器只剩 `li:power` 与 `li:set-settings`；`stop()`、`cancelStart()`、`failTranslation()`、`failBridge()` 都经 `releaseAll()`，后者撤宿主、发 `li:disconnect`、关闭离屏文档，并在关文档窗口内落终态；`start()` 与建桥里的每个 `withTimeout` 都带取消令牌，副作用前都有 `checkpoint(run)`；被取消的开启不走失败流程；没有 `devicechange` 自动重连。

## Implementation Notes

| Area | Files | Notes |
| --- | --- | --- |
| 语言与方向 | `src/shared/languages.mjs`、`direction-plan.mjs`、`directions.mjs` | `directions.mjs` 改为 `export const DIRECTIONS = buildDirections(DEFAULT_SETTINGS)`；`direction-plan.mjs` 不得反向 import `directions.mjs` |
| 衬底 | `src/shared/floor.mjs`、`src/extension/audio.js` | `createPlayer` 内：`floorGain = ctx.createGain()`；`attachFloor(stream)`：`ctx.createMediaStreamSource(stream).connect(floorGain).connect(ctx.destination)`，记录 tracks；`enqueue` → `scheduleFloor()`；`scheduleFloor()`：`target = floorTarget({ translating: isTranslating({ now: ctx.currentTime, playhead, releaseMs }), holdFull, level })`，`gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now); gain.linearRampToValueAtTime(target, now + (target < gain.value ? ATTACK : RECOVER) / 1000)`；`setTimeout(playhead + release - now)` 在队列播完后再调一次；`flush()` 清源、`playhead = 0`、`scheduleFloor()` |
| 直通约束 | `src/shared/audio-routing.mjs` | `buildFloorConstraints(deviceId, inputRole)`；`capture` 复用三项全关；`mic` 开 AEC/NS、关 AGC |
| Meet 静音 | `src/shared/meeting-mute.mjs`、`src/extension/meet-mute.js` | 纯函数：找 `text` 匹配 `/\bmic(_off)?\b/` 的按钮，`dataIsMuted === 'true'` → true，`'false'` → false，否则 null；脚本：`MutationObserver(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-is-muted'], childList: true })` + 1 s 定时兜底，节流 200 ms，只在值变化时发送；`pagehide` 发 null |
| 通知 | `src/shared/runtime-state.mjs`（`readyCopy`/`failureCopy`）、`background.js` | `chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 })`；同 id 覆盖 |
| 端点 | `src/shared/session-endpoint.mjs`、`src/extension/session.js` | `fetch(endpoint.url ?? endpoint.path, { headers: { 'Content-Type': 'application/json', ...(endpoint.headers ?? {}) } })`；`directionTable` 透传 |
| 协议帧 | `src/shared/native-protocol.mjs` | 纯 `Uint8Array`/`DataView` |
| 运行态 | `src/shared/runtime-state.mjs` | 全部纯函数；`createInitialRuntime()`；`statusCopy`、`badgeFor`、`readyCopy`、`failureCopy`、`stripSecrets` 同文件 |
| 错误 | `src/shared/errors.mjs`、`native-errors.mjs` | `host_unavailable` 文案：「本地翻译服务不可用：请在项目目录运行 npm run install:host 完成安装后重试（升级 Node 后需重新运行）。」 |
| 宿主 | `src/server/native-host.mjs` | 复用 `createServer` 与 `startMockRealtime`；`launchToken = base64url(randomBytes(32))`；`console.log = console.error`；stdin `createFrameDecoder`；`end`/`shutdown`/`SIGTERM` 同一 `closeAll()`；`LI_HOST_LOG` 指定日志（默认 `dist/native-host/host.log`） |
| 服务端 | `src/server/index.mjs` | 只剩 `createServer`：`POST /api/session-token`（先查 `launchToken`，再 backend/apiKey）；其它 404 `{ message: '资源不存在' }`；不 import `node:fs`/`node:path`/`node:url`，不读 `process.env` |
| SW | `src/extension/background.js` | 模块级 `nativePort`、`state`、`muteReports`、`retriedForDeviceChange`；`dispatch(next)`：同引用返回 false，否则写 `storage.session`（`server` 经 `stripSecrets`）+ badge；`connect()`：connectRequested → ensureOffscreen（`getContexts` 判重，`reasons: ['USER_MEDIA']`）→ `li:connect`(10 s) → bridgeConnected / bridgeFailed(+通知)；`start()`：requestStart → 若 bridge 未连接先 `connect()`（失败即止）→ connectHost(10 s) → hostReady → `li:start { uplinkPaused: meetingMuted === true }`(15 s) → started + `li-ready` 通知；异常 → 撤翻译层（`li:stop` 尽力、port.disconnect）→ failed + `li-failed` 通知；`stop()`：requestStop → `li:stop` → port.disconnect → stopped；`disconnect()`：若 on 先 `stop()` → `li:disconnect` → closeDocument → disconnected；`connect()` 只由 `start()` 与 `devicechange` 重试调用，不响应任何 UI 消息；`onStartup`/`onInstalled`：写 `normalizeSettings(存量)`、`sidePanel.setPanelBehavior({ openPanelOnActionClick: false })`、按 `planRecovery` 分派（无任何占用动作）；`li:meeting-mute`：校验 sender → 记录 → `meetingMute(state, resolveMeetingMuted(reports))` → 若 phase on 且值变化 → `li:set-uplink-paused` → 按响应 `uplinkResumed`；`tabs.onRemoved` 清记录并重算；`bridge-lost` → 撤宿主 → bridgeFailed + 通知；`devicechange` 且 bridge failed(device_missing) 且未重试 → `connect()` |
| 离屏 | `src/extension/offscreen.js` | `bridge = { roles, dirs: { [id]: { player, floorStream } } }`、`live = { [id]: { session, capture } | null }`、`uplinkPaused`；`li:connect`：enumerate → preflight → 逐方向 `getUserMedia(buildFloorConstraints)` + `createPlayer(sinkId, { floorLevel })` + `attachFloor`，失败逆序收尾；注册 `ondevicechange` 上报；`li:start`：读 `uplinkPaused`，translate 方向 `openTranslationSession({ directionTable: plan, audioSink: id === 'uplink' ? (b) => { if (!uplinkPaused) player.enqueue(b) } : player.enqueue })`，等每个会话 `open` 后 `startCapture(inputId, chunk => id === 'uplink' ? forwardMicAudio({ muted: uplinkPaused, chunk, sink: session.sendAudio }) : session.sendAudio(chunk))`，全部完成才回复 ok；上行若 `uplinkPaused` 则 `holdFloorFull(true)`；passthrough 方向不做任何事；`li:stop`：close/stop + 每个 player `flush()`；`li:set-uplink-paused`：置位 → 上行 `flush()` + `holdFloorFull(paused)` → 取消暂停且 `live.uplink === null` 时重建；上行 `closed` 且 `uplinkPaused` → 置空并上报 `uplink-suspended`；player `onPlaybackError` 不可恢复或直通 track `ended` → 上报 `bridge-lost`；`li:disconnect`：撤翻译层 → 每个 player `stop()` |
| 面板 | `popup.html`、`sidepanel.html`、`panel.js`、`panel.css` | 状态块 → `statusCopy`；开启中按钮内 spinner + `stepText`；暂停态琥珀说明与 `note`；底部「断开会议音频」链接（已连接时）；头部「设置」「停靠」图标（设计稿没有，明示偏离）；14 项可滚动下拉 |
| 选项页 | `options.html`、`options.js` | 四张设备卡（照 `_v1/Setup.dc.html`）、授权、衬底三选一、检测本地服务、静音感知/限制/耳机提示 |
| 工具 | `tools/*` | 零依赖；`install` 支持 `--home`、`--browser`、`--extension-id`、`--out`；ID 推导 = sha256(SPKI DER) 前 16 字节 → hex 位映射 a–p |
| 文档 | `README.md` | 「浏览器插件」：`npm run build:ext` → 加载 `dist/extension`（说明安装提示里「可读取 meet.google.com 数据」只用于读静音态）→ `npm run install:host` → 选项页授权与设备 → 会议中点图标「开启同传」等就绪通知；「原声直通与关闭」；「Meet 静音」；「语言能力与限制」；「建议耳机」 |

不得改动：`session-protocol.mjs` 事件与 idle-commit；`device-preflight.mjs` 规则；`audio.js` 的看门狗与采样率处理（只新增直通/衬底/flush）；`mock-realtime.mjs`；`tools/e2e-real.mjs`。

## Edge Cases

| Case | Expected Behavior |
| --- | --- |
| 浏览器启动 | 无任何动作：不占麦克风、无离屏文档、无宿主 |
| 开启时耳机未接 / 未授权 | 第一步 `bridge = failed`（device_missing / permission_denied）+ 通知，撤掉一切；弹窗「开启同传」/「音频设置」/「去授权麦克风」；插上耳机后需要再点一次开启 |
| 宿主 manifest 未安装 / ID 不符 | 第二步失败：翻译层 `host_unavailable` + 通知，撤掉一切 |
| wrapper 的 node 路径失效 | 宿主启动即退出 → `host_unavailable`，提示重跑安装并看 `host.log` |
| `.env` 缺 key 且 real | 宿主 `ready`；第三步 token 500 `config_missing` → 翻译层 failed + 通知，撤掉一切 |
| 一方向 `open` 成功、另一方向失败 | 不发就绪通知；整体翻译层 failed，已开的会话关闭 |
| 翻译中 WS 断开 | 翻译层 failed + 通知，撤掉一切（插件不再转送声音） |
| 开启途中用户点「取消开启」 | 作废在途的建桥、宿主与会话，回到初始，不通知；迟到的应答一律不算数 |
| 开启时 Meet 已静音 | 上行会话照建但立即门控；就绪通知写明已静音 |
| Meet 静音期间上行会话被对端关闭 | `uplink-suspended`，取消静音时重建 |
| Meet 静音期间收到上行译文帧 | 丢弃 |
| Meet 静音时切「对方听的语言」 | 上行按新计划重建，仍暂停 |
| 取消静音时重建失败 | 翻译层 failed + 通知，撤掉一切 |
| Meet 页面刷新 / 进入会议前的等候页 | 脚本重新加载后上报当前态；找不到按钮上报 null → 不暂停 |
| 多个 Meet 标签 | 取最近上报；关闭的标签记录移除 |
| Meet 改版找不到按钮 | 上报 null → 不暂停；弹窗显示「未感知到会议静音」 |
| 非 Meet 平台（Zoom / Teams 网页或桌面） | `meetingMuted === null` → 不暂停，明示 |
| 我说的已是「对方听的语言」 | 模型不出声 → 衬底停顿规则使对方听到我的原声 100% |
| 对方说的已是「你想听的语言」 | 同上，我听到原声 100% |
| 每句开头 1–2 s | 译文未到，原声 100%；译文开始后压低（上游延迟，明示） |
| `floorLevel = 0` | 译文播放时原声 0；停顿 0.7 s 后仍恢复 1.0 |
| 两方向都选「原声」 | 开启同传不建任何会话、不请求 token，但宿主仍被拉起（开/关语义一致） |
| 用户用扬声器外放 | 真麦克风直通开 AEC/NS；仍建议耳机 |
| 直通 track 被系统结束 | `bridge-lost` → 桥失败 + 通知，撤掉一切；插回设备不自动重连 |
| 离屏文档被 Chrome 关闭 | keepalive 断开 → `fail-bridge`（宿主退出）+ 通知 |
| SW 被终止后再唤醒 | `planRecovery`：桥在且翻译 on → 重连宿主并 `li:server-changed`；离屏不在 → fail-bridge；中间态 → fail-translation；其它 none |
| 用户在开启中连点 | busy，UI 已禁用 |
| 语言在 on 态频繁切换 | 只重启 `diffPlan` 列出的方向 |
| 两个会议标签 | 桥与标签无关，只有一套；侧栏按标签打开 |
| 浏览器重启 | `storage.session` 清空 → 初始；不连接 |
| Chrome < 116 | `minimum_chrome_version` 阻止加载 |

## Verification Plan

- 单元测试（纯逻辑）：`tests/unit/languages.test.mjs`（AC-135）、`direction-plan.test.mjs`（AC-107, AC-108）、`floor.test.mjs`（AC-137 纯函数）、`meeting-mute.test.mjs`（AC-130）、`native-protocol.test.mjs`（AC-111）、`runtime-state.test.mjs`（AC-120, AC-121, AC-122, AC-125 `stripSecrets`, AC-127, AC-142 的 `startStep` 转换, AC-143 的 `readyCopy`, AC-138/141 的 `failureCopy`）、`native-errors.test.mjs`、`pure-functions.test.mjs` 追加（AC-124）、`routing-state.test.mjs` 追加 `buildFloorConstraints`（AC-136）、`extension-id.test.mjs`（AC-117 前半）。
- 静态测试：`tests/unit/extension-static.test.mjs`（AC-106, AC-115, AC-119, AC-121/122 静态部分, AC-123 无重连, AC-125, AC-126, AC-131/132 门控与 flush/holdFloorFull 调用, AC-133 suspended 上报, AC-134, AC-135 无字面量, AC-139 无占用动作, AC-142 无 `startStep =`, AC-144 只读脚本, AC-145 通知纪律）；`player-static.test.mjs` 追加（AC-133, AC-137 静态部分）。
- 集成测试：`native-host.test.mjs`（AC-112, AC-113）、`token-endpoint.test.mjs` 追加（AC-114）、`server-routes.test.mjs`（AC-134）、`build-extension.test.mjs`（AC-116）、`install-native-host.test.mjs`（AC-117 后半）、`repo-hygiene` 追加（AC-118）。
- 遗留测试：按 Compatibility 清单处理；`npm test` 保留用例全绿。
- 手测（mock 后端，零 API 成本；对应 AC-101～AC-105, AC-109, AC-110, AC-128～AC-129, AC-131～AC-132, AC-136～AC-143, AC-145）：
  1. `npm run build:ext` → `chrome://extensions` 加载 `dist/extension`（记录安装提示文字）；`npm run install:host`。
  2. 右键图标 →「选项」→ 授权麦克风、确认「设备已就绪」、衬底 25%、点「检测本地服务」显示 mock。
  3. 重启 Chrome → 无橙色麦克风指示、无角标；弹窗「同传已关闭 · 未连接会议音频」（AC-139）。
  4. 进入一个 Meet 会议（可自己开会）→ 点图标 → 「开启同传」→ 按钮转圈，依次看到三段步骤文案；就绪后「同传进行中」、绿点、macOS 通知「同传已就绪」正文与面板一致（AC-142, AC-143, AC-145）。QuickTime 回放 `fixtures/sample-en.wav` 灌入 BlackHole 2ch：耳机原声 + 提示音叠加，提示音播放时原声变小、停顿后恢复（AC-137）。
  5. 在 Meet 点静音 → 0.5 s 内面板「会议已静音 · 暂停翻译你的话」、角标琥珀；QuickTime 录 BlackHole 16ch：提示音消失、我的原声连续；耳机对方提示音继续；取消静音 → 提示音回来（AC-131, AC-132）。
  6. 关闭弹窗、等 60 s、重开 → 仍进行中；`pgrep -f native-host.mjs` 有一条（AC-103）。
  7. 改「你想听的语言」为 日本語 → 仅下行重启；改「对方听的语言」为「原声」→ 16ch 只录到原声；改回（AC-109, AC-110）。
  8. 「关闭同传」→ 2 s 内 `pgrep` 为空、角标消失、macOS 橙色麦克风指示消失（AC-147）；再「开启同传」→ 三步冷启动重新走一遍（AC-142）。
  8a. 「开启同传」后在三段步骤任一处点「取消开启」→ 立即回到「同传已关闭」，无通知，橙色指示消失（AC-146）。
  9. 删除宿主 manifest 后「开启同传」→ 面板「无法开启同传」+ 安装命令，通知同文，橙色指示消失（AC-105, AC-148）；重装后可开启。
  10. 选项页把 monitor 选成 BlackHole →「开启同传」→ 第一步失败「无法连接会议音频」+ 预检原文 + 通知（AC-148）；改回后再开启成功。
  11. 同传进行中拔耳机 → 桥失败 + 通知，撤掉一切；插回后需再点「开启同传」（AC-148）。
  12. （已取消：不再有「断开会议音频」入口，见 AC-149。）
  13. 在 Zoom 网页会议中开启 → 面板「未感知到会议静音（仅支持 Google Meet）」，Zoom 静音不影响翻译（AC-132）。
  14. 「停靠到侧栏」→ 内容一致、可开关（AC-128）。
- 真实后端手测：`.env` 设 `TRANSLATE_BACKEND=real` 后重复 4～8：耳机听到中文译文叠在压低的英语原声上；对麦克风说中文，16ch 录到英语译文叠在压低的中文原声上；Meet 静音后只剩原声；说一句英语确认原声 100% 无译文。`npm run e2e:real` 仍可独立通过。
- 上游验证（开发前）：13 个语言码逐一 `session.update` 无 `error`；Meet DOM `data-is-muted` 与 `mic`/`mic_off` 确认；直通延迟与外放回声实测；结果写进请求日志。

```bash
npm test
npm run build:ext
npm run install:host
node --test tests/integration/native-host.test.mjs
npm run e2e:real
```

## Open Questions

2026-09-10 审批已决：接受 Meet 只读探测脚本；不保留「只连接原声」入口；失败也弹系统通知；头部「设置」「停靠」图标、底部「断开会议音频」链接、下拉 14 项滚动均采纳。剩余仅实现期确认项：

| Question | Default Decision | Impact |
| --- | --- | --- |
| 中文输出语言码 | `zh`；若上游区分简繁再加选项 | 影响 `OUTPUT_LANGUAGES` |
| 宿主日志位置 | `dist/native-host/host.log`，`LI_HOST_LOG` 可覆盖 | 无 |
| Edge 支持 | 只验证 Chrome；安装脚本支持 `--browser edge` | 无代码差异 |
