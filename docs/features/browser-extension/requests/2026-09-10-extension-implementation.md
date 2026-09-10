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
| 6 | `d0c7d52` + `0f5c10c` | README「浏览器插件」章节、请求日志、AC-103 静态用例；改语言重建失败按翻译层 failed 处理 |
| review r1 | `dbc09d3`、`90c2b6a`、`8c5c6d3`、`3bdae62` | reviewer 的 1 blocker + 4 major + 5 minor 修复、离屏侧集成测试、日志与证据更新（见「Review round 1 修复」）|
| review r2 | 本次 | 第二轮 review 的 2 个 P2 资源泄漏（在途建桥与多轮重启的世代号守卫）+ 2 条集成用例、日志与证据更新（见「Review round 2 修复」）|

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

结果（首轮实现）：**152 passed / 0 failed / 0 skipped**（耗时约 2.6 s，mock 后端，不打真 API、不碰真设备）。

结果（Review round 1 修复后）：**170 passed / 0 failed / 0 skipped**（`# tests 170 # pass 170 # fail 0`，耗时约 2.5 s）。新增 18 条用例，既有断言一字未改。

结果（Review round 2 修复后）：**172 passed / 0 failed / 0 skipped**（`# tests 172 # pass 172 # fail 0`，耗时约 2.5 s）。新增 2 条用例、给 1 条既有用例追加断言，既有断言一字未改。

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
| AC-102 | deferred | 见 AC-147 | — | `background.js` | 已由 AC-147 取代（2026-09-10 实机反馈）：关闭同传现在连桥与离屏文档一起释放，原「桥保持 connected」断言按新设计不再成立 |
| AC-103 | pass | `AC-103 重开弹窗直接从 storage 渲染…`、`AC-106 面板只渲染 storage…` | automated-pass（音频连续性 manual-pending） | `panel.js` | 自动化覆盖「只读 storage 渲染、打开弹窗不发任何消息」；关弹窗 60 s 再开且声音不断留手测 6 |
| AC-104 | pass | `AC-104 过渡态：开启中再点开启、关闭中再点任何按钮都是 busy，且 runtime 不变` | automated-pass | `background.js` | 「开启中收到 li:power {on:false} 为 busy」已由 AC-146（取消）取代；开启中再点开启、关闭中任何点击仍回 busy 且 runtime 不变 |
| AC-105 | pass | `AC-105/AC-138 宿主不可用…`、`AC-105 建桥失败…`、`native-errors.test.mjs` 4 条 | automated-pass | `background.js`、`src/shared/native-errors.mjs`、`errors.mjs` | 覆盖宿主未安装、宿主启动即退出、超时兜底、建桥失败；error 态直接重试成功 |
| AC-106 | pass | `AC-106 面板只渲染 storage…` | automated-pass | `panel.js` | 禁词表 + 禁止对 `meetingMuted`/`bridge`/`startStep` 出现任何判定；只允许发三种消息 |
| AC-107 | pass | `AC-107 默认计划即方向表…`、`AC-107 两个目标语言…` | automated-pass | `src/shared/direction-plan.mjs`、`directions.mjs` | 含「不与 DIRECTIONS 共享引用」 |
| AC-108 | pass | `AC-108 选「原声」…`、`AC-108 normalizeSettings…`、`AC-108/AC-109 diffPlan…` | automated-pass | `direction-plan.mjs` | 未知键 `speak`/`autoConnect` 被丢弃且不抛出 |
| AC-109 | pass | `AC-109 改语言：只重启受影响方向…`、`AC-109 planApplied…` | automated-pass（听感 manual-pending） | `background.js`、`offscreen.js` | 自动化覆盖 `li:update-plan` 的新计划、`runtime.languages`、未开启时不发消息；「另一方向对象引用不变」「新会话 session.update 的 language」留手测 7（离屏内部行为，Node 里无 Web Audio） |
| AC-110 | pass | `AC-110 passthrough 方向的分支只看 plan 的 mode`、`AC-110 passthrough 方向：不建会话、不采集、直通恒为 1.0`（离屏侧） | automated-pass（听感 manual-pending） | `offscreen.js` | 静态证明 mode 判定在建会话与采集之前；Review r1 补运行时用例：uplink 选「原声」时不建 WebSocket、不起采集上下文、该方向直通增益恒为 1.0。16ch 只录到原声留手测 7 |
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
| AC-131 | pass | `AC-131/AC-132 Meet 静音…`、`AC-131/AC-132 上行暂停：SW 只转发…`、`AC-120/AC-131 meetingMute…`、`AC-131/AC-144 没有 tabs 权限时…`、`AC-131 li:set-uplink-paused：只掐上行…`（离屏侧） | automated-pass（听感与时延 manual-pending） | `background.js`、`offscreen.js`、`audio.js` | Review r1 前 SW 侧只有静态证明 + 假 sender 的运行时证明，而真实 Chrome 会裁掉 `sender.tab.url` 使这条路径整条失效（blocker 1 已修）；现在另有离屏侧运行时用例：暂停后 `session.sendAudio` 与 `player.enqueue` 都不再被调用、已排队的译文被 `flush` 停掉、上行直通增益为 1.0、下行播放器引用与译文入队不受影响。QuickTime 录 16ch 的 0.5 s 内消失仍留手测 5 |
| AC-132 | pass | `AC-131/AC-132 Meet 静音…`、`AC-132/AC-144 非 Meet 来源忽略…`、`AC-133 上行挂起…`、`AC-105/AC-132 改语言时重建失败…`、`AC-132/AC-143 取消静音的重建也能被作废…`（离屏侧） | automated-pass（听感 manual-pending） | `background.js`、`offscreen.js` | 自动化覆盖重建 `restarted:['uplink']`、`phase=off` 时不发消息、开启时 `uplinkPaused` 等于静音态、就绪通知的静音文案、静音态未知不暂停；Review r1 另补离屏侧运行时用例：挂起→取消静音确实重建上行会话，且重建途中被 `li:stop` 作废时不会占走麦克风。Zoom 场景留手测 13 |
| AC-133 | pass | `AC-133 createPlayer 返回对象恰含…`、`AC-133 flush…`、`AC-133 stop 同时停止直通 track…`、`AC-133 上行挂起…`、`AC-133 直通 track 被系统结束 → 上报 bridge-lost…`（离屏侧） | automated-pass | `src/extension/audio.js`、`offscreen.js` | 返回键集合 deepEqual 六个方法；`player-static.test.mjs` 原有断言未改一字（Review r1 的 minor 10 正是为了保住其中的 `playhead = 0` 断言才改用「队列有过译文」旗子，见修复第 10 条）；离屏侧补「暂停期间被对端关闭只报 uplink-suspended」与「track 被结束报 bridge-lost」的运行时证明 |
| AC-134 | pass | `server-routes.test.mjs` 5 条 | automated-pass | `src/server/index.mjs`、`package.json` | 目录/文件已删、`serveStatic`/`/api/config`/`readFile`/`process.env` 均不存在、三个路由 404 JSON、scripts 清单 |
| AC-135 | pass | `AC-135 语言目录…`、`AC-135 原声是第 14 个选项…`、`AC-135 接线层不含语言码…`、`AC-126/AC-135 两个下拉…` | automated-pass | `src/shared/languages.mjs` | 13 个码作为集合与上游文档一致；五个接线文件逐个扫语言码与标签字面量 |
| AC-136 | pass | `AC-136 直通约束…`、`AC-136/AC-119 离屏的直通约束…`、`AC-136 UI 层不得存在「只建桥不翻译」的入口`、`AC-142/AC-101/AC-143 冷启动…`、`AC-136 li:connect：两方向各一条直通路…`、`AC-136 li:connect 幂等…`、`AC-136 createPlayer 失败…`（离屏侧） | automated-pass（实机 manual-pending） | `src/shared/audio-routing.mjs`、`offscreen.js`、`panel.js`、`options.js` | 自动化覆盖两种约束、离屏只有一处 `getUserMedia`、UI 无 `li:connect`、建桥完成前未 `connectNative`；Review r1 补离屏侧运行时证明：两方向各一条 `MediaStreamSource → floorGain(1.0) → 已 setSinkId 的 destination`、约束分别来自 `buildFloorConstraints(id,'capture'/'mic')`、建桥阶段不起采集、`li:connect` 幂等、失败时释放 stream。「直通延迟 < 50 ms」「耳机听到原声」仍留手测 1/12 与上游验证项 |
| AC-137 | pass | `floor.test.mjs` 3 条、`AC-137 衬底增益：ramp 平滑…`、`AC-137 衬底不得在上下文时钟头 0.7 s 里误判「正在播译文」`（离屏侧） | automated-pass（听感 manual-pending） | `src/shared/floor.mjs`、`audio.js` | 纯函数逐项验证；静态确认用 `linearRampToValueAtTime` 且目标值只来自 `floorTarget`/`isTranslating`；Review r1 补运行时用例：`attachFloor` 之后增益为 1、喂译文后压低、`flush`（撤翻译层/暂停）后立即回 1.0——含首轮被漏掉的「上下文时钟头 0.7 s」窗口。实际压低/恢复听感留手测 4 |
| AC-138 | deferred | 见 AC-148 | — | `background.js`、`runtime-state.mjs` | 已由 AC-148 取代：翻译层失败现在连桥一起释放，正文不再含「原声仍在直通」 |
| AC-139 | pass | `AC-139 浏览器刚启动…`、`AC-122/AC-139 planRecovery…`、`AC-122/AC-139 顶层与钩子…` | automated-pass（实机 manual-pending） | `background.js`、`runtime-state.mjs` | 自动化覆盖顶层与 onInstalled/onStartup 零占用、planRecovery 永不返回 connect/start；macOS 橙色麦克风指示留手测 3 |
| AC-140 | deferred | 见 AC-147、AC-149 | — | `background.js`、`panel.js` | 已由 AC-147、AC-149 取代：不再有「断开会议音频」入口，关闭即释放 |
| AC-141 | pass | `AC-148 桥丢失：撤掉一切（含离屏文档）+ 通知；设备变化不会自动占用麦克风`、`AC-122 离屏长连接断开…` | automated-pass（拔插 manual-pending） | `background.js`、`offscreen.js` | 前半（bridge-lost → bridgeFailed + 撤宿主 + 通知）仍有效，离屏文档现在一并关闭；后半 devicechange 自动重试已由 AC-148 取代并删除 |
| AC-142 | pass | `AC-142/AC-101/AC-143 冷启动…`、`AC-120/AC-142 requestStart…`、`AC-127/AC-142 statusCopy 三段步骤`、`AC-119/AC-142 没有字段赋值` | automated-pass（视觉 manual-pending） | `background.js`、`runtime-state.mjs`、`panel.js` | 自动化断言发 `li:connect` 时 `startStep==='bridge'`、发 `li:start` 时 `==='translation'`、结束时为 null，且 `background.js` 无 `startStep =` 赋值；转圈观感留手测 4/8 |
| AC-143 | pass | `AC-142/AC-101/AC-143 冷启动…`、`AC-143 readyCopy…`、`AC-132/AC-144 …就绪通知静音文案`、`AC-143 li:start：每个 translate 方向都 open 且 startCapture 返回后才回 ok`、`AC-143 在途启动可作废…`、`AC-143 就绪判定…`（静态） | automated-pass（通知显示 manual-pending） | `offscreen.js`、`runtime-state.mjs`、`background.js` | readyCopy 三种形态逐字比对。就绪判定「等 open + 采集返回」首轮只有手测承诺，Review r1 补齐运行时证明：假 Web Audio + 可控 open 的假 WebSocket 下，断言 open 之前不得 startCapture、只有一个方向就绪时不得回 ok、两方向都 open 后才回 `running`，并加静态守卫（等 open 必须排在 `startCapture(` 之前）。macOS 通知实际显示仍留手测 4 |
| AC-144 | pass | `AC-144 Meet 探测脚本只读…`、`AC-144/AC-119 静音判定…`、`AC-131/AC-144 没有 tabs 权限时 sender.tab.url 被裁掉…` | automated-pass | `meet-mute.js`、`background.js` | 17 个禁用 API 逐个扫 + 上报必须接住 Promise；SW 侧的来源校验现在是 `sender.tab?.url` 与 `sender.url` 双判（见「Review round 1 修复」第 1 条），新增用例专门喂「`tab.url` 被裁掉、只剩 `tab.id` 与 `url`」的 sender 形态 |
| AC-145 | pass | `AC-145 通知只在三处发出…`、`AC-145 通知契约…`、集成测试里三处通知的 id/title/message 逐条断言 | automated-pass（macOS 显示 manual-pending） | `background.js`、`runtime-state.mjs` | 自动化确认恰好三处 `chrome.notifications.create`、id 与正文来源；macOS 通知中心实际显示留手测 4/9 |

