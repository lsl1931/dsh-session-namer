// dsh-session-namer Node half.
//
// 两个路由，都不在 /api 下面，所以客户端按钮不需要过 API 鉴权网关：
//   POST /dsh-session-namer/name {sessionId}  -> 202 {ok, jobId}（立刻返回）
//   GET  /dsh-session-namer/name?jobId=...    -> {ok, status:"running"|"done", title?}
//
// 为什么不是一次 POST 等到结果：总结要 1~5 秒，而这条链路会在长响应返回途中被切断
// （客户端报 "Response incomplete: length"）。把响应压成"立刻 + 只带 jobId"就没有这个窗口了。
//
// 总结本身复用官方策略 @deepseek-ai/dsh-session-title-llm：prompt、输入 framing、
// 字节/输出 token 上限、超时、以及"跟随该会话当前模型路由"都由它决定。
import { randomUUID } from 'node:crypto'
import { generateSessionTitleWithLlm, resolveSessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'

const name = 'dsh-session-namer'
const ROUTE = '/dsh-session-namer/name'
const inject = ['webServer', 'sessionTitle', 'llm', 'sessions']

/** 默认预算：够覆盖整段对话；标题刻意短，免得顶栏和侧栏被名字撑爆。 */
const DEFAULTS = {
  targetWords: 5,
  targetCjkCharacters: 8,
  maxInputBytes: 60000,
  maxOutputTokens: 160,
  timeoutMs: 30000,
}

/** 会话路由（如火山 Ark）流式响应不可靠时的兜底路由（配置可覆盖，两个必须成对给）。 */
const FALLBACK_DEFAULTS = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash-vision-exp',
}

/** 标题硬上限，按显示宽度算（CJK 记 2，ASCII 记 1）：28 ≈ 14 个汉字或 28 个字符。 */
const TITLE_MAX_WIDTH = 28
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
 * @returns 非空、宽度受限的标题。
 */
function shortTitle(raw) {
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
    if (next > TITLE_MAX_WIDTH) break
    width = next
    kept += char
  }
  return kept === '' ? text.slice(0, TITLE_MAX_WIDTH) : kept
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
 * 在字节预算内挑要送进模型的子集：从最近往前收，首条能塞下就带上（首条通常交代意图）。
 * 不做这层裁剪的话，长会话会因为超过 maxInputBytes 直接报错。
 * @param messages - 全部候选消息。
 * @param maxInputBytes - 官方策略的输入上限（UTF-8 字节）。
 * @returns 选中的消息子集。
 */
function fitMessages(messages, maxInputBytes) {
  // 512 给官方 framing 前缀和 JSON 包裹留余量，下限 2048 保证单条也进得去。
  const budget = Math.max(2048, maxInputBytes - 512)
  const picked = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const size = jsonBytes([messages[index]])
    if (picked.length > 0 && used + size > budget) break
    picked.unshift(messages[index])
    used += size
  }
  // 首条通常交代会话意图：整段超预算时，从最旧的已选消息里挤空间把它带上。
  if (messages.length > picked.length && picked[0] !== messages[0]) {
    const firstSize = jsonBytes([messages[0]])
    while (picked.length > 1 && used + firstSize > budget) {
      used -= jsonBytes([picked.shift()])
    }
    if (used + firstSize <= budget) picked.unshift(messages[0])
  }
  // 兜底：单条自己就超预算时上面两道都拦不住（首条是无条件放行的），
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
 * 后台跑一次总结并改名，结果写进 job。
 * @param ctx - 暴露 llm / sessionTitle 的上下文。
 * @param resolved - 已校验的官方策略配置。
 * @param session - 目标会话（调用方已确认活着且有内容）。
 * @param job - 结果槽 {status, title?, error?}。
 */
async function summarize(ctx, resolved, session, job, fallback) {
  const controller = new AbortController()
  const safety = setTimeout(
    () => controller.abort(new Error('summarize timed out')),
    resolved.timeoutMs + 15000,
  )
  try {
    const messages = humanMessagesOf(session)
    const selected = fitMessages(messages, resolved.maxInputBytes)
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
    let lastError = new Error('no attempt ran')
    for (const attempt of attempts) {
      try {
        const result = await generateSessionTitleWithLlm(
          ctx,
          resolved,
          { session, messages, ...(attempt.route === undefined ? {} : { route: attempt.route }), signal: controller.signal },
          selected,
          name,
        )
        const title = shortTitle(result.title)
        ctx.sessionTitle.rename(session, title)
        job.status = 'done'
        job.title = title
        job.usedRoute = attempt.label
        ctx.logger.info(`dsh-session-namer: "${session.id}" renamed to "${title}" (route: ${attempt.label})`)
        return
      } catch (error) {
        lastError = error
        ctx.logger.warn(`dsh-session-namer: attempt "${attempt.label}" failed: ${String(error?.message ?? error)}`)
      }
    }
    throw lastError
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
  const resolved = resolveSessionTitleLlmConfig({
    targetWords: config?.targetWords ?? DEFAULTS.targetWords,
    targetCjkCharacters: config?.targetCjkCharacters ?? DEFAULTS.targetCjkCharacters,
    maxInputBytes: config?.maxInputBytes ?? DEFAULTS.maxInputBytes,
    maxOutputTokens: config?.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    timeoutMs: config?.timeoutMs ?? DEFAULTS.timeoutMs,
    ...(config?.provider === undefined ? {} : { provider: config.provider }),
    ...(config?.model === undefined ? {} : { model: config.model }),
  })

  // 兜底路由：会话路由失败时用于重试（成对给；可用配置覆盖默认的官方路由）。
  const fallback =
    config?.fallbackProvider !== undefined && config?.fallbackModel !== undefined
      ? { provider: config.fallbackProvider, model: config.fallbackModel }
      : { provider: FALLBACK_DEFAULTS.provider, model: FALLBACK_DEFAULTS.model }

  /** jobId -> 结果槽。只活在进程内，结果也只给点按钮的那个客户端看。 */
  const jobs = new Map()

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        async handler(req, res) {
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
          void summarize(ctx, resolved, session, job, fallback)
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
  DEFAULTS,
  ROUTE,
  TITLE_MAX_WIDTH,
}
