# Feasibility Study: 同传插件化 — 音频管道放哪、本地服务怎么拉起、原声与静音怎么处理

## Engineer Reading Guide

实现者读 `Summary`、`Recommendation`、`Validation Plan`、`Open Questions`，然后以 `./2-tech-spec.md` 为实现真值。选项对比只在复议方案时读。

## Summary

要把网页版同传改成「点扩展图标 → 弹窗 → 一键开启」的 Chrome 扩展，有四个先定的决策：(1) 音频管道在扩展的哪个上下文里跑；(2) 「开启 = 冷启动本地 node 翻译进程，关闭即结束」怎么实现；(3) 会议的扬声器与麦克风都指向 BlackHole，插件关闭同传后、翻译失败时，会议音频怎么不断声；(4) 用户在 Meet 里点静音时，插件怎么知道并停止翻译他的话。推荐：管道跑在 MV3 离屏文档里由 service worker 编排；本地 Node 服务改造成 Native Messaging 宿主，只在同传开启期间存活，开启时冷启动、分步转圈、就绪后系统通知；插件连接后成为一座音频桥——原声永远是底，翻译叠在上面（翻译播放时原声压低，停顿即恢复），关闭同传只撤翻译、桥不动；用一个只读的 Meet 页面探测脚本读取会议静音态，静音时暂停翻译用户的话、继续翻译对方。不自动连接，只有用户主动「开启同传」才连。语言能力以 OpenAI 文档为准：输入 70+ 种自动识别、输出 13 种。网页版不再保留。

> **2026-09-10 实机反馈后调整**：音频桥不再「关闭后保留」，只随同传存在；关闭、取消、失败都释放麦克风。下文「关闭同传只撤翻译、桥保留」「设备插回自动重试」的表述以此为准失效。

## Decision Needed

2026-09-10 用户审批：下表默认值全部采纳；另决定不保留「只连接原声」入口（需要桥就直接开启同传），失败也弹系统通知。

| Question | Why It Matters | Default / Owner |
| --- | --- | --- |
| 音频管道宿主：离屏文档 vs 常驻扩展页/侧栏 | 弹窗关闭后管道必须继续 | 离屏文档 / 用户审批 |
| 本地服务拉起方式：Native Messaging 宿主 vs 手动 `npm start` vs key 放进扩展 | 一键体验、冷启动、密钥边界 | Native Messaging 宿主 / 用户审批 |
| 原声怎么处理：音频桥 + 衬底压低 vs 只在关闭时直通 vs 不处理 | 关闭同传后会议是否正常、同语言片段是否无声 | 音频桥 + 衬底 25% / 用户已同意 |
| 会议静音怎么感知：只读 Meet 页面探测脚本 vs 插件自带静音按钮 vs 语音活动检测 vs 不感知 | 用户的静音就是 Meet 的静音；静音后继续翻译既浪费又把旁边的谈话送去了翻译服务 | 只读探测脚本（仅 Meet，新增一项站点匹配）/ 用户审批 |
| 连接时机：用户「开启同传」时冷启动 vs 浏览器启动自动连接 | 麦克风占用观感、用户控制感 | 不自动连接 / 用户已决定 |

## Background

现网页版要用户先到 `localhost:5173` 手动核对四个设备角色、分别点「启动下行」「启动上行」「解除静音」。用户目标：会议里点右上角扩展图标、弹出面板、点「开启同传」即可；开启时服务冷启动、界面转圈，就绪后明确告知；在 Meet 里点了静音就不要再翻译自己的话但对方的话继续翻；在插件里点关闭才是真正关闭，此时对方原声进耳机、自己的声音不再经翻译。现有路由方案把会议的扬声器指向 BlackHole 2ch、麦克风指向 BlackHole 16ch，所以只要插件不在搬运音频，会议就既无声也无麦——「关闭同传后会议照常」必须靠插件继续搬运原声来满足。

## Evidence Checked