汇总：**45 条 AC 全部有自动化证据（automated-pass）**，其中 20 条另有需要真实设备/浏览器才能确认的部分，已在 Notes 里点名对应的手测项。没有 `not-met` 或 `blocked`。

| AC-146 | pass | `AC-146 开启途中取消（第一步）…`、`（第二步）…`、`（第三步）…`、`AC-127/AC-142/AC-146 statusCopy…`、`AC-146/AC-150 开启可取消、关闭即释放…` | automated-pass（实机橙色指示 manual-pending） | `background.js`、`runtime-state.mjs`、`panel.js` | 三段步骤各自取消都立即回复 ok、回到初始、关闭离屏文档、断开未就绪的宿主端口、不发通知；迟到应答不改状态；取消后可立刻重开 |
| AC-147 | pass | `AC-147 关闭同传：…全部释放…`、`AC-147 关闭时关离屏文档必然掉 keepalive 端口…`、`AC-147/AC-149 关闭保留会议静音态…`、`AC-120/AC-147/AC-148 …终态都不留桥` | automated-pass（实机橙色指示 manual-pending） | `background.js`、`runtime-state.mjs` | 关闭后回到初始、离屏文档关闭、宿主退出、无角标、不通知；这正是用户实机发现「关闭后仍开麦」的修复 |
| AC-148 | pass | `AC-105/AC-148 宿主不可用…`、`AC-105 建桥失败…`、`AC-148 桥丢失…`、`AC-123/AC-148 翻译层掉线…`、`AC-105/AC-148 改语言时重建失败…`、`AC-122 SW 唤醒后的恢复…`、`AC-148 failureCopy…` | automated-pass | `background.js`、`runtime-state.mjs` | 翻译失败终态 bridge=disconnected、桥失败终态 bridge=failed，二者都关离屏文档、撤宿主、各一条通知；devicechange 不触发任何动作 |
| AC-149 | pass | `AC-127/AC-149 statusCopy：已关闭 / 桥失败…`、`AC-126/AC-149 面板不含被否决的入口…`、`AC-121/AC-147 badgeFor…` | automated-pass | `runtime-state.mjs`、`panel.js`、`popup.html`、`sidepanel.html` | 无断开入口、无「原声直通」文案、已关闭正文说明不占麦、未开启无角标 |
| AC-150 | pass | `AC-146/AC-150 开启可取消、关闭即释放：SW 的接线纪律`、`AC-123/AC-148 …都经 releaseAll 撤掉一切` | automated-pass（静态） | `background.js` | UI 处理器只剩两种消息；四条收尾路径都经 releaseAll；每个长等待都挂取消令牌 |

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
6. **`chrome.sidePanel.open()`** 需要用户手势。首轮实现在 `await chrome.tabs.query(...)` 之后才调用它——手势到那时已经过期；Review round 1 已改为在点击处理器里**同步**调用 `open({ windowId: chrome.windows.WINDOW_ID_CURRENT })`（见修复第 6 条，有静态守卫）。手势是否被真机接受仍未验证（手测 14）。

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

