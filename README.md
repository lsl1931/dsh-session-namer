# dsh-session-namer

DSH Web 插件：会话标题右侧加一个「总结命名」按钮 —— 用**该会话当前的模型**把整段对话
总结成一句话，写成会话标题（顶栏和侧栏会通过官方 title 投影自动更新）。

## 它做了什么

- **客户端**（`lib/client.js`）：往官方插槽 `conversation.session.header.utilities` 注册一个按钮；
  点击时 `POST /dsh-session-namer/name {sessionId}` 拿 `jobId`，然后每 700ms 轮询
  `GET /dsh-session-namer/name?jobId=…` 直到拿到标题；按钮上显示「总结中… / 已重命名：xxx / 失败：…」。
- **宿主**（`lib/index.js`）：POST 只做参数与会话校验后**立刻返回 202 + jobId**，总结在后台跑，
  结果写进内存 job（保留 10 分钟，懒清理）。
  - 为什么分两步：总结要 1~5 秒，一次 POST 等到结果的话，响应会在回程被中间层切断
    （客户端报 `Response incomplete: length`）。分成"立刻返回 + 轮询"就没有这个窗口了。
  - 总结内容：读该会话的人类消息（规则与 `dsh-session-title` 一致），在字节预算内选取要送进模型的
    子集（从最近往前收，首条能塞下就带上），调用官方共享策略 `generateSessionTitleWithLlm()`
    （prompt / framing / token 与超时上限都来自 `@deepseek-ai/dsh-session-title-llm`），
    再用 `ctx.sessionTitle.rename()` 落标题。
  - 输入预算按 **UTF-8 字节**算（官方 `maxInputBytes` 用 `Buffer.byteLength` 校验）。**不能用
    `String.length`**——那数的是 UTF-16 码元，一个汉字 3 字节却只算 1，中文密集的会话会被
    放行到 3 倍上限，然后在官方策略里抛 `input is N bytes, exceeding maxInputBytes`。
    单条消息自己就超预算时按字节截断（保留开头），不整段失败。
  - 标题长度：模型目标 **5 词 / 8 个汉字**，另有一道硬上限 **28 显示宽度**（≈14 个汉字或 28 个
    ASCII 字符），超出按宽度截断。按钮上的状态文案另有 `max-width:15em` + 省略号，
    免得错误信息把顶栏撑变形。
- 模型路由：默认 `session.requestHeader().config`，即**该会话当前用的 provider/model**；
  也可以在插件配置里写死 `provider` + `model`（两个必须同时给）。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里给这个条目加 `config`：

```yaml
- id: dsh-session-namer
  config:
    targetWords: 8            # 非 CJK 目标词数
    targetCjkCharacters: 16   # CJK 目标字数
    maxInputBytes: 60000      # 送进模型的输入上限
    maxOutputTokens: 160
    timeoutMs: 30000
    # provider: dy
    # model: deepseek-v4-flash
```

## 安装 / 卸载

```powershell
pwsh -NoProfile -File install-session-namer.ps1      # 构建 + 复制进 profile + 注册 bundle
pwsh -NoProfile -File install-session-namer.ps1 -Check
pwsh -NoProfile -File install-session-namer.ps1 -Remove
```

安装后需要**重启 `dsh web`**（或重开 DSH 应用）才会加载。

## 已知边界

- **纯图片提问的会话拿不到标题**：人类消息的判定要求 `source.kind === "user"` 且**文本块非空**
  （与官方 `dsh-session-title` 同规则），所以只贴了图、没打字的消息不算数，按钮返回
  `409 { code: "no-human-message", error: "无文字可总结" }`，客户端映射成短中文。
  不打算为这种会话硬凑标题：送进模型的只有文本，图片不会作为图片块进请求，凑出来只会是
  "用户上传了一张图片"这种零信息量结果。
- 只处理**进程内活着**的会话：`ctx.sessions.get(id)` 拿不到就返回 404（历史会话先打开一次即可）。
- 点了按钮会往会话日志追加官方同款事件（`session/title-llm-request` + `session/title`），
  不会打开新的对话轮次，也不进模型上下文。
- 目录是**真实复制**进 profile 的 `node_modules`，不是软链：Node 按真实路径解析 `import`，
  软链会让 `@deepseek-ai/*` 解析失败。以后在该 profile 跑 `pnpm install` 可能清掉它，重跑安装脚本即可。
