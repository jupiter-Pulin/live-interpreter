# live-interpreter

macOS 本地实时会议同传：BlackHole 音频路由 + OpenAI `gpt-realtime-translate` 双向翻译，装成 Chrome 扩展。对会议软件（Zoom / Meet / Teams）完全透明，不入会、不装 bot。

- **下行**：会议 app 输出 → BlackHole 截获 → 翻成你想听的语言 → 你的耳机
- **上行**：你的真麦克风 → 翻成对方听的语言 → 第二块 BlackHole（虚拟麦克风）→ 会议对方
- **原声是底，翻译是顶**：连上之后两个方向的原声一直直通；翻译播放时原声压低，停顿即恢复，任何状态都不会无声。

## 环境要求

- macOS + **Chrome ≥ 116**（把译文输出到指定设备依赖 `AudioContext.setSinkId`，且扩展用到离屏文档与侧栏）。
- Node **>= 22**（依赖内置全局 `WebSocket` 与 `node --test`）。
- 首次运行需联网安装依赖（`ws` 包）；离线环境请先在联网时执行一次 `npm install`。
- **建议戴耳机**：外放时你的麦克风会把对方的声音再送回会议，容易产生回声。

## 安装与音频路由配置

1. **安装两块 BlackHole**（虚拟声卡，需手动安装）：
   - [BlackHole 2ch](https://existential.audio/blackhole/) —— 用作 `capture`（截获会议声音）
   - BlackHole 16ch —— 用作 `virtualMic`（虚拟麦克风）
   - 两个通道数变体安装后在系统中是**两块独立设备**，缺一不可。
2. **创建多输出设备**（让会议声音既进 BlackHole 又能被系统播出）：
   打开「音频 MIDI 设置」→ 左下 `+` → 「创建多输出设备」→ 勾选 **BlackHole 2ch**（可另勾内置扬声器方便调试）。
3. **会议 app 侧设置**：
   - 扬声器/输出设备 → 选刚建的**多输出设备**（或直接选 BlackHole 2ch）
   - 麦克风/输入设备 → 选 **BlackHole 16ch**
4. **开发期不用真会议**：用 QuickTime 等系统播放器回放一段英语音频（可用 `say -o fixtures/sample-en.wav --data-format=LEF32@22050 "Hello, this is a test."` 生成），声音经多输出设备灌入 BlackHole 2ch，即等价于会议对方在说话。

## 浏览器插件

### 安装

```bash
npm install          # 首次
npm run build:ext    # 产出 dist/extension
npm run install:host # 注册本地翻译服务（Native Messaging 宿主）
```

1. 打开 `chrome://extensions` → 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/extension`。
2. 安装时 Chrome 会提示扩展可以「读取你在 meet.google.com 上的数据」。这条提示来自唯一的一个内容脚本：它**只读** Google Meet 麦克风按钮的 `data-is-muted` 属性，用来知道你有没有在会议里静音。它不修改页面、不注入任何界面、不访问网络、不碰媒体设备（`tests/unit/extension-static.test.mjs` 里有静态检查钉住这条）。
3. `npm run install:host` 会在 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` 写一个 manifest，指向 `dist/native-host/host.sh`。**升级 Node 之后要重跑一次**（脚本里写死了当前 node 的绝对路径）。卸载 = 删掉那个 manifest。
4. 右键扩展图标 →「选项」：授权麦克风、确认四个设备角色「设备已就绪」、选原声衬底档位、点「检测本地服务」确认本地服务能被拉起。

默认后端是 **mock**（本地生成提示音，不连 OpenAI、零费用）。走真 API：把 `.env.example` 复制成 `.env`，填 `OPENAI_API_KEY` 并设 `TRANSLATE_BACKEND=real`。扩展拉起的本地服务会自动读这份 `.env`。

`OPENAI_API_KEY` 只存在于本地 Node 进程；扩展只拿到短期凭证与一次性启动令牌，两者都不写入 `chrome.storage`。

### 开启同传

在会议页面点工具栏的扩展图标 →「开启同传」。这是一次冷启动，按钮转圈并依次显示三段进度：

1. **正在连接会议音频…** —— 建立音频桥：两个方向各一条「输入设备 → 增益 → 输出设备」的直通路。
2. **正在启动本地翻译服务…** —— 通过 Native Messaging 拉起本地 Node 进程（只在同传开启期间存在）。
3. **正在连接翻译服务…** —— 为每个需要翻译的方向建立会话并启动采集。

两个方向都真正就绪后，macOS 会弹出系统通知「同传已就绪」，写明这一次的两个方向各会怎么处理；工具栏图标出现绿点。任何一步失败也会弹通知说明原因，并且**桥失败与翻译失败是分开的**：翻译起不来时原声仍在直通，通知里会写「原声仍在直通。」；会议音频连不上时通知里会写「会议现在听不到你，你也听不到会议。」

插件**不会自动连接**：浏览器启动、扩展安装、后台唤醒都不会占用麦克风或拉起本地服务，只有你点「开启同传」才会。

### 原声直通与关闭

- 同传进行中：翻译播放时原声压到你选的衬底档位（0% / 25%（默认）/ 50%），译文队列播完 0.7 秒后恢复 100%。
- **「关闭同传」只结束翻译与本地服务**：本地进程退出（`pgrep -f native-host.mjs` 无结果）、不再计费，但对方原声继续进你的耳机、你的原声继续进会议，工具栏图标变灰点。
- 想彻底释放麦克风与设备，点面板底部的**「断开会议音频」**：此时会议既听不到你，你也听不到会议，图标角标消失。
- 浏览器关闭即释放一切；下次打开是「同传已关闭 · 未连接会议音频」。

### Meet 静音

你在 **Google Meet** 里点静音时，插件会在 0.5 秒内暂停翻译你的话：不再把麦克风音频送去翻译（因此不计费、也不会把旁边的谈话送出去）、丢弃已经排队的你的译文、你的原声保持不变。对方的话继续翻给你听。取消静音立即恢复；如果暂停期间上行会话被对端关闭，恢复时会自动重建（面板会短暂显示「正在恢复翻译…」）。

只有 Google Meet 网页版能被感知。在 Zoom / Teams 等其它平台，面板会常显「未感知到会议静音（仅支持 Google Meet）」，翻译照常进行——静音与否请自行判断。Meet 改版导致读不到按钮时同样退化为「未知」，不会误停。

### 语言能力与限制

- 面板只有两个下拉：**「你想听的语言」**（下行目标）与**「对方听的语言」**（上行目标），各是 13 种输出语言之一或「原声（不翻译）」。默认中文 / English，选择会被记住。
- **没有「你说的语言」**：输入语言由模型自动识别（官方支持 70+ 种）。
- 13 种输出语言：中文、English、日本語、한국어、Español、Français、Português、Deutsch、Italiano、Русский、हिन्दी、Bahasa Indonesia、Tiếng Việt。
- 某个方向选「原声（不翻译）」时，该方向不建会话、不采集、不计费，原声 100% 直通。
- 进行中改语言只重建受影响的那个方向，另一个方向不受影响。
- **同语言片段可能不出声**：当你说的话已经是「对方听的语言」时，模型倾向于不翻译该片段——此时衬底规则会让对方听到你 100% 的原声，而不是一段静音。
- **每句开头有 1–2 秒未压低的原声**：译文比原声晚到，这是上游延迟，本版不消除。

## 自动化测试

```bash
npm test             # 全部自动化测试（mock 后端，不打真 API、不碰真设备）
npm run e2e:real     # 真实链路端到端自检，约 $0.05/次，故不进 npm test
```

`npm run e2e:real` 走的链路与扩展一致：起本地服务 → `/api/session-token` 换 ephemeral secret → 连 OpenAI realtime translations WS → 按 ~170ms/块实时灌入 `fixtures/sample-en.wav` → 校验中文字幕、译文音频、句尾提交（合成 `completed`）均回流且全程无 error。

## 架构

```
src/shared/     纯逻辑（Node 可测 + 浏览器可直接加载）：设备预检、路由与衬底、
                语言目录与方向计划、两层运行态状态机与全部界面/通知文案、
                会话协议、Meet 静音解析、Native Messaging 协议帧、错误分类
src/extension/  扩展本体（零打包器）：service worker 编排、离屏文档跑音频桥与
                翻译层、只读 Meet 静音探测、弹窗/侧栏面板、选项页
src/server/     Native Messaging 宿主 + 令牌端点 + mock 翻译会话（ws）
tests/          node --test：单元（纯逻辑）+ 静态（接线纪律）+ 集成（宿主协议、
                令牌鉴权、构建与安装、service worker 编排全流程）
tools/          构建、宿主安装、扩展 ID 推导、图标生成、真实链路 e2e
```

判定逻辑一律在 `src/shared/`，扩展里的每个文件都只做接线；`tests/unit/shared-purity.test.mjs` 与 `tests/unit/extension-static.test.mjs` 用静态检查守住这条纪律。