## Review round 1 修复

独立 reviewer 对 `0654130..0f5c10c` 给出 **Blocked**：1 blocker + 4 major + 5 minor。以下逐条列修法、提交与测试。`npm test`：**152 → 170 通过 / 0 失败**（新增 18 条用例，无既有断言被改动）。

| 提交 | 覆盖 |
| --- | --- |
| `dbc09d3` | blocker 1、major 3（SW 半）、major 4 + `background-flow.test.mjs` 3 条 |
| `90c2b6a` | major 2、minor 7、minor 8、major 3（离屏半）+ 新建 `offscreen-flow.test.mjs` 11 条 + `extension-static` 1 条 + `pure-functions` 1 条 |
| `8c5c6d3` | major 5、minor 6、minor 9、minor 10 + `meeting-mute` 1 条 +（静态守卫随 `extension-static` 一并在上一条提交）|

### blocker 1 — `li:meeting-mute` 的来源校验让静音路径整条失效

- 病因：`background.js` 只看 `sender.tab?.url?.startsWith(MEET_ORIGIN)`。本扩展没有 `tabs` 权限，也没有 meet 的 host permission（`content_scripts.matches` 不算），Chrome 会把 `sender.tab.url` 裁成 `undefined` → 全部上报被丢弃 → `meetingMuted` 永远 `null` → AC-131/132/143 的静音路径在实机上完全不工作。
- 修法：`if (!sender.tab?.url?.startsWith(MEET_ORIGIN) && !sender.url?.startsWith(MEET_ORIGIN)) return false`（`sender.url` 与 `sender.tab.id` 都不被裁剪；保留原字面量以满足 AC-144 静态断言），并补 `if (sender.tab?.id === undefined) return false`——按标签记账的前提，顺带避免 `sender.tab.id` 在无 tab 的上报上抛 TypeError。
- 测试：`AC-131/AC-144 没有 tabs 权限时 sender.tab.url 被裁掉，靠 sender.url 仍认得 Meet 上报`。三种 sender 形态：`{ tab: { id: 7 }, url: meet }` 必须改到 `meetingMuted`（并验证琥珀角标与 `li:set-uplink-paused{paused:true}`）；`{ tab: { id: 9 }, url: 'https://zoom.us/j/1' }` 必须忽略；`{ url: meet }`（无 tab.id）必须忽略且不抛。

