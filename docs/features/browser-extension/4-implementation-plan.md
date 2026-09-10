# Implementation Plan: 会议同传浏览器插件

## Summary

自底向上、每块可独立验证：先把新判定逻辑落成 `src/shared` 纯函数并单测（语言目录、方向计划、衬底目标增益、Meet 静音态解析、协议帧、桥 + 翻译层运行态与通知文案）；然后移除网页版并按清单处理遗留测试，同时给播放器加直通/衬底/flush、给服务端加宿主协议与启动令牌；再是零依赖工具链；然后写扩展的 SW 与离屏文档（冷启动步骤、就绪判定与通知、桥常驻、翻译叠加、Meet 静音暂停、挂起/重建、设备变化重试）与只读探测脚本，用 mock 后端手测；最后是面板与选项页、README、真实后端实机验证。契约与 AC 以 `./2-tech-spec.md` 为准。

## Source Of Truth

- Requirements: `./1-requirements.md`
- Tech spec: `./2-tech-spec.md`
- Feasibility study: `./0-feasibility-study.md`

本计划与 `2-tech-spec.md` 冲突时，先改 spec 或明确指出差异，再写代码。

## Preconditions

| Item | Status | Notes |
| --- | --- | --- |
| Product decisions finalized | yes | 2026-09-10 审批：接受 Meet 只读探测脚本；不保留「只连接原声」入口；失败也弹通知；头部图标、断开链接、下拉滚动均采纳 |
| API/data contract stable | yes（待审批） | 消息、宿主协议、storage、两层状态机、音频图、通知、探测脚本契约均在 spec 中定稿 |
| Test fixtures available | yes | `fixtures/sample-en.wav`；mock 后端提示音 |
| External dependency verified | partial | Chrome 与 OpenAI 文档已核对；Chunk 4 前完成：离屏 AudioContext 混音 spike、授权后免提示 spike、Dock 启动拉起宿主 spike（记录冷启动耗时）、Meet DOM 确认、`chrome.notifications` 显示确认、直通延迟/回声实测、13 个语言码实测 |

## Change Map

| Area | Files | Change Type | Notes |
| --- | --- | --- | --- |
| Shared 纯逻辑 | `src/shared/languages.mjs`、`direction-plan.mjs`、`floor.mjs`、`meeting-mute.mjs`、`native-protocol.mjs`、`runtime-state.mjs`、`native-errors.mjs` | add | 全部可被 Node 直接 import |
| Shared 纯逻辑 | `src/shared/directions.mjs`、`audio-routing.mjs`、`session-endpoint.mjs`、`session-protocol.mjs`、`errors.mjs` | modify | `DIRECTIONS = buildDirections(DEFAULT_SETTINGS)`；`buildFloorConstraints`；可选参数/字段 |
| Shared 纯逻辑 | `src/shared/session-state.mjs` | delete | 由 `runtime-state.mjs` 取代 |
| 网页版 | `src/web/index.html`、`src/web/app.js` | delete | 入口移除 |
| 浏览器接线 | `src/web/audio.js` → `src/extension/audio.js`、`src/web/session.js` → `src/extension/session.js` | move/modify | 直通/衬底/flush；端点 url/headers；`directionTable` |
| 服务端 | `src/server/index.mjs` | modify | 删静态/`/api/config`/CLI；加 `launchToken` |
| 服务端 | `src/server/native-host.mjs` | add | 宿主入口 |
| 扩展 | `src/extension/manifest.json`、`background.js`、`offscreen.html`、`offscreen.js`、`meet-mute.js`、`popup.html`、`sidepanel.html`、`panel.js`、`panel.css`、`options.html`、`options.js`、`icons/*.png` | add | 零打包器 |
| 工具 | `tools/build-extension.mjs`、`install-native-host.mjs`、`extension-id.mjs`、`gen-ext-key.mjs`、`gen-icons.mjs` | add | 零依赖 |
| 配置 | `package.json`、`.gitignore` | modify | 删 `start`/`start:real`，加 `build:ext`/`install:host`/`gen:icons`；`dist` |
| 测试（新增） | `tests/unit/{languages,direction-plan,floor,meeting-mute,native-protocol,runtime-state,native-errors,extension-id,extension-static}.test.mjs`、`tests/integration/{native-host,server-routes,build-extension,install-native-host}.test.mjs` | add | 见 Testing Plan |
| 测试（遗留） | `subtitle-panel-static`（删）、`player-static`、`audio-permission-probe-static`、`routing-state`、`mock-pipeline`、`subtitle-isolation` | delete/modify | 严格按 spec Compatibility 清单 |
| 文档 | `README.md`、`docs/features/browser-extension/requests/*.md` | modify/add | 安装（含权限提示说明）、开启与就绪通知、原声直通与关闭、Meet 静音、语言能力与限制、耳机建议；开发记录 |

