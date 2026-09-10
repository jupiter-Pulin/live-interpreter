# Request Log: 会议同传浏览器插件实现（网页版 → Chrome 扩展）

日期：2026-09-10　分支：`feat/browser-extension`　基线：`0654130`（spec 与设计稿）

## Scope

按已审批的 `../2-tech-spec.md` 把网页版会议同传改造成 Chrome 扩展，并移除网页版。

允许改动：`src/shared/*`、`src/extension/*`（新建）、`src/server/*`、`tools/*`、`tests/*`、`package.json`、`.gitignore`、`README.md`、本请求日志。

非目标（未做，也不该做）：改音频路由方案；插件自带静音按钮；感知 Meet 以外平台的静音；自动连接与自动重连；字幕上屏；Web Store 发布；引入打包器/框架/新运行时依赖；把 `OPENAI_API_KEY` 放进扩展；改 `session-protocol.mjs` 的消息形态与 idle-commit 语义；改 `device-preflight.mjs` 规则；改 `mock-realtime.mjs`；改 `tools/e2e-real.mjs`。

## Controlling Docs

- `../2-tech-spec.md`（唯一真值：契约、AC-101～AC-145、边界情况、验证计划、遗留测试清单）
- `../4-implementation-plan.md`（六个 Chunk、文件归属、Testing Plan、Open Implementation Questions）
- `../1-requirements.md`（界面文案、产品规则、上游限制）
- `../0-feasibility-study.md`（方案取舍、Validation Plan）
- `design/extension/Main.dc.html`、`Docked.dc.html`、`_v1/Setup.dc.html`（布局、配色、文案）
- `~/.claude/CLAUDE.md`（语言约定）

## 提交（按 Chunk）

| Chunk | 提交 | 内容 |
| --- | --- | --- |
| 1 | `8f900ce` | shared 纯逻辑：语言目录、方向计划、衬底、Meet 静音解析、协议帧、运行态状态机与文案 |
| 2 | `9847fd8` | 移除网页版、接线迁入 `src/extension/`、播放器直通混音、精简 `createServer`、Native Messaging 宿主 |
| 3 | `925a4c2` | 工具链：manifest 与固定 key、`build:ext`、`install:host`、扩展 ID、图标 |
| 4 | `d1337e0` | SW 编排、离屏音频桥与翻译叠加、Meet 只读探测；静态纪律 + SW 全流程集成测试 |
| 5 | `9aecbac` | 弹窗/侧栏面板与选项页 |
| 6 | 本次 | README「浏览器插件」章节、请求日志、AC-103 静态用例 |

## Changes

| 区域 | 改动 | 原因 |
| --- | --- | --- |
| `src/shared/`（新增 7 个） | `languages.mjs`、`direction-plan.mjs`、`floor.mjs`、`meeting-mute.mjs`、`native-protocol.mjs`、`native-errors.mjs`、`runtime-state.mjs` | 扩展需要的全部新判定逻辑与界面/通知文案都落成可被 Node 直接测的纯函数 |
| `src/shared/`（修改 5 个） | `directions.mjs` 改由 `buildDirections(DEFAULT_SETTINGS)` 生成；`audio-routing.mjs` 加 `buildFloorConstraints`；`session-endpoint.mjs` 加第二参；`session-protocol.mjs` 加可选 `directionTable`；`errors.mjs` 加 `host_unavailable` | 语言可配置、直通约束分角色、端点要带宿主地址与启动令牌；全部为可选参数或新增字段，单参调用行为不变 |
| `src/shared/session-state.mjs` | 删除 | 网页版状态机，由 `runtime-state.mjs` 取代 |
| `src/web/` | 整个目录删除；`audio.js`、`session.js` 迁入 `src/extension/` | 移除网页版；两个接线文件本来就不依赖页面 DOM |
| `src/extension/audio.js` | `createPlayer` 新增 `attachFloor`/`setFloorLevel`/`holdFloorFull`/`flush`，内部加 `floorGain` 与 `scheduleFloor` | 播放器从「只放译文」变成「直通 + 译文」的混音器；既有 resume 防线、statechange 看门狗、`enqueue` try/catch 的代码形状一字未动 |
| `src/extension/`（新增 9 个） | `manifest.json`、`background.js`、`offscreen.html/js`、`meet-mute.js`、`popup.html`、`sidepanel.html`、`panel.js/css`、`options.html/js`、`icons/*.png` | 扩展本体，零打包器、零框架 |
| `src/server/index.mjs` | 删静态托管、`/api/config`、`mockWsUrl`、CLI 入口；加 `launchToken` 鉴权 | 只服务网页版的部分随网页版移除；令牌端点改为需要一次性启动令牌 |
| `src/server/native-host.mjs` | 新增 | Native Messaging 宿主：随扩展的 `connectNative` 冷启动、随端口断开退出 |
| `tools/` | 新增 `build-extension.mjs`、`install-native-host.mjs`、`extension-id.mjs`、`gen-ext-key.mjs`、`gen-icons.mjs` | 零依赖工具链；构建只做文件拷贝 |
| `package.json`、`.gitignore` | 删 `start`/`start:real`，加 `build:ext`/`install:host`/`gen:icons`；忽略 `dist` | 网页版入口移除，扩展工具链就位 |
| `tests/`（新增 13 个） | 见 Verification | 覆盖 Testing Plan 的全部层次，另加一条 SW 全流程集成测试 |
| `tests/`（遗留改动） | 严格按 spec Compatibility 清单：删 `subtitle-panel-static`；`player-static` 与 `audio-permission-probe-static` 只改路径并追加用例；`routing-state` 删 session-state 段、`source` 改 `auto` 加 `mode`、追加 `buildFloorConstraints`；`mock-pipeline` 删 `/api/config` 守卫段；`subtitle-isolation` 只改注释 | 清单之外的现有测试文件一字未改，也没有为迁就新代码修改任何既有断言 |
| `README.md` | 删网页版章节，新增「浏览器插件」 | 安装（含权限提示说明）、开启与就绪通知、原声直通与关闭、Meet 静音、语言能力与限制、建议耳机 |