### major 2 — `li:stop`/`li:disconnect` 取消不了在途启动

- 病因：`startDirection` 在 `openTranslationSession` → 等 `open` → `startCapture` 三个 await 之后**无条件**写 `live[directionId]`。`li:start` 超时（15 s）或一方向在另一方向启动途中失败后，SW 已 `phase='error'`、宿主已退，离屏却继续采集送音计费、把译文 enqueue 进会议；再次开启还会覆盖 `live[id]` 让旧会话永不 `close`。
- 修法：模块级 `epoch` + `cancelPendingStarts()`；`stopTranslation()` 与 `disconnectBridge()` 自增；`startDirection` 入口 `const mine = epoch`，**等 open 之后**（别再去占采集设备）与**写 `live` 之前**（`capture.stop()` + `session.close()`）各比一次；`startTranslation` 循环每轮开头与每次 await 之后也比，不一致即 `throw CANCELLED`（被作废的启动不得回 `ok`，否则 SW 会把早已收尾的方向标成 `running`）。
- 测试（两条路径分别有独立用例，缺任一半都会转红）：
  - `AC-143 在途启动可作废：等 open 期间收到 li:stop 后会话与采集都不得留下` —— 走 `startTranslation` 的循环检查。
  - `AC-132/AC-143 取消静音的重建也能被作废：迟到的 open 不得占走麦克风` —— 走 `startDirection` 自己的检查（`setUplinkPaused` 的重建不经 `startTranslation`，只有这两处检查能救）。断言被作废的会话 `close` 了、采集上下文数量没有增加、撤翻译层后没有任何活的采集上下文。
  - 静态守卫 `AC-143 就绪判定：startDirection 必须先等 open 再 startCapture，且在途启动可作废`。

### major 3 — 桥失败不通知离屏收尾，`li:connect` 不幂等

- 病因：`failBridge` 只撤宿主，离屏的 AudioContext、直通 stream、会话、采集全部留着跑；`failed` 态的 `devicechange` 重试再发 `li:connect` 时 `bridge.dirs = dirs` 直接覆盖旧对象，每次拔插累积一套占用。
- 修法：`failBridge` 在 `disconnectHost()` 后补 `await toOffscreen({ type: 'li:stop' }).catch(() => {})`（**不是** `li:disconnect`——spec 要求保留离屏文档继续监听 `devicechange`）；`connectBridge`（离屏侧）开头先 `disconnectBridge()` 使 `li:connect` 幂等。
- 测试：`AC-141 桥失败必须通知离屏收尾翻译层…`（断言 `offscreenCalls` 含 `li:stop`、不含 `li:disconnect`、离屏文档保留）；`AC-136 li:connect 幂等：连发两次不得叠出第二套 AudioContext 与直通 stream`（活的播放器上下文恒为 2，旧的四个对象全部 `closed`、旧 track 全部 `ended`）。

### major 4 — 「断开会议音频」被误报成桥失败

- 病因：`disconnectAll` 先 `closeDocument()` 再 `dispatch(disconnected(state))`，而关文档必然掉 keepalive 端口，其 `onDisconnect` 看到 `state.bridge === 'connected'` 就走 `failBridge` → 误落盘 `bridgeFailed`、角标闪 `!`、弹 `li-failed` 通知，违反 AC-140 与「disconnected 不通知」。
- 修法：加 `closingOffscreen` 标志，`closeDocument()` 之前置位、`dispatch(disconnected)` 之后（`finally`）复位，keepalive 的 `onDisconnect` 先判它。选这个而不是「把 dispatch 提前」，是因为它覆盖**整个**关闭窗口：真实 Chrome 里端口断开是异步送达的，可能落在 `closeDocument()` 返回之后、`dispatch` 的 await 之间。
- 测试：`AC-140 关离屏文档掉 keepalive 端口不得被误判成桥丢失：全程零通知` —— 把假 `closeDocument` 改成**同步**触发 keepalive `onDisconnect`（最坏次序），断言 `notifications` 全程为空、终态 `bridge === 'disconnected'`、`bridgeError === null`、角标为空。

### major 5 — aria 兜底会被参会者磁贴抢答

