// dsh-session-namer Node half.
//
// 两个路由都不在 /api 下面 —— 也就是说它们不经过宿主的 API 鉴权网关，
// 所以必须自己对每个请求调用 ctx.connection.requestRejection()：有请求被拒时
// 用宿主给的状态码回包（不带 body），否则任何能到达该端口的页面都能改名一个活会话。
//   POST /dsh-session-namer/name {sessionId}  -> 202 {ok, jobId}（立刻返回）
//   GET  /dsh-session-namer/name?jobId=...    -> {ok, status:"running"|"done", title?}
//
// 为什么不是一次 POST 等到结果：总结要 1~5 秒，而这条链路会在长响应返回途中被切断
// （客户端报 "Response incomplete: length"）。把响应压成"立刻 + 只带 jobId"就没有这个窗口了。
//
// 总结本身复用官方策略 @deepseek-ai/dsh-session-title-llm：prompt、输入 framing、
// 字节/输出 token 上限、超时、以及"跟随该会话当前模型路由"都由它决定。
import { randomUUID } from 'node:crypto'
// DSH 0.2.1 把共享策略从 generateSessionTitleWithLlm() 换成了 executeSessionTitleLlm()，
// 旧导出被删除。静态具名导入会让整个宿主半在 ESM link 阶段就抛
// "does not provide an export named 'generateSessionTitleWithLlm'"：Loader 因此不创建
// fiber，client half 也不会被组装进 boot graph —— 表现就是插件页「未运行」、按钮消失。
// 这里用命名空间导入 + 运行时分支：新版走新 API，旧版 DSH 仍能走旧 API。
import * as titleLlm from '@deepseek-ai/dsh-session-title-llm'

const { resolveSessionTitleLlmConfig } = titleLlm
/** DSH >= 0.2.1 的共享策略：prompt / framing / 推理档位由调用方提供。 */
const MODERN_TITLE_LLM = typeof titleLlm.executeSessionTitleLlm === 'function'

const name = 'dsh-session-namer'
const ROUTE = '/dsh-session-namer/name'
const inject = ['webServer', 'sessionTitle', 'llm', 'sessions', 'connection']

/** 默认预算：够覆盖整段对话；标题刻意短，免得顶栏和侧栏被名字撑爆。 */
const DEFAULTS = {
  targetWords: 8,
  targetCjkCharacters: 12,
  maxInputBytes: 60000,
  // 输出上限不是"标题长度"：推理型路由（如 deepseek-v4.1-flash）即使把推理档设成
  // off，也会先吐 100~160 个 thinking token，把 160 的预算吃光后一个正文字都不剩
  // （finish=length、content=""），标题就永远拿不到。标题实际只花 150 token 左右，
  // 预算给大只是上限，不增加成本。
  maxOutputTokens: 1024,
  timeoutMs: 30000,
  // 标题硬上限，按显示宽度算（CJK 记 2，ASCII 记 1）：36 ≈ 18 个汉字。
  maxTitleWidth: 36,
}

/** 附加信息（当前标题、最后一条助手回复、工具名）的字节预留。 */
const EXTRAS_RESERVE_BYTES = 2600
/** 最后一条助手回复最多带多少字节（UTF-8）。 */
const ASSISTANT_TEXT_MAX_BYTES = 1500
/** 最多带几个工具名。 */
const TOOL_NAMES_MAX = 8
/** 中段采样每条消息最多多少字节。 */
const MIDDLE_SAMPLE_MAX_BYTES = 2048

/** 标题硬上限，按显示宽度算（CJK 记 2，ASCII 记 1）：36 ≈ 18 个汉字或 36 个字符。 */
const TITLE_MAX_WIDTH = DEFAULTS.maxTitleWidth
/** 结果最多保留多久（每次请求懒清理）。 */
const JOB_TTL_MS = 10 * 60 * 1000

/** 一个字符占几个显示宽度（CJK/全角记 2）。 */
function charWidth(char) {
  return /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char)
    ? 2
    : 1
}

/**
 * 收窄标题：剥掉模型偷偷加上的 Markdown 记号，折叠空白，再按显示宽度截断。
 * @param raw - 模型返回的原始标题。
 * @param maxWidth - 显示宽度上限（默认用 TITLE_MAX_WIDTH）。
 * @returns 非空、宽度受限的标题。
 */