## Execution Chunks

### Chunk 1: Shared 纯逻辑与兼容扩展

Goal: 所有新判定逻辑以纯函数落地并被单测钉住；除清单所列外现有测试不动。

Files:

- `src/shared/languages.mjs`、`direction-plan.mjs`、`floor.mjs`、`meeting-mute.mjs`、`native-protocol.mjs`、`native-errors.mjs`、`runtime-state.mjs` - 新增
- `src/shared/directions.mjs`、`audio-routing.mjs`、`session-endpoint.mjs`、`session-protocol.mjs`、`errors.mjs` - 修改
- `tests/unit/routing-state.test.mjs` - `source` 改 `'auto'`、加 `mode`、加 `buildFloorConstraints`（遗留清单项）

Steps:

- [ ] `languages` + 测试（AC-135）；`direction-plan` + 测试（AC-107, AC-108），断言 `buildDirections(DEFAULT_SETTINGS)` deepEqual `DIRECTIONS`
- [ ] `floor.mjs` + 测试（AC-137 纯函数部分）；`meeting-mute.mjs` + 测试（AC-130）
- [ ] `buildFloorConstraints` + 测试；`selectSessionEndpoint` 第二参 + `pure-functions` 追加（AC-124）；`createSession` 透传 `directionTable`
- [ ] `native-protocol` + 测试（AC-111）
- [ ] `runtime-state`（桥 + 翻译层、`startStep`、`meetingMuted`、`badgeFor`、`planRecovery`、`statusCopy`、`readyCopy`、`failureCopy`、`stripSecrets`）+ 测试（AC-120, AC-121, AC-122, AC-125, AC-127, AC-142, AC-143, AC-138/141 文案）
- [ ] `errors` 新分类 + `native-errors` 测试

Verification:

- [ ] `npm test` 全绿；`shared-purity` 覆盖新增模块

Rollback / Safety:

- 全部为新增文件或可选参数；删除新增文件即可回退

### Chunk 2: 移除网页版、迁移接线、播放器混音、精简服务端、宿主与令牌

Goal: 仓库里不再有网页版；`audio.js`/`session.js` 迁入 `src/extension/` 且播放器具备直通/衬底/flush；`createServer` 只剩令牌端点；宿主可按协议冷启动与退出。

Files:

- 删除：`src/web/index.html`、`src/web/app.js`、`src/shared/session-state.mjs`、`tests/unit/subtitle-panel-static.test.mjs`
- 迁移：`src/web/audio.js` → `src/extension/audio.js`（`attachFloor`/`setFloorLevel`/`holdFloorFull`/`flush`）；`src/web/session.js` → `src/extension/session.js`
- `src/server/index.mjs`、`src/server/native-host.mjs`、`package.json`
- 遗留测试：`player-static`、`audio-permission-probe-static`（路径）；`routing-state`（删 session-state 段）；`mock-pipeline`（删 `/api/config` 守卫段）；`subtitle-isolation`（注释）
- 新增：`tests/integration/native-host.test.mjs`（AC-112, AC-113）、`server-routes.test.mjs`（AC-134）、`token-endpoint` 追加 AC-114、`player-static` 追加（AC-133, AC-137 静态部分）

Steps:

- [ ] 先迁移再删除；迁移后 `player-static`/`audio-permission-probe-static` 原断言通过
- [ ] 播放器：`floorGain` + `attachFloor` + `scheduleFloor` + `flush` + `holdFloorFull` + `setFloorLevel`；`stop()` 同时停 track，保持现有形状
- [ ] 服务端精简；令牌检查在 backend/apiKey 之前
- [ ] 宿主：`console.log = console.error`；`randomBytes(32)` → base64url；绑 `127.0.0.1:0`；stdin 解帧；`end`/`shutdown`/`SIGTERM` 同一 `closeAll()`；记录启动到 `ready` 耗时到 stderr
- [ ] 本地 `.claude/launch.json`（未跟踪）引用了 `start:real`，开发时删除或改掉

Verification:

- [ ] `npm test`；`ls src/web` 报不存在；`npm run e2e:real` 仍可跑（有 key 时）

Rollback / Safety:

- 删除与迁移在同一提交，`git revert` 一次回退；遗留测试改动逐项对照 spec 清单

### Chunk 3: 工具链（构建、安装、ID、图标）