- 病因：`parseMeetMuteState` 的兜底实现成「逐按钮、`mic` 连字或 aria 任一命中即返回」。参会者行与磁贴也带 `data-is-muted`，`aria-label` 常含 microphone/麦克风/マイク/마이크——排在真麦克风按钮之前就会抢答，**远端有人静音就会静默暂停我们的上行**。
- 修法：两趟扫描。第一趟只用与界面语言无关的图标连字 `/\bmic(_off)?\b/i` 扫全部按钮；全不命中（含命中但属性不可读）才进第二趟用 aria。
- 测试：`AC-130 图标连字整表优先于 aria 兜底：参会者磁贴不得抢答真麦克风按钮` —— reviewer 给的用例（`[{dataIsMuted:'true', ariaLabel:'Zhang San microphone'}, {dataIsMuted:'false', text:'mic'}]` 必须 `=== false`）加三种语言的参会者标签，外加「图标连字一个都不命中时才轮到 aria」的反向用例。原有三条 AC-130 用例（含 aria 兜底）一字未改仍通过。

### minor 6 — `sidePanel.open` 丢用户手势

- 修法：`panel.js` 的「停靠」点击处理器改为同步调用 `chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT })?.catch(() => {})`，不再 `await chrome.tabs.query`（本扩展也没有 `tabs` 权限，那次查询拿不到 url，只为取 tabId）。
- 测试：静态守卫 `AC-128 「停靠到侧栏」必须同步调用 sidePanel.open…`：处理器内（剔除注释后）不得出现 `await`/`async`/`chrome.tabs.query`，必须用 `windowId: chrome.windows.WINDOW_ID_CURRENT`。

### minor 7 — `createPlayer` 失败时泄漏已获取的 stream

- 修法：`connectBridge` 里给 `createPlayer` 单独包 try/catch，失败时 `for (const track of stream.getTracks()) track.stop()` 再 throw（逆序收尾只认已入册的方向，这条 stream 没人接管）。
- 测试：`AC-136 createPlayer 失败：已拿到的直通 stream 必须释放，错误按媒体名归类`（让假 `setSinkId` 抛 `NotFoundError`，断言所有 track `readyState === 'ended'`）。

### minor 8 — 媒体 DOMException 被压成 `api_error`

- 修法：shared 新增 `classifyMediaError(name)`（`NotAllowedError|SecurityError → permission_denied`；`NotFoundError|OverconstrainedError|NotReadableError → device_missing`；其它 → `null`），用 `Map` 查表避免 `constructor`/`__proto__` 这类原型键误命中。离屏 `li:connect` 的收尾先经它，认出来就抛 `{ category }` 交给 `classifyError` 配中文文案。
- 影响：桥失败通知不再自相矛盾（原本会说「翻译服务返回了错误」），且 `device_missing` 才触发的 `devicechange` 一次重试现在真的会发生。
- 测试：`AC-141/AC-105 classifyMediaError：媒体 DOMException 先按名字归类…`（五个名字、十种认不出的输入、归类结果必须在 `CATEGORIES` 内且能被 `classifyError` 原样接住）+ 上面那条集成用例断言 `error.category === 'device_missing'`。

### minor 9 — 探测脚本每次上报都留 unhandled rejection

- 修法：`chrome.runtime.sendMessage(...)` 追加 `?.catch(() => {})`（SW 不 `sendResponse`）。保持单行，`chrome.runtime.sendMessage` 字面量不变以满足 AC-144 静态断言。
- 测试：`AC-144 Meet 探测脚本只读…` 追加一条断言（上报必须接住返回的 Promise）。

### minor 10 — 衬底在上下文时钟头 0.7 s 里误判「正在播译文」（修了效果，没动 `playhead = 0`）

- 病因确认：`flush()` 把 `playhead` 归零后，`isTranslating({ now: ctx.currentTime, playhead: 0, releaseMs: 700 })` 在 `ctx.currentTime < 0.7` 时为真。`attachFloor()` 也调 `scheduleFloor()`，所以**刚建好的直通在头 0.7 s 里就被无故压低**——比 reviewer 描述的 flush 场景更常见。
- 与 reviewer 建议的差别：reviewer 建议把 `playhead` 改成 `ctx.currentTime - FLOOR_RELEASE_MS / 1000` 或 `-Infinity`。**没有采用**，因为 spec Implementation Notes 的「衬底」一行字面写着 `flush()` 清源、`playhead = 0`、`scheduleFloor()`，AC-133 的静态检查也明文要求「`playhead` 归零」，而 `player-static.test.mjs`（spec Compatibility 清单内的遗留文件）已据此断言 `/playhead = 0/`——照建议改会同时违反 spec、AC-133 与「不得为迁就代码改既有测试断言」三条。
- 实际修法：`playhead = 0` 保留，另加一面只表达「队列里有过译文」的旗子 `queued`（`enqueue` 置真、`flush` 置假），`scheduleFloor` 用 `queued && isTranslating(...)` 求 `translating`。目标增益仍然只来自 `floorTarget`/`isTranslating`，AC-137 的「队列播完且经过 700 ms 后才恢复」一字未变（释放窗口内 `queued` 仍为真）。没有用 `scheduled.size > 0` 代替，因为源自然播完时 `onended` 就把它清空了，会让释放窗口内的 `setFloorLevel` 提前恢复。
- 测试：`AC-137 衬底不得在上下文时钟头 0.7 s 里误判「正在播译文」`（`attachFloor` 之后增益必须是 1；喂一帧译文后必须压低；在 `currentTime < 0.7` 的前提下 `li:stop` 后必须立即回 1.0）。另外 `AC-136 li:connect…` 与 `AC-110 passthrough…` 也都断言了「直通恒为 1.0」，变异时一并转红。