| Area | Finding | Source |
| --- | --- | --- |
| Code / current flow | 网页控制器已是「预检 → 端点 → 播放器 → 会话 → 采集」纯接线；`audio.js` / `session.js` 不依赖页面 DOM，可整体迁入扩展 | `src/web/app.js`、`src/web/audio.js`、`src/web/session.js` |
| Code / current flow | 判定逻辑全部在 `src/shared/`，被 `shared-purity` 强制无环境耦合 | `src/shared/*.mjs` |
| Code / current flow | `createServer` 可编程创建、端口可传 0；`OPENAI_API_KEY` 只在服务端；静态托管与 `/api/config` 只服务网页版 | `src/server/index.mjs` |
| Code / current flow | 现代码只向 API 发输出语言，从未指定输入语言；真实 e2e 英语进中文出 | `src/shared/session-protocol.mjs`、`tools/e2e-real.mjs` |
| Code / current flow | 预检已拒绝 monitor/mic 使用 BlackHole 或多输出/聚合设备，音频桥直通复用同一规则即不成回环；`forwardMicAudio({ muted })` 已实现「静音时绝不调用 sink」 | `src/shared/device-preflight.mjs`、`src/shared/audio-routing.mjs` |
| Upstream / external | gpt-realtime-translate「automatically detects the source language」，70+ 输入；13 种输出；`session.audio.output.language`；「one translation session for each target language」 | OpenAI Cookbook「Build Live Translation Apps with gpt-realtime-translate」、Live Translation guide |
| Upstream / external | 「tries not to translate speech that is already in the selected output language … may not produce translated audio」；官方建议「keep the original audio available」并「duck the original audio while translated audio is playing」 | 同上 |
| Upstream / external | 输入 24 kHz PCM16 持续 append；$0.034/分钟音频（按送入时长计费，静音期间持续送入也计费）；未说明会话时长上限 | 同上、模型页 |
| Upstream / external | 离屏文档只支持 `chrome.runtime`；`USER_MEDIA` reason 无寿命限制；`getContexts` 需 Chrome 116+ | developer.chrome.com offscreen 文档 |
| Upstream / external | SW 空闲 30 秒终止；`connectNative` 端口与长连接消息维持 SW 存活 | developer.chrome.com lifecycle 文档 |
| Upstream / external | Native Messaging：4 字节长度前缀 + JSON；宿主随端口生灭；stdout 只写协议；cwd 为二进制目录；单帧 ≤ 1 MB | developer.chrome.com native-messaging 文档 |
| Upstream / external | 扩展无法读取其它标签页的 DOM 或媒体轨道状态；感知 Meet 静音只能靠 `content_scripts`（`matches` 即授予注入权，不需额外 `host_permissions`）；`chrome.notifications` 需 `notifications` 权限 | Chrome 扩展权限模型 |
| Upstream / external | Google Meet 麦克风/摄像头按钮带 `data-is-muted` 属性，图标为 Material 连字文本（`mic` / `mic_off`），与界面语言无关——第三方 Meet 扩展长期依赖此结构 | 社区扩展源码经验，需在当前 Meet DOM 上验证 |
| Web Audio | 同一 `AudioContext` 内 `MediaStreamSource → GainNode → destination` 直通约 10–30 ms，可与 `BufferSource` 译文混音；增益用 `linearRampToValueAtTime` 平滑 | Web Audio 规范，spike 验证 |
| Local environment | Chrome 152；BlackHole 2ch/16ch 已装；本机已有 3 个第三方 Native Messaging 宿主 | `defaults read`、`system_profiler`、目录列表 |

## Constraints

