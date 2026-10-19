# dsh-session-namer

DSH Web 插件：会话标题右侧加一个「总结命名」按钮 —— 用**该会话当前的模型**把整段对话
总结成一句话，写成会话标题（顶栏和侧栏会通过官方 title 投影自动更新）。

## 它做了什么

- **客户端**（`lib/client.js`）：往官方插槽 `conversation.session.header.utilities` 注册一个按钮；
  点击时 `POST /dsh-session-namer/name {sessionId}` 拿 `jobId`，然后每 700ms 轮询
  `GET /dsh-session-namer/name?jobId=…` 直到拿到标题；按钮上显示「总结中… / 已重命名：xxx / 失败：…」。
- **宿主**（`lib/index.js`）：POST 只做参数与会话校验后**立刻返回 202 + jobId**，总结在后台跑，
  结果写进内存 job（保留 10 分钟，懒清理）。
  - **信任围栏**：路由不在 `/api` 下，所以每个请求（POST 与 GET）都先过
    `ctx.connection.requestRejection()`；被拒时用宿主给的状态码回包且不带 body。
    这也是 `inject` 里必须声明 `connection` 的原因——没有这道闸，任何能到达该端口的
    本地页面都能改名一个活会话。
  - 为什么分两步：总结要 1~5 秒，一次 POST 等到结果的话，响应会在回程被中间层切断
    （客户端报 `Response incomplete: length`）。分成"立刻返回 + 轮询"就没有这个窗口了。
  - 总结内容：读该会话的人类消息（规则与 `dsh-session-title` 一致），在字节预算内选取子集：
    **首条（交代意图）+ 最近若干条 + 中段等距采样最多 3 条**（只留首尾会让长会话的主题演化全丢），
    另外带上**当前标题**（作为稳定性锚点）、**最后一条助手回复**和**会话里用过的工具名**
    ——后两者让标题反映"最后做成了什么"，而不只是"问了什么"。
    然后调用官方共享策略：DSH 0.2.1+ 用 `executeSessionTitleLlm()`（prompt / framing / 推理档位由
    本插件提供），旧版 DSH 用 `generateSessionTitleWithLlm()`；最后用 `ctx.sessionTitle.rename()` 落标题。
  - **稳定性**：有当前标题时，提示词会要求"仍准确就原样返回"，只有主题实质变化才换名。
    所以反复点不会因为最近一句"继续"就把标题改掉；当前标题来自 fallback（截断的首条提问）时
    不作为锚点。
  - 输入预算按 **UTF-8 字节**算（官方 `maxInputBytes` 用 `Buffer.byteLength` 校验）。**不能用
    `String.length`**——那数的是 UTF-16 码元，一个汉字 3 字节却只算 1，中文密集的会话会被
    放行到 3 倍上限，然后在官方策略里抛 `input is N bytes, exceeding maxInputBytes`。
    单条消息自己就超预算时按字节截断（保留开头），不整段失败。
  - 标题长度：模型目标 **8 词 / 12 个汉字**，另有一道硬上限 **36 显示宽度**（≈18 个汉字或
    36 个 ASCII 字符，可用 `maxTitleWidth` 覆盖），超出按宽度截断。按钮上的状态文案另有
    `max-width:15em` + 省略号，免得错误信息把顶栏撑变形。
- 模型路由：默认 `session.requestHeader().config`，即**该会话当前用的 provider/model**；
  也可以在插件配置里写死 `provider` + `model`（两个必须同时给）。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里给这个条目加 `config`：

```yaml
- id: dsh-session-namer
  config:
    targetWords: 8            # 非 CJK 目标词数（默认 8）
    targetCjkCharacters: 12   # CJK 目标字数（默认 12）
    maxTitleWidth: 36         # 标题显示宽度硬上限（默认 36）
    maxInputBytes: 60000      # 送进模型的输入上限
    maxOutputTokens: 1024     # 输出上限（含推理 token；别调得太小，见下）
    timeoutMs: 30000
    # provider: dy
    # model: deepseek-v4-flash
    # fallbackProvider: dy      # 可选：会话路由失败时再试一次（两个必须成对给）
    # fallbackModel: deepseek-v4-flash
```

> `maxOutputTokens` 不是标题长度。推理型路由（如 `deepseek-v4.1-flash`）即使把推理档
> 设成 `off`，也会先吐 100~160 个 thinking token；预算给 160 时经常被思考全吃光，
> 返回 `finish=length` 且正文为空，标题就拿不到。标题实际只花 ~150 token，预算给大
> 只是上限，不增加成本。兜底路由**默认不启用**：没配 `DEEPSEEK_API_KEY` 的机器上，
> 硬塞一条 `deepseek-official` 只会用"没有 API key"的错误盖掉会话路由的真实错误。