### 新增测试清单（18 条）

| 文件 | 用例 | 对应修复 |
| --- | --- | --- |
| `tests/integration/offscreen-flow.test.mjs`（新建，11 条） | `AC-136 li:connect：两方向各一条直通路…` | 基线覆盖（约束分角色、sinkId、直通图、建桥不采集） |
| | `AC-136 li:connect 幂等…` | major 3 |
| | `AC-136 createPlayer 失败：已拿到的直通 stream 必须释放…` | minor 7 + minor 8 |
| | `AC-143 li:start：每个 translate 方向都 open 且 startCapture 返回后才回 ok` | AC-143 第一句（reviewer 点名的缺口） |
| | `AC-143 在途启动可作废：等 open 期间收到 li:stop…` | major 2（循环半） |
| | `AC-132/AC-143 取消静音的重建也能被作废…` | major 2（`startDirection` 半） |
| | `AC-131 li:set-uplink-paused：只掐上行，下行对象引用与数据流不受影响` | AC-131 离屏侧（门控、flush、holdFloorFull、下行不受影响） |
| | `AC-137 衬底不得在上下文时钟头 0.7 s 里误判「正在播译文」` | minor 10 |
| | `AC-110 passthrough 方向：不建会话、不采集、直通恒为 1.0` | AC-110 运行时证据 |
| | `AC-133 直通 track 被系统结束 → 上报 bridge-lost；devicechange 只上报不自作主张` | AC-133/AC-141 离屏侧 |
| | `AC-140 li:disconnect：撤翻译层后停全部播放器与直通 track` | AC-140 离屏侧 |
| `tests/integration/background-flow.test.mjs`（+3） | `AC-131/AC-144 没有 tabs 权限时 sender.tab.url 被裁掉…` | blocker 1 |
| | `AC-141 桥失败必须通知离屏收尾翻译层…` | major 3 |
| | `AC-140 关离屏文档掉 keepalive 端口不得被误判成桥丢失…` | major 4 |
| `tests/unit/extension-static.test.mjs`（+2，另 2 条既有用例各加断言） | `AC-143 就绪判定：startDirection 必须先等 open 再 startCapture…` | major 2 + major 3 静态守卫 |
| | `AC-128 「停靠到侧栏」必须同步调用 sidePanel.open…` | minor 6 |
| | `AC-144 Meet 探测脚本只读…` 追加「上报必须接住 Promise」 | minor 9 |
| `tests/unit/meeting-mute.test.mjs`（+1） | `AC-130 图标连字整表优先于 aria 兜底…` | major 5 |
| `tests/unit/pure-functions.test.mjs`（+1） | `AC-141/AC-105 classifyMediaError…` | minor 8 |

### 本轮的测试有效性抽查（定点变异）

每条修法都单独回退过一次源码，确认**有且仅有**对应用例转红：

| 回退的修法 | 转红的用例 |
| --- | --- |
| 去掉 `sender.url` 兜底 | `AC-131/AC-144 没有 tabs 权限时…` |
| `failBridge` 不发 `li:stop` | `AC-141 桥失败必须通知离屏收尾翻译层…` |
| 去掉 `closingOffscreen` 守卫 | `AC-140 关离屏文档掉 keepalive 端口…` |
| 去掉 `startDirection` 的两处世代号比对 | `AC-132/AC-143 取消静音的重建也能被作废…` |
| 去掉 `startTranslation` 循环里的两处比对 | `AC-143 在途启动可作废…` |
| `connectBridge` 不先 `disconnectBridge()` | `AC-136 li:connect 幂等…` |
| `createPlayer` 失败不停 track | `AC-136 createPlayer 失败…` |
| 不按 DOMException 名字归类 | `AC-136 createPlayer 失败…` |
| `audio.js` 去掉 `queued` 守卫 | `AC-136 li:connect…`、`AC-137 衬底不得误判…`、`AC-110 passthrough…` |
| `parseMeetMuteState` 退回单趟混合匹配 | `AC-130 图标连字整表优先…` |
| `panel.js` 退回 `await chrome.tabs.query` | `AC-128 「停靠到侧栏」…` |
| `meet-mute.js` 去掉 `.catch` | `AC-144 Meet 探测脚本只读…` |

### 本轮仍未做的事

- `offscreen-flow.test.mjs` 用的是假 Web Audio / 假 mediaDevices / 假 WebSocket。它证明的是**接线与生命周期**，不证明真实设备行为：同一麦克风两次 `getUserMedia` 能否并存、`setSinkId(BlackHole 16ch)` 是否真的生效、ramp 听感与爆音、端到端延迟——全部仍留给实机手测（清单 1～14 未执行）。
- `npm run e2e:real` 仍未运行（会产生真实 API 费用）。
- Meet 真实 DOM 的选择器仍未在会议页确认。major 5 修的是「兜底顺序」，不是「选择器正确」；`data-is-muted` 与 `mic`/`mic_off` 连字依旧是未验证假设（风险 1 不变）。

## Review round 2 修复

第二轮独立 review 结论 **Ready with nits**：无 blocker / major，留下 2 个 P2 资源泄漏。两条都修了并各补一条集成用例。`npm test`：**170 → 172 通过 / 0 失败**（新增 2 条用例、给既有用例追加 1 条断言，无既有断言被改动，不动 spec 四份文档的契约）。

### P2-1 — `updatePlan` 的重启循环不受 `epoch` 守卫