function shortTitle(raw, maxWidth = TITLE_MAX_WIDTH) {
  const text = String(raw)
    // 官方 prompt 要求 "no Markdown"，但模型（如 wkbd/deepseek-v4.1-flash）仍会返回
    // **粗体** / `代码` / # 标题，星号会原样出现在顶栏和侧栏，这里统一剥掉。
    // 无差别删星号（不是配对匹配）：会话标题里合法带 * 的情况可忽略，配对匹配反而会把
    // "**a** 和 **b**" 这种半截记号留下。
    .replace(/[*`]/g, '')
    .replace(/^\s*#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return text
  let width = 0
  let kept = ''
  for (const char of text) {
    const next = width + charWidth(char)
    if (next > maxWidth) break
    width = next
    kept += char
  }
  return kept === '' ? text.slice(0, maxWidth) : kept
}

/**
 * 新版共享策略的系统提示词：英文指令 + 可选的"保持当前标题"稳定性规则
 * （与官方 all-prompts provider 同款措辞）。
 * @param tuning - 标题长度目标。
 * @param hasCurrentTitle - 是否把当前标题作为锚点传给模型。
 * @returns 系统指令。
 */
function systemPrompt(tuning, hasCurrentTitle) {
  return [
    'Create a concise title for an AI coding-assistant session.',
    "You receive a JSON object: humanMessages (the user's messages in order), and optionally currentTitle, lastAssistantReply, and toolsUsed.",
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${tuning.targetWords} words in non-CJK languages or ${tuning.targetCjkCharacters} CJK characters.`,
    'If the input gives little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
    ...(hasCurrentTitle
      ? [
          'An existing title is supplied as currentTitle. If it still accurately describes the main topic or task, return it exactly unchanged.',
          'Follow-up questions, additional details within the same topic, acknowledgements such as "thanks", and requests to continue do not by themselves justify a title change.',
          'Do not reword, polish, shorten, or replace synonyms in an adequate title. Keeping its exact wording takes priority over the target length.',
          'Change the title only when the messages materially change or expand the main topic or task so that the existing title is no longer accurate.',
        ]
      : []),
  ].join('\n')
}

/**
 * 把载荷框成 JSON：用户文本无法破坏结构分隔符（官方同款 framing）。
 * @param payload - {currentTitle?, humanMessages, lastAssistantReply?, toolsUsed?}。
 * @returns 送进模型的用户输入。
 */
function frameMessages(payload) {
  return `Generate or update the session title from this JSON object:\n${JSON.stringify(payload)}`
}

/**
 * 新版响应 -> 标题行：官方 provider 的规则是取第一条非空行（模型常把标题放第一行，
 * 后面跟着解释）。Markdown 记号由 shortTitle 统一剥掉。
 * @param response - executeSessionTitleLlm() 的结果。
 * @returns 标题行，可能为空串。
 */
function titleFromResponse(response) {
  const finish = response?.finish?.kind
  if (finish === 'tool-calls') throw new Error('session-title-llm: title output must contain text only')
  if (finish === 'max-tokens') throw new Error('session-title-llm: title output reached maxOutputTokens')
  const blocks = Array.isArray(response?.blocks) ? response.blocks : []
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  return text.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
}

/**
 * 一条可用于标题的人类消息（与 dsh-session-title 的采集规则一致：只认
 * source.kind === "user" 的 user/message，且文本块去掉空白后非空）。
 * @param event - 会话日志事件。
 * @returns {seq, text}，不可用时为 undefined。
 */
function humanMessageOf(event) {
  if (event.type !== 'user/message' || event.data.source?.kind !== 'user') return undefined
  const blocks = Array.isArray(event.data.content) ? event.data.content : []
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  if (text.trim().length === 0) return undefined
  return { seq: event.seq, text }
}

/** 会话里全部可用的人类消息，按时间顺序。 */
function humanMessagesOf(session) {
  const messages = []
  for (const event of session.snapshotEvents()) {
    const message = humanMessageOf(event)
    if (message !== undefined) messages.push(message)
  }
  return messages
}

/**
 * 按 UTF-8 字节截断文本，保留开头，不切断码点。
 * @param text - 原始文本。
 * @param maxBytes - UTF-8 字节上限。
 * @returns 截断后的文本。
 */
function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let used = 0
  let kept = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    used += size
    kept += char
  }
  return kept
}