Goal: `npm run build:ext` 产出可加载目录；`npm run install:host` 幂等；manifest 有固定 `key`、`notifications` 权限与 Meet 只读探测脚本声明。

Files:

- `src/extension/manifest.json` 骨架（含 `key` 占位、`content_scripts`、`notifications`）
- `tools/extension-id.mjs` + `tests/unit/extension-id.test.mjs`（AC-117 前半）
- `tools/gen-ext-key.mjs`
- `tools/build-extension.mjs` + `tests/integration/build-extension.test.mjs`（AC-116）
- `tools/install-native-host.mjs` + `tests/integration/install-native-host.test.mjs`（AC-117 后半）
- `tools/gen-icons.mjs` → `src/extension/icons/*.png`
- `package.json`、`.gitignore`；`repo-hygiene` 追加 AC-118

Steps:

- [ ] 构建脚本：清空 `--out` 后拷贝 `src/extension/**` 与 `src/shared/*.mjs` → `shared/`；写入 `version`
- [ ] 安装脚本：`process.execPath` 与仓库根写进 wrapper；`chmod 755`；JSON 稳定排序
- [ ] 图标：均衡器符号，4 尺寸

Verification:

- [ ] `npm test`；`npm run build:ext && ls dist/extension`；`npm run install:host`

Rollback / Safety:

- 只生成 gitignore 内文件与用户目录下一个 manifest；卸载 = 删除该 manifest

### Chunk 4: 扩展骨架（SW + 离屏 + 探测脚本）：冷启动、桥、翻译叠加、Meet 静音，mock 端到端

Goal: 无 UI 也能通过 `chrome.runtime.sendMessage` 开启（分步）/关闭/断开；就绪与失败弹通知；浏览器重启后无任何占用；Meet 静音自动暂停上行；mock 提示音叠在压低的原声上。

Files:

- `src/extension/background.js` - 四条流程、`startStep` 分派、通知、恢复、Meet 静音接收与暂停转发、设备变化重试、badge、`stripSecrets`
- `src/extension/offscreen.html`、`offscreen.js` - 直通 + 播放器、翻译层（等 `open` 再回复）、`forwardMicAudio` 门控、`holdFloorFull`、挂起/重建、`bridge-lost`/`devicechange` 上报
- `src/extension/meet-mute.js` - 只读探测
- `tests/unit/extension-static.test.mjs` - AC-106（部分）, AC-115, AC-119, AC-121/122 静态, AC-123, AC-125, AC-131/132, AC-133, AC-134, AC-135, AC-139, AC-142, AC-144, AC-145

Steps:

- [ ] 先做 feasibility Validation Plan 的 spike 与实测（含 Meet DOM、通知显示），任一失败即停下回到 spec 复议
- [ ] SW：`dispatch`；`connect()`/`start()`/`stop()`/`disconnect()`；`hostReady` 与 `started` 时机；`li-ready`/`li-failed` 通知；`planRecovery` 顶层分派（无占用动作）；`li:meeting-mute` 校验与 `resolveMeetingMuted`；`tabs.onRemoved`；`bridge-lost`/`devicechange`
- [ ] 离屏：`li:connect` 建桥；`li:start` 叠翻译并等 `open`；`li:stop` 撤翻译并 `flush`；`li:set-uplink-paused`；`li:set-floor`；`li:disconnect` 全撤
- [ ] 探测脚本：`MutationObserver` + 1 s 兜底 + 200 ms 节流 + 只在变化时发送 + `pagehide` 发 null
- [ ] SW 控制台手测：`li:power` 开（观察 `startStep` 序列与通知）、Meet 静音/取消、`li:set-settings`、`li:power` 关、`li:disconnect`；重启 Chrome 验证无占用

Verification:

- [ ] 手测清单 3～13（spec Verification Plan）用控制台代替弹窗
- [ ] `npm test`

Rollback / Safety:

- 扩展代码独立；不加载扩展即无影响

### Chunk 5: 面板与选项页

Goal: 弹窗/侧栏与选项页照设计稿可用；开启中转圈与步骤文案、暂停态说明、断开链接；所有文案来自 shared。

Files:

- `src/extension/popup.html`、`sidepanel.html`、`panel.js`、`panel.css` - AC-106, AC-126, AC-128
- `src/extension/options.html`、`options.js` - AC-129
- `tests/unit/extension-static.test.mjs` - 追加 AC-106, AC-126

Steps:

- [ ] `panel.js`：读 settings/runtime → `statusCopy` → 渲染（标题、说明、主按钮、步骤文案、暂停说明、note、断开链接）；`storage.onChanged` 订阅；14 项可滚动下拉；头部「设置」「停靠」
- [ ] 深色默认 + `prefers-color-scheme: light`；按钮内 spinner 动画
- [ ] 选项页四张设备卡 + 授权 + 衬底三选一 + 检测本地服务 + 静音感知/限制/耳机提示

Verification:

- [ ] 手测清单 1～14 完整走一遍（mock）；截图弹窗各状态 / 侧栏 / 选项页 / 通知

Rollback / Safety:

- UI 文件独立；接线纪律由静态测试守住

### Chunk 6: 文档、真实后端实机、请求日志

Goal: README 可照做；真实后端跑通双向、衬底与 Meet 静音；留下可续接的请求日志。

Files:

- `README.md`
- `docs/features/browser-extension/requests/YYYY-MM-DD-extension-implementation.md`

Steps:

- [ ] README：删网页版章节；新增安装（含安装提示说明）、开启（冷启动、就绪通知）、原声直通与关闭、Meet 静音（仅 Meet）、「语言能力与限制」、建议耳机
- [ ] `.env` 设 real，手测 4～8 + 说一句英语；记录冷启动耗时、延迟、衬底体感与踩坑
- [ ] 请求日志写明每个 AC 的验证方式与结果、13 个语言码实测、Meet DOM 选择器、直通延迟/回声实测

Verification:

- [ ] `npm test`、`npm run e2e:real`

Rollback / Safety:

- 文档变更

### Chunk 7: 实机反馈——关闭即释放、开启可取消（2026-09-10）

Goal: 关闭、取消、任何失败都不占用麦克风；开启中可取消。

Files:

- `src/shared/runtime-state.mjs` - `stopped`/`failed` 终态不留桥；`statusCopy` 返回按钮 action/variant/spinner/lockFields；去掉断开入口与「原声直通」文案
- `src/extension/background.js` - `releaseAll`、`cancelStart`、开启取消令牌（`beginStart`/`checkpoint`/带 `run` 的 `withTimeout`）、未就绪宿主端口也可断开；移除 `li:disconnect` UI 处理与 devicechange 自动重连
- `src/extension/panel.js`、`popup.html`、`sidepanel.html`、`panel.css`、`options.html` - 取消开启、去掉断开链接、选项页补充关闭后的影响
- `tests/unit/runtime-state.test.mjs`、`tests/integration/background-flow.test.mjs`、`tests/unit/extension-static.test.mjs` - AC-146～AC-150

Verification:

- [x] `npm test` 174/174；5 处定点变异各自让对应用例转红
- [ ] 实机：关闭后橙色麦克风指示消失；三段步骤任一处取消都立即回到关闭

## Testing Plan

| Layer | Files / Command | Acceptance Criteria Covered |
| --- | --- | --- |
| Unit | `tests/unit/languages.test.mjs` | AC-135 |
| Unit | `tests/unit/direction-plan.test.mjs` | AC-107, AC-108 |
| Unit | `tests/unit/floor.test.mjs` | AC-137（纯函数） |
| Unit | `tests/unit/meeting-mute.test.mjs` | AC-130 |
| Unit | `tests/unit/native-protocol.test.mjs` | AC-111 |
| Unit | `tests/unit/runtime-state.test.mjs` | AC-120, AC-121, AC-122, AC-125, AC-127, AC-138, AC-141, AC-142, AC-143（文案与转换） |
| Unit | `tests/unit/routing-state.test.mjs`（追加） | AC-136（`buildFloorConstraints`） |
| Unit | `tests/unit/pure-functions.test.mjs`（追加） | AC-124 |
| Unit | `tests/unit/extension-id.test.mjs` | AC-117 |
| Static | `tests/unit/player-static.test.mjs`（追加） | AC-133, AC-137 |
| Static | `tests/unit/extension-static.test.mjs` | AC-106, AC-115, AC-119, AC-121, AC-122, AC-123, AC-125, AC-126, AC-131, AC-132, AC-133, AC-134, AC-135, AC-139, AC-142, AC-144, AC-145 |
| Static | `tests/unit/repo-hygiene.test.mjs`（追加） | AC-118 |
| Integration | `tests/integration/native-host.test.mjs` | AC-112, AC-113 |
| Integration | `tests/integration/token-endpoint.test.mjs`（追加） | AC-114 |
| Integration | `tests/integration/server-routes.test.mjs` | AC-134 |
| Integration | `tests/integration/build-extension.test.mjs` | AC-116 |
| Integration | `tests/integration/install-native-host.test.mjs` | AC-117 |
| Manual | spec 手测清单 1～14（mock） | AC-101～AC-105, AC-109, AC-110, AC-128～AC-129, AC-131～AC-132, AC-136～AC-143, AC-145 |
| Manual | real 后端 4～8 + 同语言验证 | AC-101～AC-103, AC-131, AC-137, AC-143（真实链路）；Upstream Limits 确认 |