- 病因：`startDirection` 的世代号快照 `const mine = epoch` 取在**它自己的入口**，所以 `updatePlan` 多轮循环的第二轮拿到的是已递增后的 epoch，`li:stop` 对它完全失效。触发：`phase = on` 时一条 `li:set-settings { hear, partnerHears }` 让 `diffPlan` 返回两个方向，第一轮 `await startDirection('downlink')` 还在等 `open` 时 `li:stop` 到达（用户改完语言立刻点「关闭同传」，或 `failBridge` / `failTranslation`）。后果：`li:stop` 之后仍起一条无人管的会话 + 一路 24 kHz 采集（占着麦克风、real 后端照样按送入时长计费、译文可能进会议），并且把早已收尾的方向回报成 `restarted` → SW 按 `response.restarted` 把它标成 `running`。
- 修法：`updatePlan` 开头取 `const mine = epoch`（只有 `stopTranslation` / `disconnectBridge` 自增 epoch，`stopDirection` 不自增，所以这个快照跨轮有效）；循环每轮开头 `if (mine !== epoch) break`，每轮 `await startDirection(id)` 之后再比一次，只有比对通过的方向才 `restarted.push(id)`，返回值从 `changed` 改成 `restarted`。
- 同一处的另一半：`setUplinkPaused` 的按需重建改成只在 `live.uplink !== null`（重建真的落地）时 `restarted.push('uplink')`。原来无条件 push，重建在途被作废时会让 SW 把一条不存在的上行标成 `running` 并发 `uplink-resumed`。
- 测试：新增 `AC-109/AC-143 li:update-plan 两方向同改：第一轮在途时 li:stop 必须作废后续轮次`（两方向同时改成 `hear: 'ja'` / `partnerHears: 'fr'` → 第一轮卡在等 `open` → `li:stop` → 放行迟到的 `open`）。断言：会话总数仍为 3（被作废的第二轮不得再建）、三条会话全部 `closedTimes === 1`、活的采集上下文为 0、`restarted` 深等于 `[]`、桥的两个播放器仍然活着。另给既有用例 `AC-132/AC-143 取消静音的重建也能被作废` **追加**一条断言：`restarted` 深等于 `[]`（该用例原先只断言调用已 settle，没看返回值）。

### P2-2 — 重叠的 `li:connect` 孤立一整套桥

- 病因：`connectBridge` 在 `enumerateAudioDevices` / `getUserMedia` / `createPlayer` 三个 await 之后**无条件**写 `bridge.roles/labels/dirs`；头部的 `disconnectBridge()` 只认已入册的上一套，对在途那一套无效。触发：第一次 `li:connect` 卡在没人应答的授权弹窗里 → SW 10 s 超时 `failBridge` 放弃那个 Promise（并发 `li:stop`）→ 用户再点开启，`li:connect#2` 成功写入 `bridge.dirs` → 随后 #1 的 `getUserMedia` 才返回，用自己的 `dirs` 覆盖。后果：两套桥同时活（同一输入混进同一输出两次），被覆盖那套的 2 个 AudioContext 与 2 条直通 track 连 `li:disconnect` 都够不到，永久占着麦克风与虚拟声卡。
- 修法：`connectBridge` 在头部 `disconnectBridge()` 之后取 `const mine = epoch`（确认过：`disconnectBridge` 本身就 `cancelPendingStarts()` 自增，所以「第二次 `li:connect`」与「`failBridge` 的 `li:stop`」两条路径都会作废在途那次，无需补自增）；入册（写 `bridge.dirs`）前 `if (mine !== epoch) throw CANCELLED`，由既有的逆序收尾把本次建好的方向全部停掉，并以取消错误返回。
- SW 侧不会因此多出通知：`withTimeout` 早已给那个 Promise 挂了拒绝处理器（超时后的 `reject` 是空操作），`connectBridge` 的 `catch` 也早已跑完（`bridge = failed` 且通知已发），迟到的 `{ ok: false }` 没有第二个 `await` 接它。
- 测试：新增 `AC-136/AC-140 重叠的 li:connect：迟到的那套必须自己收尾，不得覆盖已建好的桥`。假 `mediaDevices` 加了 `holdNextGetUserMedia()`（卡住下一次 `getUserMedia` 的可控 Promise）：第一次 `li:connect` 卡住（断言此时一个播放器都没有）→ `li:stop` → 第二次成功（2 个活上下文）→ 放行第一次，断言它回 `ok: false`、活的 AudioContext 仍为 2、活的直通 track 仍为 2；再 `li:disconnect`，断言两者都归 0——被覆盖的那套正是 `li:disconnect` 够不到的那套。

### 本轮的测试有效性抽查（定点变异）

| 回退的修法 | 转红的用例 |
| --- | --- |
| `connectBridge` 去掉入册前的世代号比对 | `AC-136/AC-140 重叠的 li:connect…` |
| `updatePlan` 去掉 `await startDirection` 之后的比对 | `AC-109/AC-143 li:update-plan 两方向同改…` |
| `setUplinkPaused` 无条件 `restarted.push('uplink')` | `AC-132/AC-143 取消静音的重建也能被作废…` |
| `updatePlan` 去掉循环轮首的 `break` | **无用例转红**（见下） |
| 逆序收尾里新加的 `track.stop()` | **无用例转红**（见下） |

两条「无用例转红」如实记录，不当成已验证：