## 安装 / 卸载

```powershell
pwsh -NoProfile -File install-session-namer.ps1      # 构建 + 复制进 profile + 注册 bundle
pwsh -NoProfile -File install-session-namer.ps1 -Check
pwsh -NoProfile -File install-session-namer.ps1 -Remove
```

profile 会自动解析：`-Profile` 显式指定 > 已经装了本插件的 profile > 唯一的 profile；
都确定不了就报错并列出候选，不再默认写死 `web`。本机只有一个 `desktop` profile：

```powershell
pwsh -NoProfile -File install-session-namer.ps1 -Profile desktop
```

安装后需要**重启 `dsh web`**（或重开 DSH 应用）才会加载。

## 自检

零依赖、不需要 profile、不需要运行中的宿主：

```powershell
node selftest-session-namer.mjs               # 纯逻辑 + 路由 + 围栏 + 浏览器 half
node selftest-session-namer.mjs --installed   # 额外把构建产物与 profile 安装副本逐字节比对
```

`lib/index.js` 顶层 import 的 `@deepseek-ai/dsh-session-title-llm` 由宿主的 Loader 在运行时
解析，普通 node 进程解析不到，所以自检用 `selftest/stub-framework.mjs` 挂了一个解析桩——
桩只在自检里生效，不进入运行时。桩**镜像 DSH 0.2.1 的真实契约**（严格的
`resolveSessionTitleLlmConfig` + `executeSessionTitleLlm`），所以插件要是退回旧 API 写法，
自检会立刻失败。官方配置校验（`resolveSessionTitleLlmConfig`）在解析不到官方包时会 SKIP
而不是失败。

## 已知边界

- **小输出预算会吃掉标题**：见配置一节的说明。模型把 `maxOutputTokens` 全花在
  thinking 上时，官方策略会以 `max-tokens` 结束、正文为空；现在默认 1024，并且
  失败信息会把每一次尝试（`session: …` / `fallback: …`）都带上，不再只报最后一条。
- **DSH 版本契约**：DSH 0.2.1 把 `@deepseek-ai/dsh-session-title-llm` 的
  `generateSessionTitleWithLlm()` 换成了 `executeSessionTitleLlm()`（prompt / framing /
  推理档位改由调用方提供），并把 `resolveSessionTitleLlmConfig()` 改成**只接受执行控制字段**
  （`maxInputBytes` / `maxOutputTokens` / `timeoutMs` / `provider` / `model`；再传
  `targetWords` 会抛 `unknown config key`）。插件用命名空间导入 + 运行时分支同时适配两代：
  新版自己拼 system / JSON framing / 推理档位，旧版继续走 `generateSessionTitleWithLlm()`。
  如果宿主半在 ESM link 阶段失败（例如新版本删了一个导出），Loader 不会创建 fiber，
  client half 也就不会进 boot graph —— 表现是插件页组件显示「未运行」、顶栏按钮消失。
- **助手侧信息是有界的**：标题输入里只带**最后一条**助手回复（最多 1.5KB）和最多 8 个工具名，
  更早的助手内容不参与；中段采样最多 3 条、每条最多 2KB。这是为了在 60KB 预算内同时保留
  "开场意图、演进过程、最后结果"，不是完整摘要。
- **纯图片提问的会话拿不到标题**：人类消息的判定要求 `source.kind === "user"` 且**文本块非空**
  （与官方 `dsh-session-title` 同规则），所以只贴了图、没打字的消息不算数，按钮返回
  `409 { code: "no-human-message", error: "无文字可总结" }`，客户端映射成短中文。
  不打算为这种会话硬凑标题：送进模型的只有文本，图片不会作为图片块进请求，凑出来只会是
  "用户上传了一张图片"这种零信息量结果。
- 只处理**进程内活着**的会话：`ctx.sessions.get(id)` 拿不到就返回 404（历史会话先打开一次即可）。
- 点了按钮会往会话日志追加官方同款事件（`session/title-llm-request` + `session/title`），
  不会打开新的对话轮次，也不进模型上下文。
- 目录是**真实复制**进 profile 的 `node_modules`，不是软链：这样安装副本才能被
  `selftest --installed` 逐字节比对，也避免 pnpm 的 link 语义在 profile 重装时改变解析路径。
  以后在该 profile 跑 `pnpm install` 可能清掉它，重跑安装脚本即可。
  （`@deepseek-ai/*` 由宿主 Loader 解析，与是否软链无关。）