## Risk Controls

| Risk | Control |
| --- | --- |
| Scope creep | Non-goals 明确（无插件静音按钮、无自动连接、无自动重连）；不动协议层/预检/看门狗；UI 只照两张定稿画板 + 明示偏离 |
| Contract drift | `buildDirections(DEFAULT_SETTINGS) deepEqual DIRECTIONS`；`selectSessionEndpoint` 单参兼容测试；`launchToken` 缺省零差异测试；`createPlayer` 返回键集合测试 |
| 遗留测试被顺手改坏 | 只允许 spec Compatibility 清单所列改动；review 逐项对照 |
| 接线层偷带判定逻辑 | `extension-static` 与 `shared-purity` 沿用正则纪律；门控经 `forwardMicAudio`、衬底经 `floorTarget`、约束经 `buildFloorConstraints`、静音解析经 `parseMeetMuteState`、步骤经 `runtime-state` |
| 未经用户触发占用设备 | 静态测试断言 `onStartup`/`onInstalled`/顶层无占用调用；`planRecovery` 单测无 `connect`/`start` 动作 |
| 探测脚本越权 | 静态测试禁止 DOM 写入与网络/媒体 API；SW 校验 sender 来源 |
| Meet 改版 | 解析失败 → null → 不暂停；面板明示；选择器集中在 `meeting-mute.mjs` |
| 就绪通知早发 | 离屏只在所有 translate 方向 `open` + 采集启动后回复；一方向失败即整体失败，单测 `readyCopy`、手测 4 |
| 直通成回环 | 复用 `preflight` 对 monitor/mic 的拒绝规则；手测 10 |
| 衬底爆音 / 压低比例不适 | `linearRampToValueAtTime` 平滑；选项页 0/25/50%；实机调参记录 |
| 宿主残留进程 / stdout 污染 | 集成测试断言退出码与端口释放；`console.log` 重定向并断言 stdout 仅协议帧 |
| Chrome 行为不符预期 | Chunk 4 前 spike；失败回到 feasibility 方案 B 复议 |
| 语言码不被接受 / 同语言体感 | 开发前逐码实测；真实后端说一句英语，结果写进请求日志与 README |
| 密钥泄露 | `repo-hygiene` 扫描扩展目录与 dist；`stripSecrets` 单测 |

## Review Checklist

- [ ] 改动与 `2-tech-spec.md` 契约一致（消息、协议、storage、两层状态机与 `startStep`、音频图、语言目录、通知、探测脚本）。
- [ ] 每个 AC 有自动化覆盖或明确的手测路径（见 Testing Plan）。
- [ ] 浏览器启动/安装/SW 唤醒不占用任何设备（AC-139 留证）。
- [ ] 桥已连接时任何翻译层失败都不影响直通（AC-138 手测留证）。
- [ ] 就绪通知只在双向真正就绪后发出且正文准确（AC-143 留证）。
- [ ] 网页版相关文件全部删除，`src/web/` 不存在；遗留测试改动不超出清单。
- [ ] 没有无关重构。
- [ ] 失败模式都有中文可行动文案与通知，桥失败与翻译失败分开显示，宿主有日志可查。

## Open Implementation Questions

| Question | Proposed Default | Impact |
| --- | --- | --- |
| 离屏文档能否直接 `connectNative` | 不依赖；端口由 SW 持有 | 若可以，也不改设计 |
| 同一麦克风两次 `getUserMedia`（直通 + 24k 采集）还是共享一条 stream | 两次（约束不同） | 若不允许并存则共用并接受 AEC 处理后的采集 |
| 衬底恢复用 `setTimeout` 还是最后一个 `BufferSource.onended` | `setTimeout(playhead + release - now)`，每次 enqueue 重置 | 实现细节 |
| `flush()` 后 `stop()` 是否爆音 | 先直接 stop；若有爆音改为 5 ms 淡出 | 只影响 `audio.js` |
| Meet 按钮匹配：`mic`/`mic_off` 连字 vs `aria-label` | 连字优先（与界面语言无关），`aria-label` 含 microphone/麦克风 作兜底 | 只影响 `meeting-mute.mjs` |
| 弹窗 `default_popup` 是否允许 query string | 不用；两个 HTML 文件 + `data-surface` | 无 |