- `updatePlan` 轮首的 `break` 与 `await` 之后的 `break` 之间没有 await，所以轮首那次比对今天永远不可能为真。留着是为了与上面 `startTranslation` 的「每轮开头与每次 await 之后都确认」写法一致，并防住以后在 `stopDirection` 前插入 await；真正起作用、也真被用例 falsify 的是 `await` 之后那次。
- 逆序收尾里补的 `for (const track of entry.floorStream.getTracks()) track.stop()` 在正常路径上是冗余的：`player.stop()` 自己就会停掉 `attachFloor` 记下的 `floorTracks`（所以新用例「活 track 为 2」那条断言在没有这一行时也成立）。它只覆盖「`attachFloor` 抛了异常（被它自己吞进 `onPlaybackError`，`floorTracks` 留空）而该方向仍被入册」这条缝，与 `disconnectBridge` 里 `player.stop()` + 显式停 track 的既有写法同理。

### reviewer 的可选建议（未做）

- 建议 `panel.js` 在模块加载时 `chrome.windows.getCurrent()` 缓存 `windowId`、点击处理器同步用缓存值调用 `chrome.sidePanel.open({ windowId })`。**未做**：`tests/unit/extension-static.test.mjs` 的 `AC-128 「停靠到侧栏」必须同步调用 sidePanel.open…` 里有一条既有断言 `assert.ok(/windowId: chrome\.windows\.WINDOW_ID_CURRENT/.test(dock))`，照建议改必须改掉它，与本轮「既有断言不改」的约束直接冲突（建议本身也只是 SHOULD 级的稳妥性改进，不是缺陷）。现状用 `WINDOW_ID_CURRENT` 哨兵，不丢用户手势、不需要额外权限；哨兵能否被 `sidePanel.open` 接受仍留实机手测确认（Remaining Work 里已有「点『停靠』能打开侧栏」这一项）。

## 实机反馈修改（2026-09-10）

用户在真实 Chrome 里加载扩展、开启一次（real 后端，宿主日志显示冷启动 6 ms、会话 22 s）后提出两点：

1. **开启中不能取消**：开启要走三步，按钮全程禁用。改为开启中主按钮是可点的「取消开启」（描边、带转圈、步骤文案照常）。
2. **关闭后麦克风仍在用**：原设计「关闭同传只撤翻译、音频桥保留直通」让 macOS 橙色麦克风指示在关闭后仍亮着。用户明确要求关闭即不开麦，于是关闭、取消、任何失败都撤掉宿主、翻译层、桥与离屏文档。随之取消「断开会议音频」入口、「原声直通中」状态与 devicechange 自动重连（后者会在非开启状态下重新占麦）。

**代价（已写进选项页与 README）**：关闭后插件不再转送任何声音；会议里的麦克风若仍选着 BlackHole 16ch，对方听不到你。

### 改动

| 文件 | 改动 |
| --- | --- |
| `src/shared/runtime-state.mjs` | `stopped`、`failed` 的终态不留桥；`planRecovery` 对任何半启动都按失败收尾；`statusCopy` 返回按钮 `action/variant/spinner/lockFields`，去掉 `secondary`；文案去掉断开与原声直通 |
| `src/extension/background.js` | 新增 `releaseAll`（撤宿主 → `li:disconnect` → 关离屏文档 → 在关文档窗口内落终态）；新增 `cancelStart` 与开启取消令牌（`beginStart`、`checkpoint`、`withTimeout(…, run)`）；未就绪的宿主端口也能断开；删除 `li:disconnect` UI 处理、`disconnectAll`、devicechange 重试 |
| `src/extension/panel.js`、`popup.html`、`sidepanel.html`、`panel.css` | 主按钮按 `copy.action` 发消息（取消与关闭都是 `li:power {on:false}`）；去掉断开链接 |
| `src/extension/options.html` | 说明关闭即释放麦克风，以及关闭后对方听不到你的条件 |
| 测试 | `runtime-state.test.mjs`、`background-flow.test.mjs`（新增三条取消用例，改写关闭/失败用例）、`extension-static.test.mjs`（新增 AC-146/AC-150 接线纪律） |

### 验证

| Check | Command / Method | Result |
| --- | --- | --- |
| 全量测试 | `npm test` | 174 / 174 通过 |
| 定点变异 | 取消改回 busy / 宿主等待不挂取消令牌 / 不断开未就绪宿主端口 / 被取消的开启走失败流程 / 关闭不关离屏文档 | 各自让对应用例转红（1、1、1、3、10 条） |
| 构建 | `npm run build:ext` | 通过，`dist/extension` 已更新 |
| 实机 | 关闭后橙色麦克风指示消失；三段步骤任一处取消 | 待用户在 `chrome://extensions` 点扩展卡片的刷新后验证 |

## Blockers

None（无阻塞项）。

## Remaining Work

- 按上面的清单做实机手测（1～14 + 真实后端），把结果与冷启动耗时、直通延迟、衬底体感、Meet 选择器实测追加到本日志。
- 13 个语言码逐一实测；若有被拒的码，改 `src/shared/languages.mjs` 并更新 README 的语言列表。
- 若手测发现 `flush()` 后 stop 爆音，按默认值改成 5 ms 淡出（只动 `audio.js`）。
- 手测时额外确认本轮修复的实机表现：Meet 静音真的能被感知到（blocker 1，首轮实现在实机上这条路径完全不通）；「断开会议音频」不再闪 `!` 也不弹通知（major 4）；拔插耳机反复几次后 `chrome://webrtc-internals` 里没有累积的 getUserMedia 会话（major 3）；点「停靠」能打开侧栏（minor 6）。
- 手测时确认 Review round 2 的两条修复：两个语言一起改完立刻点「关闭同传」后，`chrome://webrtc-internals` 里没有残留会话、BlackHole 16ch 录不到译文（P2-1）；第一次「开启同传」时把麦克风授权弹窗挂住到超时、再点一次开启成功后放掉弹窗，确认麦克风占用与 AudioContext 只有一套、「断开会议音频」后 macOS 橙色指示消失（P2-2）。