/**
 * 助手侧摘要：最后一条有文本的助手回复 + 会话里出现过的主要工具名。
 * 标题只看用户提问容易变成"问了什么"，带上这两样才能反映"最后做成了什么"。
 * 它们只进 input，不进 messageSeqs。
 * @param session - 目标会话。
 * @returns {lastAssistantText, tools}
 */
function assistantDigestOf(session) {
  let lastAssistantText = ''
  const tools = []
  const seen = new Set()
  for (const event of session.snapshotEvents()) {
    if (event.type === 'assistant/message') {
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
      if (text !== '') lastAssistantText = text
    } else if (event.type === 'tool/call' && typeof event.data?.name === 'string' && !seen.has(event.data.name)) {
      seen.add(event.data.name)
      tools.push(event.data.name)
    }
  }
  return {
    lastAssistantText: truncateUtf8(lastAssistantText, ASSISTANT_TEXT_MAX_BYTES),
    tools: tools.slice(-TOOL_NAMES_MAX),
  }
}

/**
 * 一段消息按官方 framing 序列化后的 UTF-8 字节数。
 * 必须按字节算：官方策略用 Buffer.byteLength 校验 maxInputBytes，
 * 而 String.length 数的是 UTF-16 码元（一个汉字 3 字节但只算 1），
 * 中文密集的会话会被放行到 3 倍上限，然后在官方那边直接抛错。
 * @param value - 要序列化的消息数组。
 * @returns UTF-8 字节数。
 */
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * 把一条消息的文本截到字节预算内（二分找最长可行前缀），保留开头。
 * 单条消息自己就超预算时（比如首条贴了一大段文档），官方策略会直接抛错；
 * 截断虽然丢信息，但至少能得到一个基于开头内容的标题。
 * @param message - {seq, text}。
 * @param budget - UTF-8 字节预算。
 * @returns 截断后的消息；连空文本都放不下时返回 undefined。
 */
function truncateMessage(message, budget) {
  const chars = [...String(message.text)]
  if (jsonBytes([{ seq: message.seq, text: '' }]) > budget) return undefined
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes([{ seq: message.seq, text: chars.slice(0, mid).join('') }]) <= budget) low = mid
    else high = mid - 1
  }
  return { seq: message.seq, text: chars.slice(0, low).join('') }
}

/**
 * 在字节预算内挑要送进模型的子集：首条（交代意图）+ 最近的若干条 + 中段等距采样。
 * 只留首尾会让长会话的主题演化全丢；中段采样最多 3 条、每条最多 2KB。
 * @param messages - 全部候选消息。
 * @param maxInputBytes - 官方策略的输入上限（UTF-8 字节）。
 * @returns 选中的消息子集，按 seq 升序。
 */