## Verification

```bash
npm test
```

结果：**151 passed / 0 failed / 0 skipped**（`# tests 151 # pass 151 # fail 0`，耗时约 2.6 s，mock 后端，不打真 API、不碰真设备）。

```bash
npm run build:ext     # → dist/extension（18 个 shared 模块 + 扩展本体 + 4 个图标）
npm run install:host  # 已在临时 --home 下验证；未写入真实用户目录
node tools/gen-ext-key.mjs   # 已运行一次；扩展 ID = bicdajleioedhnconkbbmdnliocbofee
node tools/gen-icons.mjs     # 已运行一次，4 个尺寸的 PNG 已提交
```

未运行：`npm run e2e:real`（会产生真实 API 费用，按任务要求不跑）。

### 测试有效性抽查（变异测试）

对 `background.js` 做了 4 次定点变异，确认新增用例确实会失败而不是空转：

| 变异 | 被哪条用例抓到 |
| --- | --- |
| `stop()` 里顺手发 `li:disconnect`（关闭同传时撤桥） | AC-102 关闭同传 |
| 去掉 `applyMeetingMute` 的 `phase !== 'on'` 守卫 | AC-132/AC-144 非 Meet 来源忽略 |
| `failBridge` 不再 `disconnectHost()` | AC-141 桥丢失 |
| 就绪通知正文改成固定字符串而非 `readyCopy` | AC-142/AC-101/AC-143 冷启动、AC-145 通知纪律 |

## AC Evidence

状态口径：`automated-pass` = 有自动化用例且已通过；`manual-pending` = 需要真实 Chrome / Meet / BlackHole / 耳机 / macOS 通知，本环境无法执行；混合项标注哪一半是自动化、哪一半留待手测。

