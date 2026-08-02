# live-interpreter

macOS 本地实时会议同传原型：BlackHole 音频路由 + OpenAI `gpt-realtime-translate` 双向翻译管道。对会议软件（Zoom / Meet / Teams）完全透明，不入会、不装 bot。

- **下行**：会议 app 输出 → BlackHole 截获 → 英→中 → 你的耳机（中文语音 + 屏幕字幕）
- **上行**：真麦克风中文 → 中→英 → 第二块 BlackHole（虚拟麦克风）→ 会议对方听到英语

## 环境要求

- macOS + **Chromium 系浏览器（Chrome / Edge）**。原因：把译文音频输出到指定设备依赖 `AudioContext.setSinkId`，目前仅 Chromium 系可用。
- Node **>= 22**（依赖内置全局 `WebSocket` 与 `node --test`）。
- 首次运行需联网安装依赖（`ws` 包）；离线环境请先在联网时执行一次 `npm install`。

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
4. **开发期不用真会议**：用 QuickTime 等系统播放器回放一段英语音频（可用 `say -o fixtures/sample-en.wav --data-format=LEF32@22050 "Hello, this is a test."` 生成），声音经多输出设备灌入 BlackHole 2ch，即等价于会议对方在说话。应用内**没有**文件选择功能，回放一律在系统播放器中做。

## 运行

```bash
npm install        # 首次
npm test           # 全部自动化测试（mock 后端，不打真 API、不碰真设备）
npm start          # 默认 mock 后端，打开 http://localhost:5173/
```

- 默认端口 `5173`，可用 `PORT` 环境变量覆盖。
- **默认后端是 `mock`**：不连接 OpenAI 就能跑通整条管道（字幕 + 音频帧），供验证路由与 UI。
- 走真 API：把 `.env.example` 复制成 `.env`，填入 `OPENAI_API_KEY`、并设 `TRANSLATE_BACKEND=real`。

```bash
npm run start:real   # 真实后端起服务，页面用法与 mock 完全一致
npm run e2e:real     # 真实链路端到端自检，约 $0.05/次，故不进 npm test
```

`npm run e2e:real` 走的链路与浏览器一致：起服务器 → `/api/session-token` 换 ephemeral secret → 连 OpenAI realtime translations WS → 按 ~170ms/块实时灌入 `fixtures/sample-en.wav` → 校验中文字幕、译文音频、句尾提交（合成 `completed`）均回流且全程无 error。

`OPENAI_API_KEY` 只存在于服务端进程；浏览器通过 `POST /api/session-token` 拿短期凭证，永不接触长期 key。

## 页面使用

1. Chrome 打开 `http://localhost:5173/`，授予麦克风权限。
2. 四个设备角色默认自动分配（capture=BlackHole 2ch、virtualMic=BlackHole 16ch、monitor/mic=非 BlackHole 设备），可在下拉中覆盖；预检不通过会给出中文提示（缺设备/权限/自听回环等）。
3. 点「启动下行」听翻译、看字幕；点「启动上行」+ 解除静音后，对麦克风说中文，对方（或 QuickTime 选 BlackHole 16ch 录音验证）听到英语。**上行默认静音**，防止背景中文被误翻给对方。

## 延迟

真实后端（`npm run start:real`）下行 en→zh、上行 zh→en 双向链路均已实测跑通，延迟可用于实时会议。

口径：该句首个字幕增量之前的最后一次音频送出 → 该句首帧译文音频到达（无 VAD 的近似口径，略优于主观感受）。页面实时显示该值，具体数字随网络与地区波动，未在此固化基准。

## 架构

```
src/shared/    纯逻辑（Node 可测 + 浏览器可直接加载）：设备预检、路由、状态机、
               会话协议、字幕、延迟、错误分类、后端/端点选择
src/server/    HTTP 静态服务 + /api/config + /api/session-token + mock 翻译会话（ws）
src/web/       薄接线：UI 事件与浏览器音频 API，不含判定逻辑
tests/         node --test：单元（纯逻辑）+ 集成（mock 全链路、凭证端点）
tools/         pretest 环境自检 + e2e-real 真实链路验证（不进 npm test）
```