function fitMessages(messages, maxInputBytes) {
  // 512 给官方 framing 前缀和 JSON 包裹留余量，下限 2048 保证单条也进得去。
  const budget = Math.max(2048, maxInputBytes - 512)
  // 消息多时给中段留 25% 预算（上限 6KB），否则最近消息会把预算吃光。
  const middleReserve = messages.length > 6 ? Math.min(Math.floor(budget * 0.25), 6000) : 0
  const recentBudget = budget - middleReserve
  const picked = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const size = jsonBytes([messages[index]])
    if (picked.length > 0 && used + size > recentBudget) break
    picked.unshift(messages[index])
    used += size
  }
  // 首条通常交代会话意图：整段超预算时，从最旧的已选消息里挤空间把它带上。
  if (messages.length > picked.length && picked[0] !== messages[0]) {
    const firstSize = jsonBytes([messages[0]])
    while (picked.length > 1 && used + firstSize > recentBudget) {
      used -= jsonBytes([picked.shift()])
    }
    if (used + firstSize <= recentBudget) {
      picked.unshift(messages[0])
      used += firstSize
    }
  }
  // 中段采样：首尾之间等距补最多 3 条，让"话题怎么演变的"也能进模型。
  if (picked.length > 0) {
    const selected = new Set(picked.map((message) => message.seq))
    const firstIndex = messages.findIndex((message) => message.seq === picked[0].seq)
    const lastIndex = messages.findIndex((message) => message.seq === picked[picked.length - 1].seq)
    if (firstIndex >= 0 && lastIndex - firstIndex > 1) {
      const middle = []
      for (let index = firstIndex + 1; index < lastIndex; index += 1) {
        if (!selected.has(messages[index].seq)) middle.push(messages[index])
      }
      const slots = Math.min(3, middle.length)
      for (let slot = 0; slot < slots; slot += 1) {
        const position = Math.min(middle.length - 1, Math.floor(((slot + 1) * middle.length) / (slots + 1)))
        const candidate = middle[position]
        if (selected.has(candidate.seq)) continue
        let value = candidate
        let size = jsonBytes([candidate])
        if (size > MIDDLE_SAMPLE_MAX_BYTES) {
          const trimmed = truncateMessage(candidate, MIDDLE_SAMPLE_MAX_BYTES)
          if (trimmed === undefined) continue
          value = trimmed
          size = jsonBytes([value])
        }
        if (used + size > budget) continue
        picked.push(value)
        selected.add(candidate.seq)
        used += size
      }
      picked.sort((left, right) => left.seq - right.seq)
    }
  }
  // 兜底：单条自己就超预算时上面几道都拦不住（首轮是无条件放行的），
  // 这里把它截到预算内——否则官方策略会抛 "input is N bytes, exceeding maxInputBytes"。
  if (used > budget) {
    const trimmed = truncateMessage(picked[picked.length - 1], budget)
    if (trimmed !== undefined) {
      picked.length = 0
      picked.push(trimmed)
    }
  }
  return picked
}