| AC ID | Status | Proof | 实机口径 | Files | Notes |
| --- | --- | --- | --- | --- | --- |
| AC-101 | pass | `AC-142/AC-101/AC-143 冷启动…`、`AC-121 badgeFor` | automated-pass（时限 manual-pending） | `src/extension/background.js`、`src/shared/runtime-state.mjs` | 自动化覆盖 `starting → on`、两方向 running、`server.port` 等于 ready 帧端口、绿/琥珀角标；「5 s 内」与弹窗观感留手测 4 |
| AC-102 | pass | `AC-102 关闭同传…` | automated-pass（音频连续性 manual-pending） | `background.js`、`offscreen.js` | 自动化覆盖 phase→off、bridge 保持 connected、`li:stop`、宿主端口断开并收到 `shutdown`、离屏文档保留、灰点、不通知；`pgrep` 与耳机/16ch 不断声留手测 8 |
| AC-103 | pass | `AC-103 重开弹窗直接从 storage 渲染…`、`AC-106 面板只渲染 storage…` | automated-pass（音频连续性 manual-pending） | `panel.js` | 自动化覆盖「只读 storage 渲染、打开弹窗不发任何消息」；关弹窗 60 s 再开且声音不断留手测 6 |
| AC-104 | pass | `AC-104 过渡态收到 li:power 一律 busy…` | automated-pass | `background.js`、`panel.js`、`panel.css` | 三种过渡态都回 `{ok:false, reason:'busy'}` 且 runtime 快照不变；按钮禁用与转圈由 `tone==='progress'` 驱动（AC-128 已静态检查动画） |
| AC-105 | pass | `AC-105/AC-138 宿主不可用…`、`AC-105 建桥失败…`、`native-errors.test.mjs` 4 条 | automated-pass | `background.js`、`src/shared/native-errors.mjs`、`errors.mjs` | 覆盖宿主未安装、宿主启动即退出、超时兜底、建桥失败；error 态直接重试成功 |
| AC-106 | pass | `AC-106 面板只渲染 storage…` | automated-pass | `panel.js` | 禁词表 + 禁止对 `meetingMuted`/`bridge`/`startStep` 出现任何判定；只允许发三种消息 |
| AC-107 | pass | `AC-107 默认计划即方向表…`、`AC-107 两个目标语言…` | automated-pass | `src/shared/direction-plan.mjs`、`directions.mjs` | 含「不与 DIRECTIONS 共享引用」 |
| AC-108 | pass | `AC-108 选「原声」…`、`AC-108 normalizeSettings…`、`AC-108/AC-109 diffPlan…` | automated-pass | `direction-plan.mjs` | 未知键 `speak`/`autoConnect` 被丢弃且不抛出 |
| AC-109 | pass | `AC-109 改语言：只重启受影响方向…`、`AC-109 planApplied…` | automated-pass（听感 manual-pending） | `background.js`、`offscreen.js` | 自动化覆盖 `li:update-plan` 的新计划、`runtime.languages`、未开启时不发消息；「另一方向对象引用不变」「新会话 session.update 的 language」留手测 7（离屏内部行为，Node 里无 Web Audio） |
| AC-110 | pass | `AC-110 passthrough 方向的分支只看 plan 的 mode` | automated-pass（听感 manual-pending） | `offscreen.js` | 静态证明 mode 判定在建会话与采集之前；16ch 只录到原声留手测 7 |
| AC-111 | pass | `native-protocol.test.mjs` 4 条 | automated-pass | `src/shared/native-protocol.mjs` | 逐字节/半包/粘包三种切分 + 超限停止 + 非法 JSON 停止 |
| AC-112 | pass | `AC-112 首帧 ready…` | automated-pass | `src/server/native-host.mjs` | 真的 spawn 宿主进程；断言 stdout 字节数恰等于协议帧（无日志污染）、ready 帧喂 `selectSessionEndpoint`、`/` 与 `/api/config` 404 |
| AC-113 | pass | `AC-113 ping → pong…`、`AC-113 关闭 stdin…` | automated-pass | `native-host.mjs` | 两条路径都在 2 s 内以 0 退出且端口不可再连 |
| AC-114 | pass | `AC-114 启动令牌…`、`AC-114 带令牌时现有分支不变` | automated-pass | `src/server/index.mjs` | 401 时 `exchangeToken` 调用计数为 0；不传 `launchToken` 时原三个用例原样通过 |
| AC-115 | pass | `AC-115 manifest…` | automated-pass | `src/extension/manifest.json` | 权限集合、`host_permissions`、`content_scripts` 深相等、无 `web_accessible_resources`、`key` 非空 |
| AC-116 | pass | `build-extension.test.mjs` 4 条 | automated-pass | `tools/build-extension.mjs` | 文件清单、shared 逐字节相同、version 同步、重复构建先清空、产物无 `.env`/`node_modules`/`src/server` |
| AC-117 | pass | `extension-id.test.mjs` 2 条、`install-native-host.test.mjs` 4 条 | automated-pass | `tools/extension-id.mjs`、`install-native-host.mjs` | 固定向量 + 独立实现交叉验证；幂等逐字节相同；`--browser edge` |
| AC-118 | pass | `AC-118 dist 不入库…`、`AC-118 安装脚本只写…` | automated-pass | `.gitignore`、`tools/*` | `git ls-files` 无 `dist/`；扩展与工具目录通过密钥扫描 |
| AC-119 | pass | `AC-119 接线层不得内联判定…`、`AC-119/AC-142 …没有字段赋值`、`AC-136/AC-119 离屏的直通约束…`、`AC-144/AC-119 静音判定…` | automated-pass | `background.js`、`offscreen.js`、`meet-mute.js`、`panel.js`、`options.js` | `shared-purity` 覆盖全部新增 shared 模块 |
| AC-120 | pass | `runtime-state.test.mjs` 8 条转换用例 | automated-pass | `src/shared/runtime-state.mjs` | 逐条对照 spec 的两张转换表，含「非法转换返回同一引用」 |
| AC-121 | pass | `AC-121 badgeFor…`（九种状态）、`AC-121 每次写 runtime 都刷角标` | automated-pass | `runtime-state.mjs`、`background.js` | 断言 `storage.session.set` 与 `setBadgeText` 各只有一处（都在 `dispatch` 里） |
| AC-122 | pass | `AC-122/AC-139 planRecovery…`、`AC-122 SW 唤醒后的恢复…`、`AC-122 离屏长连接断开…`、`AC-122/AC-139 顶层与钩子…` | automated-pass | `runtime-state.mjs`、`background.js` | 四种条件逐项相等；SW 集成测试真的跑了三种恢复分支 |
| AC-123 | pass | `AC-123 翻译层掉线…`、`AC-123 翻译层失败不自动重连…` | automated-pass | `background.js`、`offscreen.js` | 失败后 30 个事件循环内只发出 `li:stop`，无第二个宿主端口；上行挂起例外见 AC-133 |
| AC-124 | pass | `AC-124 selectSessionEndpoint 第二参…`、既有 `AC-030` | automated-pass | `src/shared/session-endpoint.mjs` | 单参形态与网页时代完全一致；mock 分支带第二参仍无 token 路径与 headers |
| AC-125 | pass | `AC-125 stripSecrets…`、`AC-125 密钥不落盘…`（静态）、`AC-125 启动令牌只在内存…`（运行时） | automated-pass | `runtime-state.mjs`、`background.js` | 集成测试 dump 整个假 storage 断言不含 launchToken |
| AC-126 | pass | `AC-126 弹窗与侧栏只加载…`、`AC-126 面板文案齐备…`、`AC-126 面板不含被否决的入口…`、`AC-126/AC-135 两个下拉各 14 项…` | automated-pass（视觉 manual-pending） | `popup.html`、`sidepanel.html`、`panel.js` | 24 条必含文案逐条断言；「静音/恢复翻译不得成为按钮」改为断言全部可能的按钮文案集合（见「spec 偏差 3」） |
| AC-127 | pass | `AC-127 statusCopy：未连接 / 桥失败 / 已连未翻译`、`…开启中三段步骤文案与关闭中`、`…进行中 / 已静音 / 静音未知 / 恢复中 / 翻译失败` | automated-pass | `runtime-state.mjs` | 进行中与静音两条正文按 AC 原文逐字比对 |
| AC-128 | pass | `AC-128 弹窗 380×600…` | automated-pass（截图 manual-pending） | `panel.css` | 静态覆盖尺寸、浅色 token、danger/warning 色值、脉冲与转圈动画、下拉 280px 滚动、无远程字体；已用一次性预览脚手架在浏览器里核对 on/starting/muted/unknownMute/bridgeFail 五态与选项页渲染（截图未入库），真实弹窗尺寸留手测 14 |
| AC-129 | pass | `AC-129 选项页…`、`AC-129 衬底档位改动即时下发…` | automated-pass（授权提示 manual-pending） | `options.html`、`options.js`、`background.js` | 自动化覆盖按 kind 过滤、默认分配首项、preflight 结论、三选一写 `floorLevel` 并即时下发、自检后立即断开端口、各段说明文字；真实授权弹窗留手测 2 |
| AC-130 | pass | `meeting-mute.test.mjs` 4 条 | automated-pass | `src/shared/meeting-mute.mjs` | 含摄像头按钮不被误判、`microphone-wrapper` 不命中、aria-label 兜底 |
| AC-131 | pass | `AC-131/AC-132 Meet 静音…`、`AC-131/AC-132 上行暂停：SW 只转发…`、`AC-120/AC-131 meetingMute…` | automated-pass（听感与时延 manual-pending） | `background.js`、`offscreen.js`、`audio.js` | 自动化覆盖 meetingMuted、琥珀角标、`li:set-uplink-paused`、两处 `forwardMicAudio` 门控、`flush` + `holdFloorFull`；QuickTime 录 16ch 的 0.5 s 内消失留手测 5 |
| AC-132 | pass | `AC-131/AC-132 Meet 静音…`、`AC-132/AC-144 非 Meet 来源忽略…`、`AC-133 上行挂起…` | automated-pass（听感 manual-pending） | `background.js`、`offscreen.js` | 自动化覆盖重建 `restarted:['uplink']`、`phase=off` 时不发消息、开启时 `uplinkPaused` 等于静音态、就绪通知的静音文案、静音态未知不暂停；Zoom 场景留手测 13 |
| AC-133 | pass | `AC-133 createPlayer 返回对象恰含…`、`AC-133 flush…`、`AC-133 stop 同时停止直通 track…`、`AC-133 上行挂起…` | automated-pass | `src/extension/audio.js`、`offscreen.js` | 返回键集合 deepEqual 六个方法；`player-static.test.mjs` 原有断言未改一字 |
| AC-134 | pass | `server-routes.test.mjs` 5 条 | automated-pass | `src/server/index.mjs`、`package.json` | 目录/文件已删、`serveStatic`/`/api/config`/`readFile`/`process.env` 均不存在、三个路由 404 JSON、scripts 清单 |
| AC-135 | pass | `AC-135 语言目录…`、`AC-135 原声是第 14 个选项…`、`AC-135 接线层不含语言码…`、`AC-126/AC-135 两个下拉…` | automated-pass | `src/shared/languages.mjs` | 13 个码作为集合与上游文档一致；五个接线文件逐个扫语言码与标签字面量 |
| AC-136 | pass | `AC-136 直通约束…`、`AC-136/AC-119 离屏的直通约束…`、`AC-136 UI 层不得存在「只建桥不翻译」的入口`、`AC-142/AC-101/AC-143 冷启动…` | automated-pass（实机 manual-pending） | `src/shared/audio-routing.mjs`、`offscreen.js`、`panel.js`、`options.js` | 自动化覆盖两种约束、离屏只有一处 `getUserMedia`、UI 无 `li:connect`、建桥完成前未 `connectNative`；「直通延迟 < 50 ms」「耳机听到原声」留手测 1/12 与上游验证项 |
| AC-137 | pass | `floor.test.mjs` 3 条、`AC-137 衬底增益：ramp 平滑…` | automated-pass（听感 manual-pending） | `src/shared/floor.mjs`、`audio.js` | 纯函数逐项验证；静态确认用 `linearRampToValueAtTime` 且目标值只来自 `floorTarget`/`isTranslating`；实际压低/恢复听感留手测 4 |
| AC-138 | pass | `AC-105/AC-138 宿主不可用…`、`AC-120/AC-138 桥失败时…`、`AC-138/AC-141 failureCopy…` | automated-pass（音频连续性 manual-pending） | `background.js`、`runtime-state.mjs` | 自动化覆盖 bridge 保持 connected、离屏文档仍在、native 端口已断、通知正文等于 `failureCopy(...)`；「player 与直通 stream 引用不变、增益回 1.0」留手测 9 |
| AC-139 | pass | `AC-139 浏览器刚启动…`、`AC-122/AC-139 planRecovery…`、`AC-122/AC-139 顶层与钩子…` | automated-pass（实机 manual-pending） | `background.js`、`runtime-state.mjs` | 自动化覆盖顶层与 onInstalled/onStartup 零占用、planRecovery 永不返回 connect/start；macOS 橙色麦克风指示留手测 3 |
| AC-140 | pass | `AC-140 断开会议音频…` | automated-pass（实机 manual-pending） | `background.js`、`offscreen.js` | 自动化覆盖先撤翻译层再撤桥、closeDocument、runtime 回初始并保留 meetingMuted、角标清空；track `readyState === 'ended'` 留手测 12 |
| AC-141 | pass | `AC-141 桥丢失…`、`AC-141 devicechange 不循环…`、`AC-138/AC-141 failureCopy…` | automated-pass（实机 manual-pending） | `background.js` | 自动化覆盖桥失败通知、宿主退出、离屏保留、重试恰一次、连发 5 次 devicechange 不循环；拔插耳机留手测 11 |
| AC-142 | pass | `AC-142/AC-101/AC-143 冷启动…`、`AC-120/AC-142 requestStart…`、`AC-127/AC-142 statusCopy 三段步骤`、`AC-119/AC-142 没有字段赋值` | automated-pass（视觉 manual-pending） | `background.js`、`runtime-state.mjs`、`panel.js` | 自动化断言发 `li:connect` 时 `startStep==='bridge'`、发 `li:start` 时 `==='translation'`、结束时为 null，且 `background.js` 无 `startStep =` 赋值；转圈观感留手测 4/8 |
| AC-143 | pass | `AC-142/AC-101/AC-143 冷启动…`、`AC-143 readyCopy…`、`AC-132/AC-144 …就绪通知静音文案` | automated-pass（通知显示 manual-pending） | `offscreen.js`、`runtime-state.mjs`、`background.js` | readyCopy 三种形态逐字比对；就绪判定「等 open + 采集返回」由 `offscreen.js` 的 `startDirection` 实现，Node 里无法执行（无 Web Audio），该半段留手测 4 |
| AC-144 | pass | `AC-144 Meet 探测脚本只读…`、`AC-144/AC-119 静音判定…` | automated-pass | `meet-mute.js`、`background.js` | 17 个禁用 API 逐个扫；SW 侧 `sender.tab?.url?.startsWith(MEET_ORIGIN)` 校验有静态与运行时两重证明 |
| AC-145 | pass | `AC-145 通知只在三处发出…`、`AC-145 通知契约…`、集成测试里三处通知的 id/title/message 逐条断言 | automated-pass（macOS 显示 manual-pending） | `background.js`、`runtime-state.mjs` | 自动化确认恰好三处 `chrome.notifications.create`、id 与正文来源；macOS 通知中心实际显示留手测 4/9 |