| Constraint | Detail | Hard / Soft |
| --- | --- | --- |
| 密钥边界 | `OPENAI_API_KEY` 不得进入浏览器 | hard |
| 对会议透明 | 不入会、不装 bot、不改会议页面 DOM、不注入 UI、不碰会议页面的媒体轨道；唯一例外是只读地读取 Meet 麦克风按钮的静音态 | hard |
| 平台 | macOS + Chromium（BlackHole、`setSinkId`） | hard |
| 语言能力 | 输出 13 种；输入自动识别；同语言片段无译文音频 | hard（上游） |
| 会议不断声 | 桥已连接时，任何插件状态下都不得让会议无声无麦（用户主动「断开」除外） | hard（产品） |
| 用户控制 | 不自动连接；只有用户点「开启同传」才占用麦克风与设备 | hard（用户决定） |
| 静音感知范围 | 只有 Google Meet 网页可被感知；其它平台视为「未知」，不暂停 | soft（明示） |
| 无构建链 | 零打包器、零新依赖 | soft |

## Option Comparison

管道宿主：

| Option | Description | Pros | Cons / Risks | Unknowns | Verdict |
| --- | --- | --- | --- | --- | --- |
| A: 离屏文档 | SW 创建 `offscreen.html`，管道（含音频桥）在其中运行 | 官方音频宿主；弹窗关了也活；无寿命限制 | 只能用 `chrome.runtime`；授权需先在可见页完成 | 无手势时 AudioContext 能否 running | **recommend** |
| B: 侧栏/扩展标签页当宿主 | 管道跑在 side panel 或标签页 | 改动最小 | 关闭即中断 | 无 | reject |
| C: SW 直接跑 | 无 | 无 | SW 无 DOM | 无 | reject |

本地服务拉起：

| Option | Description | Pros | Cons / Risks | Unknowns | Verdict |
| --- | --- | --- | --- | --- | --- |
| A: Native Messaging 宿主 | 宿主随 `connectNative` 端口启动、随端口断开退出；只在同传开启期间存在，开启即冷启动 | 精确等于用户意图；key 留在 Node；无孤儿 | 一次性安装 + 固定扩展 ID；wrapper 写死 node 路径 | 无 | **recommend** |
| B: 用户手动 `npm start` | 扩展只是 UI | 零安装 | 违背一键 | 无 | reject |
| C: key 放进扩展 | 直连 OpenAI | 零本地进程 | 破坏密钥边界 | 无 | reject |

原声处理：

| Option | Description | Pros | Cons / Risks | Unknowns | Verdict |
| --- | --- | --- | --- | --- | --- |
| A: 音频桥 + 衬底压低 | 开启同传时一并建桥；两方向原声直通；翻译播放时原声压到 25%（可 0/50%），停顿 ≥ 0.7 s 回 100%；关闭同传只撤翻译 | 关闭后会议照常；同语言片段听到原声；翻译失败不影响会议；官方建议做法 | 翻译时同时听到压低的原声；每句开头 1–2 s 原声未压低 | 压低比例体感 | **recommend（用户已同意 25%）** |
| B: 只在关闭时直通，翻译时只放译文 | 同 A 但 `floorLevel` 恒 0 | 翻译时干净 | 同语言片段与停顿无声 | 无 | consider（= A 的 0% 档，且 A 规定停顿恢复原声） |
| C: 关闭即撤设备 | 现状 | 最简单 | 关闭后会议无声无麦 | 无 | reject |

会议静音感知：

| Option | Description | Pros | Cons / Risks | Unknowns | Verdict |
| --- | --- | --- | --- | --- | --- |
| A: 只读 Meet 探测脚本 | `content_scripts` 匹配 `https://meet.google.com/*`，只读麦克风按钮 `data-is-muted`，变化即上报；不写 DOM、不注入 UI | 精确对应用户的静音动作；静音时麦克风音频不再送翻译服务（省钱且不泄露旁边谈话）；探测失败自动退化为「未知 = 不暂停」 | 新增一项站点匹配（安装时提示可读取 meet.google.com 数据）；依赖 Meet DOM，可能随改版失效；只覆盖 Meet 网页 | 当前 Meet DOM 是否仍有 `data-is-muted` | **recommend** |
| B: 插件自带静音按钮 | 面板上独立按钮 | 平台无关 | 用户明确说静音用的是 Meet 的按钮，不会再点插件；两套静音易混 | 无 | reject |
| C: 语音活动检测 | 只在检测到说话时送音频 | 平台无关；听别人说话时也省钱 | 不能区分「静音时和旁人说话」；改变送音节奏可能影响模型断句 | 模型对断续送音的容忍度 | consider（后续成本优化） |
| D: 不感知 | 静音时继续翻译 | 零实现 | 浪费；静音期间旁边的谈话仍被送去翻译 | 无 | reject |