/** 读完整个请求体（小 JSON，上限 64KB）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 写回一次 JSON 响应。 */
function respond(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * DSH >= 0.2.1：调用共享策略的新入口，自己提供 system / framing / 推理档位。
 * @param ctx - 暴露 llm 的上下文。
 * @param resolved - 已校验的执行控制（maxInputBytes / maxOutputTokens / timeoutMs / 可选路由）。
 * @param tuning - 标题长度目标（只影响提示词）。
 * @param session - 目标会话。
 * @param route - 本次尝试的路由，undefined 表示用 resolved 里写死的 provider/model。
 * @param selected - 送进模型的 {seq, text} 子集。
 * @param signal - 取消信号。
 * @param currentTitle - 当前标题（作为稳定性锚点；undefined 表示没有可信锚点）。
 * @param digest - 助手侧摘要 {lastAssistantText, tools}。
 * @returns 收窄后的标题。
 */
async function modernTitle(ctx, resolved, tuning, session, route, selected, signal, currentTitle, digest) {
  const payload = {
    ...(currentTitle === undefined ? {} : { currentTitle }),
    humanMessages: selected,
    ...(digest.lastAssistantText === '' ? {} : { lastAssistantReply: digest.lastAssistantText }),
    ...(digest.tools.length === 0 ? {} : { toolsUsed: digest.tools }),
  }
  const response = await titleLlm.executeSessionTitleLlm(
    ctx,
    resolved,
    { session, ...(route === undefined ? {} : { route }), signal },
    name,
    {
      system: systemPrompt(tuning, currentTitle !== undefined),
      input: frameMessages(payload),
      messageSeqs: selected.map((message) => message.seq),
      // 官方 provider 的选择：标题任务用模型支持的最低推理档。
      selectReasoningEffort: (model) => model.reasoning?.efforts[0]?.id,
    },
  )
  return shortTitle(titleFromResponse(response), tuning.maxTitleWidth)
}

/**
 * 旧版 DSH（< 0.2.1）：沿用 generateSessionTitleWithLlm()，prompt 与 framing 由它负责。
 * @param ctx - 暴露 llm 的上下文。
 * @param resolved - 旧版策略配置（含 targetWords / targetCjkCharacters）。
 * @param session - 目标会话。
 * @param route - 本次尝试的路由。
 * @param messages - 全部人类消息（旧 API 的 request.messages）。
 * @param selected - 送进模型的字节预算内子集。
 * @param signal - 取消信号。
 * @param tuning - 标题长度目标（只用 maxTitleWidth）。
 * @returns 收窄后的标题。
 */
async function legacyTitle(ctx, resolved, session, route, messages, selected, signal, tuning) {
  const result = await titleLlm.generateSessionTitleWithLlm(
    ctx,
    resolved,
    { session, messages, ...(route === undefined ? {} : { route }), signal },
    selected,
    name,
  )
  return shortTitle(result.title, tuning.maxTitleWidth)
}

/**
 * 后台跑一次总结并改名，结果写进 job。
 * @param ctx - 暴露 llm / sessionTitle 的上下文。
 * @param policy - { resolved, tuning }：已校验的官方策略配置 + 标题长度目标。
 * @param session - 目标会话（调用方已确认活着且有内容）。
 * @param job - 结果槽 {status, title?, error?}。
 */
async function summarize(ctx, policy, session, job, fallback) {
  const { resolved, tuning } = policy
  const controller = new AbortController()
  const safety = setTimeout(
    () => controller.abort(new Error('summarize timed out')),
    resolved.timeoutMs + 15000,
  )
  try {
    const messages = humanMessagesOf(session)
    // 新版载荷还要带当前标题和助手摘要，先给它们留出字节。
    const selected = fitMessages(messages, resolved.maxInputBytes - (MODERN_TITLE_LLM ? EXTRAS_RESERVE_BYTES : 0))
    const digest = MODERN_TITLE_LLM ? assistantDigestOf(session) : { lastAssistantText: '', tools: [] }
    // 当前标题作为稳定性锚点：没有锚点时每次点按钮都会按最近消息改名。
    // fallback 来源（截断的首条提问）不算可信标题，不用它锚定。
    const snapshot = typeof ctx.sessionTitle.get === 'function' ? ctx.sessionTitle.get(session) : undefined
    const currentTitle = snapshot !== undefined && snapshot.source?.kind !== 'fallback' ? snapshot.title : undefined
    const sessionRoute = session.requestHeader()?.config
    // 优先用会话当前路由；它失败（如 Ark 流式 "Response incomplete"）且配了兜底路由时，
    // 用兜底路由再试一次。
    const attempts = [
      { route: sessionRoute, label: 'session' },
      ...(fallback !== undefined &&
      sessionRoute !== undefined &&
      (sessionRoute.provider !== fallback.provider || sessionRoute.model !== fallback.model)
        ? [{ route: fallback, label: 'fallback' }]
        : []),
    ]
    const failures = []
    for (const attempt of attempts) {
      try {
        const title = MODERN_TITLE_LLM
          ? await modernTitle(ctx, resolved, tuning, session, attempt.route, selected, controller.signal, currentTitle, digest)
          : await legacyTitle(ctx, resolved, session, attempt.route, messages, selected, controller.signal, tuning)
        ctx.sessionTitle.rename(session, title)
        job.status = 'done'
        job.title = title
        job.usedRoute = attempt.label
        ctx.logger.info(`dsh-session-namer: "${session.id}" renamed to "${title}" (route: ${attempt.label})`)
        return
      } catch (error) {
        // 每次都记下来：只报最后一次会拿"兜底路由没 key"盖掉真正的失败原因。
        failures.push(`${attempt.label}: ${String(error?.message ?? error)}`)
        ctx.logger.warn(`dsh-session-namer: attempt "${attempt.label}" failed: ${String(error?.message ?? error)}`)
      }
    }
    throw new Error(failures.length > 0 ? failures.join('；') : 'no attempt ran')
  } catch (error) {
    job.status = 'error'
    job.error = String(error?.message ?? error)
    ctx.logger.warn(`dsh-session-namer: naming "${session.id}" failed: ${job.error}`)
  } finally {
    clearTimeout(safety)
  }
}

/**
 * 挂载总结命名路由。
 * @param ctx - 暴露 webServer / sessionTitle / llm / sessions 的上下文。
 * @param config - 可选的模型与预算覆盖；不给 provider/model 就跟随会话当前路由。
 */
function apply(ctx, config) {
  // 标题长度目标是本插件的提示词参数；0.2.1 的 resolveSessionTitleLlmConfig 只接受
  // 执行控制字段（maxInputBytes / maxOutputTokens / timeoutMs / provider / model），
  // 多传一个 key 就会抛 "unknown config key"。旧版则把两项也放在同一个对象里。
  const tuning = {
    targetWords: config?.targetWords ?? DEFAULTS.targetWords,
    targetCjkCharacters: config?.targetCjkCharacters ?? DEFAULTS.targetCjkCharacters,
    maxTitleWidth: config?.maxTitleWidth ?? DEFAULTS.maxTitleWidth,
  }
  for (const [key, value] of Object.entries(tuning)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`dsh-session-namer: ${key} must be a positive integer`)
  }
  const controls = {
    maxInputBytes: config?.maxInputBytes ?? DEFAULTS.maxInputBytes,
    maxOutputTokens: config?.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    timeoutMs: config?.timeoutMs ?? DEFAULTS.timeoutMs,
    ...(config?.provider === undefined ? {} : { provider: config.provider }),
    ...(config?.model === undefined ? {} : { model: config.model }),
  }
  const resolved = MODERN_TITLE_LLM
    ? resolveSessionTitleLlmConfig(controls)
    : resolveSessionTitleLlmConfig({ ...tuning, ...controls })

  // 兜底路由只在显式配置时启用：默认塞一条 deepseek-official 会让没配
  // DEEPSEEK_API_KEY 的机器每次都多打一次注定失败的路由，并用它的错误盖掉
  // 会话路由的真实错误。
  const fallback =
    config?.fallbackProvider !== undefined && config?.fallbackModel !== undefined
      ? { provider: config.fallbackProvider, model: config.fallbackModel }
      : undefined

  /** jobId -> 结果槽。只活在进程内，结果也只给点按钮的那个客户端看。 */
  const jobs = new Map()

  /** 拒绝不可信/未鉴权请求；返回 true 表示已经回过包，调用方直接返回。 */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.writeHead(rejection)
    res.end()
    return true
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        async handler(req, res) {
          if (rejected(req, res)) return
          const now = Date.now()
          for (const [id, job] of jobs) if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id)

          if (req.method === 'GET') {
            const jobId = new URL(req.url ?? ROUTE, 'http://localhost').searchParams.get('jobId') ?? ''
            const job = jobs.get(jobId)
            if (job === undefined) {
              respond(res, 404, { ok: false, error: 'unknown or expired jobId' })
              return
            }
            if (job.status === 'running') {
              respond(res, 200, { ok: true, status: 'running' })
              return
            }
            if (job.status === 'error') {
              respond(res, 200, { ok: false, status: 'error', error: job.error })
              return
            }
            respond(res, 200, { ok: true, status: 'done', title: job.title })
            return
          }

          if (req.method !== 'POST') {
            respond(res, 405, { ok: false, error: 'POST to start, GET ?jobId= to poll' })
            return
          }

          let payload
          try {
            payload = JSON.parse(await readBody(req))
          } catch (error) {
            respond(res, 400, { ok: false, error: `bad request body: ${String(error?.message ?? error)}` })
            return
          }
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
          if (sessionId === '') {
            respond(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const session = ctx.sessions.get(sessionId)
          if (session === undefined) {
            respond(res, 404, { ok: false, error: 'session is not live in this process' })
            return
          }
          if (humanMessagesOf(session).length === 0) {
            // 只认 source.kind === "user" 的文本消息：纯图片提问、只有插件注入消息的会话都到这里。
            // 文案要短——客户端会把它显示在标题栏那颗 pill 上。
            respond(res, 409, { ok: false, code: 'no-human-message', error: '无文字可总结' })
            return
          }

          const jobId = randomUUID()
          const job = { status: 'running', createdAt: now, sessionId }
          jobs.set(jobId, job)
          // 不等它：长响应会在回程被切断，所以先把 jobId 交回客户端，由客户端轮询。
          void summarize(ctx, { resolved, tuning }, session, job, fallback)
          respond(res, 202, { ok: true, jobId })
        },
      }),
    'dsh-session-namer: name route',
  )
}

export { apply, inject, name }
/** 仅供离线自检使用（不参与运行时逻辑）。 */
export const __test = {
  humanMessageOf,
  humanMessagesOf,
  fitMessages,
  shortTitle,
  charWidth,
  systemPrompt,
  frameMessages,
  titleFromResponse,
  MODERN_TITLE_LLM,
  DEFAULTS,
  ROUTE,
  TITLE_MAX_WIDTH,
}