汇总：**45 条 AC 全部有自动化证据（automated-pass）**，其中 20 条另有需要真实设备/浏览器才能确认的部分，已在 Notes 里点名对应的手测项。没有 `not-met` 或 `blocked`。

## 无法在本环境执行的验证（留给实机）

以下项**没有**执行，任何结论都不得当作已验证：

### spec Verification Plan 手测清单 1～14（mock 后端，零 API 成本）

1. `npm run build:ext` → `chrome://extensions` 开发者模式 → 加载 `dist/extension`，**记录安装提示的原文**；`npm run install:host`。
2. 右键图标 →「选项」→ 授权麦克风 → 确认「设备已就绪」及四个角色的设备名 → 衬底选「低 25%」→ 点「检测本地服务」，应显示 `本地服务可用：后端 mock，端口 …，版本 0.1.0`。
3. 完全退出并重启 Chrome → 菜单栏**无橙色麦克风指示**；扩展图标**无角标**；点图标显示「同传已关闭 / 未连接会议音频…」；在 SW 控制台执行 `await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` 应为空数组。（AC-139）
4. 进入一个 Meet 会议（可自己开会）→ 点图标 →「开启同传」→ 按钮转圈，依次看到「正在连接会议音频…」「正在启动本地翻译服务…」「正在连接翻译服务…」→ 就绪后标题「同传进行中」+ 脉冲绿点 + 图标绿点 + macOS 通知「同传已就绪」，**通知正文应与面板说明一致**。用秒表记录点击到通知的耗时（目标 ≤ 6 s）。QuickTime 回放 `fixtures/sample-en.wav` 灌入 BlackHole 2ch：耳机里应听到「原声 + mock 提示音」叠加，提示音播放时原声变小、停顿约 0.7 s 后恢复。（AC-142, AC-143, AC-145, AC-137）
5. 在 Meet 点静音 → 0.5 s 内面板出现「会议已静音 · 暂停翻译你的话。对方说的仍会翻成中文进你的耳机。」+ 图标琥珀点；QuickTime 录 BlackHole 16ch：提示音消失、**你的原声连续不断**；耳机里对方方向的提示音继续。取消静音 → 提示音回来。（AC-131, AC-132）
6. 关闭弹窗、等 60 s、重新打开 → 仍显示「同传进行中」，声音全程不断；`pgrep -f native-host.mjs` 恰有一条。（AC-103）
7. 改「你想听的语言」为「日本語」→ 只有下行重启（耳机方向短暂静默、16ch 不受影响）；改「对方听的语言」为「原声（不翻译）」→ 16ch 只录到你的原声、无提示音；改回 English。（AC-109, AC-110）
8. 「关闭同传」→ 2 s 内 `pgrep -f native-host.mjs` 为空、图标灰点、耳机与 16ch 的原声**仍然直通**；再「开启同传」→ 只转后两步（不再出现「正在连接会议音频…」），记录耗时（目标 ≤ 4 s）。（AC-102, AC-142）
9. 删除 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.live_interpreter.host.json` 后「开启同传」→ 面板「无法开启同传」+ 安装命令 + 「原声仍在直通。」，通知同文，**耳机原声未断**；`npm run install:host` 重装后可正常开启。（AC-105, AC-138）
10. 选项页把「你的耳机 · 监听」改成 BlackHole → 应立刻显示回环拒绝原文；「断开会议音频」→「开启同传」→ 第一步即失败「无法连接会议音频」+ 预检原文 + 通知；改回真实耳机后再「开启同传」成功。（AC-141 失败态）
11. 同传进行中拔掉耳机 → 桥失败 + 通知；插回耳机 → 自动重试一次并恢复 `connected`。（AC-141）
12. 「断开会议音频」→ 角标消失、macOS 橙点消失、面板「未连接会议音频」；再「开启同传」→「关闭同传」→ 灰点、原声直通、无宿主进程。（AC-136, AC-140）
13. 在 Zoom 网页会议里「开启同传」→ 面板末尾常显「未感知到会议静音（仅支持 Google Meet）」；在 Zoom 里静音不影响翻译。（AC-132）
14. 点头部「停靠」图标 → 侧栏出现在会议右侧、内容与弹窗一致、可正常开关；核对弹窗确为 380×600。（AC-128）

### 真实后端手测

`.env` 设 `TRANSLATE_BACKEND=real` 后重复 4～8：耳机应听到中文译文叠在压低的英语原声上；对麦克风说中文，16ch 应录到英语译文叠在压低的中文原声上；Meet 静音后 16ch 只剩原声；**说一句英语**确认模型不出声、对方听到 100% 原声（同语言片段规则）。另跑一次 `npm run e2e:real` 确认真实链路未被本次改动破坏。

### feasibility Validation Plan（开发前应完成、本次未执行）

- Spike：离屏文档中 `new AudioContext()` + `setSinkId(BlackHole 16ch)` 无用户手势能否 `running`；同一 ctx 内直通与 `BufferSource` 同时出声、ramp 无爆音。
- Spike：选项页授权后离屏 `getUserMedia({deviceId:{exact}})` 免提示；同一麦克风两次 `getUserMedia`（直通 + 24 k 采集）能否并存。
- Spike：从 Dock 启动的 Chrome 里 `connectNative` 能拉起 wrapper 并收到 `ready`，记录耗时。
- Meet DOM：在真实会议页确认麦克风按钮的 `data-is-muted` 与 `mic`/`mic_off` 图标连字，点静音/取消静音属性随之变化，**记录实际选择器**。
- `chrome.notifications` 在 macOS 上的显示效果与系统通知权限提示。
- 直通端到端延迟（目标 < 50 ms）与外放回声实测。
- **13 个输出语言码逐一 `session.update` 无 error**（`en es pt fr de it ru zh ja ko hi id vi`）。当前 `OUTPUT_LANGUAGES` 直接采信 OpenAI 文档；若某个码被拒，只需改 `src/shared/languages.mjs` 一处。
- 真实 e2e：英语音频 + 输出 `en`，确认模型不出声且衬底恢复原声。

## Spec 偏差

以下四处与 spec 字面不同，均按 `4-implementation-plan.md` 的「Open Implementation Questions」默认值或 AC 之间的优先级处理，**没有改动 spec 四份文档的任何契约**。

### 1. Meet 静音判定从内容脚本移到 service worker（影响 spec「Meet 静音探测脚本契约」与消息载荷）

- spec 写：探测脚本收集按钮列表 → 自己调 `parseMeetMuteState` → 发 `{ ..., muted: true|false|null }`。
- 实际：探测脚本只在**原始快照变化**时发 `{ ..., buttons: [...] }`，由 SW 调 `parseMeetMuteState({ buttons })` 得到 `muted`，再 `resolveMeetingMuted`。
- 原因：AC-115 把 `content_scripts` 钉死为 `{matches, js, run_at}` 三个键（没有 `type: 'module'`），又禁止 `web_accessible_resources`。MV3 里 manifest 声明的内容脚本是**经典脚本**，既不能 `import '/shared/meeting-mute.mjs'`，也不能 `import(chrome.runtime.getURL(...))`。要让「判定只在 shared」与 AC-115 同时成立，只能让 SW 来调这个纯函数。
- 影响：判定逻辑仍然只有 `parseMeetMuteState` 一份（AC-119/AC-130 的实质不变，且更强——探测脚本里现在连比较都没有）；退化行为不变（列表为空或读不到属性 → `null` → 不暂停）；`pagehide` 改为上报空列表，SW 判为 `null`，语义等价。
- 风险：SW 每次收到快照都要跑一次解析（成本极低，脚本已按快照去重 + 200 ms 节流）。

### 2. `statusCopy` 的返回值多了两个键

- spec 写：`statusCopy(...)` 返回 `{ title, body, tone, primary, stepText, note }`，同时又在 AC-127 里要求「`bridge = disconnected` → 无 secondary」、在 AC-140/需求文案里要求底部「断开会议音频」链接与失败态的「音频设置 / 去授权麦克风」入口。
- 实际返回 `{ title, body, tone, primary, secondary, stepText, note, hint }`。`secondary` 是 AC-127 本身隐含的；`hint` 承载需求文档里失败态附带的两个入口（`{ label, category }`，`device_missing` → 「音频设置」，`permission_denied` → 「去授权麦克风」）。
- 影响：纯新增字段，不改任何既有字段的取值。

### 3. AC-126 的「不含『静音』『恢复翻译』按钮」改为按钮文案集合断言

- 原因：面板正文里必须出现「会议已静音 · 暂停翻译你的话」「未感知到会议静音」「正在恢复翻译…」（AC-126 的必含清单），因此不能用「源码不含『静音』」这种子串断言。
- 实际断言：所有可能出现在按钮上的文案（`PRIMARY_*`、`SECONDARY_DISCONNECT`、`HINTS` 的值）都不含「静音」「恢复翻译」「重试」，且两个 HTML 模板里没有任何写死文案的按钮。
- 「你说的语言」「只连接原声」「重试」仍按子串禁用（为此把 `languages.mjs` 里一句提到「你说的语言」的注释改了措辞）。

### 4. AC-116 的 `build-extension.test.mjs` 落在 Chunk 5 而不是 Chunk 3

- 原因：AC-116 的文件清单包含面板与选项页，Chunk 3 时这些文件还不存在。为保证每个 Chunk 的提交都能 `npm test` 全绿，该用例随 Chunk 5 一并加入，最终状态覆盖完整清单。

### 其它按默认值处理的实现期问题

| 问题 | 采用的默认值 | 落点 |
| --- | --- | --- |
| 同一麦克风两次 `getUserMedia`（直通 + 24 k 采集） | 两次，约束不同 | `offscreen.js`；若实机不允许并存，需改为共用一条 stream 并接受 AEC 处理后的采集 |
| 衬底恢复用 `setTimeout` 还是 `onended` | `setTimeout(playhead + release - now)`，每次 enqueue 重置 | `audio.js` 的 `scheduleFloor` |
| `flush()` 后 `stop()` 是否爆音 | 先直接 stop；若实机爆音再改 5 ms 淡出 | `audio.js` |
| Meet 按钮匹配 | 图标连字 `/\bmic(_off)?\b/` 优先，`aria-label` 含 microphone/麦克风/マイク/마이크 兜底 | `meeting-mute.mjs` |
| 弹窗是否用 query string | 不用，两个 HTML + `data-surface` | `popup.html` / `sidepanel.html` |
| 中文输出语言码 | `zh` | `languages.mjs` |
| 宿主日志位置 | `dist/native-host/host.log`，`LI_HOST_LOG` 可覆盖 | `native-host.mjs` |
| Edge 支持 | 只验证 Chrome；`install:host --browser edge` 可写 Edge 目录 | `install-native-host.mjs` |
| 宿主的 `config_missing` 错误帧 | 不发：按 spec Edge Cases「`.env` 缺 key 且 real → 宿主 ready，第三步 token 500」，宿主只在启动失败时发 `error`（`api_error`） | `native-host.mjs` |
| `devicechange` 重试的「至多一次」 | 用 1 s 冷却窗实现（系统一次插拔常连发数条事件）；失败后不自我循环，下次重试必须由真实插拔触发 | `background.js` |

## 已知风险（无法在本环境消除）

1. **Meet DOM 依赖**：`data-is-muted` 与 `mic`/`mic_off` 连字来自社区经验，未在真实会议页确认。失效时 `parseMeetMuteState` 返回 `null` → 不暂停 + 面板明示，属安全退化；修复只需改 `src/shared/meeting-mute.mjs` 一个文件。
2. **离屏文档的自动播放策略**：`AudioContext` 能否在无用户手势时 `running` 未实测。`createPlayer` 保留了原有的 resume 防线与 statechange 看门狗，`enqueue` 也会兜底 resume；若仍被挂起，会通过 `onPlaybackError` → `bridge-lost` 上报为桥失败并通知，而不是静默无声。
3. **同一麦克风两条 `getUserMedia`**：直通用 `buildFloorConstraints(id,'mic')`（开 AEC/NS），采集用 `buildCaptureConstraints`（全关）。若 Chrome 拒绝并存，第一次「开启同传」会在第三步失败并给出可行动文案，桥仍在。
4. **13 个语言码**：未逐一实测。个别码若被上游拒绝，表现为该方向建会话失败 → 翻译层 failed + 通知，桥不受影响。
5. **冷启动耗时**：`connectNative` 到 `ready` 的真实耗时未测（本机直接 spawn 宿主约 5 ms，但 Chrome 拉起 wrapper 的开销未知）。超时上限已设为 10 s。
6. **`chrome.sidePanel.open()`** 需要用户手势，「停靠」按钮的点击满足这一条，但未在真机验证。

## 给 reviewer 的重点文件

| 文件 | 为什么重点看 |
| --- | --- |
| `src/shared/runtime-state.mjs` | 两层状态机 + 全部文案的唯一真值；AC-120/121/122/127/138/141/142/143/145 都压在这里 |
| `src/extension/background.js` | 编排的全部风险点：宿主端口生命周期（`nativePort !== port` 的陈旧监听器守卫）、`exclusive`/`isTransitioning` 的并发闸、`failBridge` 与 `failTranslation` 的职责分界、`devicechange` 冷却窗 |
| `src/extension/offscreen.js` | 桥与翻译层的隔离；`startDirection` 的「等 open 再采集」就绪判定；上行门控的两个 `forwardMicAudio`；`onSessionEvent` 里挂起与掉线的分叉 |
| `src/extension/audio.js` | 在**不改动**既有 resume 防线/看门狗/`enqueue` try-catch 形状的前提下加了直通与衬底；`scheduleFloor` 的 ramp 与定时器重置逻辑 |
| `src/shared/meeting-mute.mjs` + `src/extension/meet-mute.js` | 唯一会读会议页面的地方；请对照「spec 偏差 1」确认这个取舍可接受 |
| `src/server/native-host.mjs` | stdout 纯净性、`closeAll` 的三条触发路径与 1.5 s 强制退出兜底 |
| `tests/integration/background-flow.test.mjs` | 新增的 SW 全流程验证方式（改写 import 说明符后加载真源码 + 假 chrome API）；请判断这个手法是否可接受 |
| `tests/unit/extension-static.test.mjs` | 25 条接线纪律，是「判定只在 shared」这条不变量的唯一守卫 |

## Blockers

None（无阻塞项）。

## Remaining Work

- 按上面的清单做实机手测（1～14 + 真实后端），把结果与冷启动耗时、直通延迟、衬底体感、Meet 选择器实测追加到本日志。
- 13 个语言码逐一实测；若有被拒的码，改 `src/shared/languages.mjs` 并更新 README 的语言列表。
- 若手测发现 `flush()` 后 stop 爆音，按默认值改成 5 ms 淡出（只动 `audio.js`）。