## Recommendation

推荐 **离屏文档宿主 + Native Messaging 冷启动宿主 + 音频桥与衬底 + 只读 Meet 静音探测 + 不自动连接**。

- 连接只发生在用户点「开启同传」时：冷启动分三步（连接会议音频 → 启动本地翻译服务 → 连接翻译服务）转圈，全部就绪后弹系统通知「同传已就绪」并写明两方向将如何翻译。
- 关闭同传只撤翻译与宿主，桥保留：对方原声进耳机、自己原声进会议，零费用；桥随浏览器关闭或用户「断开」释放。
- Meet 里静音 → 探测脚本上报 → 暂停翻译用户的话（不送音频、丢弃并清空译文、原声保持），对方的翻译继续；取消静音即恢复。非 Meet 平台无法感知，文案明示。
- 语言按上游真实能力：输入不选，输出 13 种 + 原声。
- 现有 `audio.js` / `session.js` / `src/shared` 小改动复用；网页版与其专用测试移除。

## Decision Risks

| Risk | Why It Matters | Mitigation / Decision |
| --- | --- | --- |
| Meet 改版导致探测失效 | 静音不再被感知 | 探测失败上报「未知」→ 不暂停（退化为现状）；弹窗显示「未感知到会议静音」；探测规则集中在一个小文件便于更新 |
| 安装时出现「可读取 meet.google.com 数据」提示 | 用户观感 | README 说明脚本只读麦克风按钮静音态；静态测试禁止 DOM 写入与网络访问 |
| 离屏文档里 AudioContext 自动播放策略 | 全方案失效 | 开发前 spike；失败回退方案 B 复议 |
| 每句开头 1–2 s 原声未压低 | 对方先听到一段原声 | 上游延迟所致；文案说明 |
| 外放扬声器时回声进会议 | 对方听到回声 | 真麦克风直通路开 AEC/NS；README 建议耳机 |
| 13 个语言码个别不被接受 | 下拉坏项 | 开发前逐码验证 |

## Validation Plan

开发进入扩展骨架（实施计划 Chunk 4）前必须完成：

- [ ] Spike：离屏文档中 `new AudioContext()` + `setSinkId(BlackHole 16ch)` 无手势能否 `running`，同一 ctx 内直通与 `BufferSource` 提示音同时出声、增益 ramp 无爆音。
- [ ] Spike：选项页授权后，离屏文档 `getUserMedia({deviceId:{exact}})` 免提示；同一设备两次 getUserMedia（直通 + 24k 采集）并存。
- [ ] Spike：从 Dock 启动的 Chrome 里 `connectNative` 能拉起 wrapper 并收到 `ready`；记录冷启动到 `ready` 的耗时。
- [ ] Meet DOM：在真实会议页确认麦克风按钮的 `data-is-muted` 属性与 `mic`/`mic_off` 图标连字，点静音/取消静音属性随之变化；记录选择器。
- [ ] `chrome.notifications` 在 macOS 上的显示效果与权限提示。
- [ ] 直通延迟（目标 < 50 ms）与外放回声实测。
- [ ] 13 个输出语言码逐一 `session.update` 无 `error`。
- [ ] 真实 e2e：英语音频 + 输出 `en`，确认模型不出声且衬底恢复原声。

## Follow-up Documents

- Requirements: `./1-requirements.md`
- Tech spec: `./2-tech-spec.md`
- Implementation plan: `./4-implementation-plan.md`

## Open Questions

| Question | Default If Unanswered | Impact |
| --- | --- | --- |
| 是否支持 Edge | 只保证 Chrome；安装脚本支持 `--browser edge` | 无代码差异 |
