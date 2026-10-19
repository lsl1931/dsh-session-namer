// dsh-session-namer 离线自检（零依赖、不需要 profile、不需要运行中的宿主）：
// 1) 纯逻辑：人类消息采集、字节预算裁剪、标题收窄；
// 2) 路由流程：POST 立刻发 jobId -> GET 轮询，含信任围栏；
// 3) 浏览器 half：错误文案映射与顶栏宽度上限；
// 4) --installed：把工作区构建产物与 profile 里的安装副本逐字节比对。
//
// 为什么不再 import 安装副本：lib/index.js 顶层 import
// '@deepseek-ai/dsh-session-title-llm'，而那个包由宿主的 Loader 在运行时解析，
// 普通 node 进程解析不到 —— 旧写法会在导入阶段就 exit(1)，下面的断言从来没有
// 执行过。现在改为挂本地解析桩 + 直接导入工作区构建产物：测的就是要发布的东西。
//
// 用法:
//   node selftest-session-namer.mjs                纯逻辑 + 路由（默认）
//   node selftest-session-namer.mjs --installed    额外比对 profile 安装副本
//   node selftest-session-namer.mjs <lib/index.js> 指定构建产物
import { createRequire, register } from 'node:module'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const checkInstalled = argv.includes('--installed')
const override = argv.find((arg) => arg.startsWith('--') === false)

// 宿主的 Loader 才解析 @deepseek-ai/*；这里把该 specifier 指到本地桩，让导入图
// 能走通（桩不参与任何运行时逻辑）。
register('./selftest/stub-framework.mjs', import.meta.url)

const target = override ?? join(here, 'lib', 'index.js')

const fail = (message) => {
	console.error('[fail] ' + message)
	process.exit(1)
}
const skip = (message) => console.log('[skip] ' + message)

// ---- 1) 导入工作区构建产物
let module
try {
	module = await import(pathToFileURL(target).href)
} catch (error) {
	fail('导入 ' + target + ' 失败：' + String(error?.message ?? error))
}
if (typeof module.apply !== 'function') fail('缺少 apply 导出')
if (!Array.isArray(module.inject) || module.inject.includes('webServer') === false) fail('缺少 webServer 注入')
if (!module.inject.includes('connection')) fail('inject 必须声明 connection（路由自带信任围栏）')
const { humanMessageOf, humanMessagesOf, fitMessages, DEFAULTS, ROUTE } = module.__test ?? {}
if (humanMessageOf === undefined) fail('缺少 __test 导出')

// ---- 2) 人类消息采集规则（与 dsh-session-title 一致）
const userEvent = (seq, text, kind = 'user') => ({
	seq,
	type: 'user/message',
	data: { source: { kind }, content: [{ type: 'text', text }] },
})
const cases = [
	[userEvent(1, 'hello'), true],
	[userEvent(2, '   '), false],
	[userEvent(3, 'x', 'plugin'), false],
	[{ seq: 4, type: 'assistant/message', data: {} }, false],
	[{ seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', data: 'x' }] } }, false],
]
for (const [event, expected] of cases) {
	const hit = humanMessageOf(event) !== undefined
	if (hit !== expected) fail(`humanMessageOf(seq=${event.seq}) 期望 ${expected}，实际 ${hit}`)
}
const collected = humanMessagesOf({
	snapshotEvents: () => [
		userEvent(1, 'first'),
		userEvent(2, '  '),
		userEvent(3, 'plugin text', 'plugin'),
		userEvent(4, 'fourth'),
	],
})
if (JSON.stringify(collected) !== JSON.stringify([{ seq: 1, text: 'first' }, { seq: 4, text: 'fourth' }])) {
	fail(`采集结果不符: ${JSON.stringify(collected)}`)
}

// ---- 3) 字节预算裁剪
const big = (seq, bytes) => ({ seq, text: 'x'.repeat(bytes) })
const budget = 4000
if (fitMessages([big(0, 100), big(1, 100), big(2, 100)], budget).length !== 3) fail('预算充足时应全部带上')
const many = []
for (let i = 0; i < 40; i += 1) many.push(big(i, 200))
const fitted = fitMessages(many, budget)
if (fitted.length === 0 || fitted.length >= many.length) fail(`裁剪后应少于全部且非空，实际 ${fitted.length}`)
if (fitted[fitted.length - 1].seq !== many[many.length - 1].seq) fail('必须保留最后一条（最近的上下文）')
if (fitted[0].seq !== 0) fail(`首条能塞下时应带上首条（交代意图），实际首条 seq=${fitted[0].seq}`)
const usedBytes = Buffer.byteLength(JSON.stringify(fitted), 'utf8')
if (usedBytes > budget) fail(`裁剪后仍超出预算: ${usedBytes} > ${budget}`)
if (fitMessages([big(0, 20000)], budget).length !== 1) fail('单条超预算时仍应带上一条，不能返回空集')

// 单条自己就超预算时必须截断，否则官方策略按 UTF-8 字节拒收。
const huge = [{ seq: 0, text: '中'.repeat(50000) }]
const hugeFitted = fitMessages(huge, budget)
if (hugeFitted.length !== 1) fail('单条超大消息应保留一条（截断后）')
if (Buffer.byteLength(JSON.stringify(hugeFitted), 'utf8') > budget) {
  fail('单条超大消息没有截断到预算内')
}
if (hugeFitted[0].text.length === 0) fail('截断后不应变成空文本')

// 预算是 UTF-8 字节，不是 UTF-16 码元：中文消息必须按 3 字节算，
// 否则官方策略会用 Buffer.byteLength 拒收（曾经的 bug）。
const cjk = []
for (let i = 0; i < 30; i += 1) cjk.push({ seq: i, text: '中'.repeat(1000) })
const cjkFitted = fitMessages(cjk, budget)
const cjkBytes = Buffer.byteLength(JSON.stringify(cjkFitted), 'utf8')
if (cjkFitted.length === 0) fail('中文会话裁剪后不应为空')
if (cjkBytes > budget) fail(`中文消息按字节算仍超预算: ${cjkBytes} > ${budget}（说明还在按码元计）`)
if (cjkFitted.length >= cjk.length) fail('1000 汉字 × 30 条必须被裁剪，不能整段放行')

// 长会话不能只留"首条 + 最近"：首尾之间必须至少采到一条中段消息。
const spread = []
for (let i = 0; i < 60; i += 1) spread.push(big(i, 300))
const spreadFitted = fitMessages(spread, budget)
const spreadSeqs = spreadFitted.map((message) => message.seq)
if (!spreadSeqs.includes(0)) fail('长会话应带上首条')
if (!spreadSeqs.includes(59)) fail('长会话应带上最后一条')
if (!spreadSeqs.some((seq) => seq > 0 && seq < 59)) fail('长会话应至少采样一条中段消息: ' + spreadSeqs.join(','))

// ---- 4) 默认配置过官方校验（仅当本进程能解析到官方包时才跑）
if (ROUTE !== '/dsh-session-namer/name') fail('路由不符: ' + ROUTE)
let officialEntry = null
for (const base of [target, join(here, 'package.json')]) {
	try {
		officialEntry = createRequire(base).resolve('@deepseek-ai/dsh-session-title-llm')
		break
	} catch {
		officialEntry = null
	}
}
if (officialEntry === null) {
	skip('本进程解析不到 @deepseek-ai/dsh-session-title-llm（由宿主在运行时解析），跳过官方配置校验')
} else {
	const { resolveSessionTitleLlmConfig } = await import(pathToFileURL(officialEntry).href)
	// 0.2.1 的执行控制只认 maxInputBytes / maxOutputTokens / timeoutMs / provider / model；
	// 标题长度目标属于提示词参数，不能再塞进这里（会抛 unknown config key）。
	const controls = {
		maxInputBytes: DEFAULTS.maxInputBytes,
		maxOutputTokens: DEFAULTS.maxOutputTokens,
		timeoutMs: DEFAULTS.timeoutMs,
	}
	try {
		resolveSessionTitleLlmConfig(controls)
	} catch (error) {
		fail('默认执行控制没通过官方校验: ' + String(error?.message ?? error))
	}
	let paired = false
	try {
		resolveSessionTitleLlmConfig({ ...controls, provider: 'dy' })
	} catch {
		paired = true
	}
	if (!paired) fail('只给 provider 不给 model 时官方校验应当报错')
}

// ---- 5) 标题收窄（显示宽度：CJK 记 2）
const { shortTitle, TITLE_MAX_WIDTH, DEFAULTS: DEFAULTS_REF } = module.__test
if (shortTitle === undefined) fail('缺少 shortTitle 导出')
const truncated = shortTitle('DSH模型推理强度获取与置顶会话', 28)
if (truncated !== 'DSH模型推理强度获取与置顶会') fail(`短标题截断不符: ${JSON.stringify(truncated)}`)
if (shortTitle('a'.repeat(40)) !== 'a'.repeat(TITLE_MAX_WIDTH)) fail('纯 ASCII 标题应按宽度截断')
if (shortTitle('a'.repeat(40), 20) !== 'a'.repeat(20)) fail('显式宽度参数未生效')
if (TITLE_MAX_WIDTH !== 36) fail('默认显示宽度应为 36，实际 ' + TITLE_MAX_WIDTH)
if (shortTitle('  ') !== '') fail('纯空白应当收敛为空串')
if (shortTitle(' \n a \n\n b ') !== 'a b') fail('空白应折叠')
if (shortTitle('置顶会话') !== '置顶会话') fail('够短的标题不应被改动')
// 模型会违反官方 "no Markdown" 要求返回 **粗体** / `代码` / # 标题；
// 实测 wkbd/deepseek-v4.1-flash 返回过 "**执行全部修复并重启** 备选"，
// 星号会原样出现在顶栏和侧栏，必须剥掉。
if (shortTitle('**执行全部修复并重启** 备选') !== '执行全部修复并重启 备选') fail('粗体星号未剥离')
if (shortTitle('**Session title:** `Execute') !== 'Session title: Execute') fail('混合 Markdown 未剥离')
if (shortTitle('## 标题') !== '标题') fail('行首 # 未剥离')
if (shortTitle('`code` 修复') !== 'code 修复') fail('行内代码记号未剥离')
if (shortTitle('**a** 和 **b**') !== 'a 和 b') fail('多组记号未剥离')
if (shortTitle('正常标题') !== '正常标题') fail('普通标题不应被改动')
const stripped = shortTitle('**' + '中文'.repeat(40) + '**')
if (stripped.includes('*')) fail('剥星号后不该残留星号')
if (stripped.length >= '中文'.repeat(40).length) fail('剥星号后仍须按宽度截断')
if (DEFAULTS_REF.targetCjkCharacters !== 12 || DEFAULTS_REF.targetWords !== 8) {
	fail(`默认标题长度应为 8 词 / 12 个 CJK 字，实际 ${JSON.stringify(DEFAULTS_REF)}`)
}
if (DEFAULTS_REF.maxTitleWidth !== 36) fail('默认 maxTitleWidth 应为 36，实际 ' + DEFAULTS_REF.maxTitleWidth)
// 输出预算不是标题长度：推理型路由会先花 100~160 个 thinking token，160 会被吃光。
if (DEFAULTS_REF.maxOutputTokens !== 1024) fail('默认 maxOutputTokens 应为 1024，实际 ' + DEFAULTS_REF.maxOutputTokens)

// ---- 6) 异步路由流程：POST 立刻发 jobId -> GET 轮询（用假 ctx，不依赖运行中的服务器）
let handler = null
const renameCalls = []
const session = {
	id: 'live',
	snapshotEvents: () => [
		{ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
	],
	requestHeader: () => undefined,
}
const fakeCtx = {
	connection: { requestRejection: () => undefined },
	effect: (fn) => {
		fn()
		return () => {}
	},
	webServer: {
		register: (route) => {
			handler = route.handler
			return () => {}
		},
	},
	sessions: { get: (id) => (id === 'live' ? session : undefined) },
	sessionTitle: { rename: (_session, title) => renameCalls.push(title) },
	llm: {},
	logger: { info: () => {}, warn: () => {} },
}
module.apply(fakeCtx)
if (handler === null) fail('apply 没有注册路由')

const call = (method, url, body) =>
	new Promise((resolve, reject) => {
		const req = {
			method,
			url,
			on(event, callback) {
				if (event === 'data' && body !== undefined) callback(Buffer.from(body))
				if (event === 'end') callback()
				return req
			},
			destroy() {},
		}
		const res = {
			writeHead(status, headers) {
				this.statusCode = status
				this.headers = headers
				return this
			},
			end(chunk) {
				const text = chunk ?? ''
				let json = null
				try {
					json = JSON.parse(text)
				} catch (error) {
					reject(new Error(`响应不是 JSON: ${text}`))
					return
				}
				resolve({ status: this.statusCode, json })
			},
		}
		Promise.resolve(handler(req, res)).catch(reject)
	})

const started = await call('POST', ROUTE, JSON.stringify({ sessionId: 'live' }))
if (started.status !== 202 || started.json.ok !== true) fail(`POST 应立刻返回 202 + ok，实际 ${JSON.stringify(started)}`)
if (typeof started.json.jobId !== 'string' || started.json.jobId.length === 0) fail('POST 没有返回 jobId')

const polled = await call('GET', `${ROUTE}?jobId=${encodeURIComponent(started.json.jobId)}`)
if (polled.status !== 200) fail(`GET 轮询应返回 200，实际 ${polled.status}`)
if (polled.json.status !== 'running' && polled.json.status !== 'error') {
	fail(`轮询状态应为 running/error，实际 ${JSON.stringify(polled.json)}`)
}
if (polled.json.status === 'error' && typeof polled.json.error !== 'string') fail('失败状态必须带 error 文本')
if (renameCalls.length > 0) fail('假 llm 下不应该真的改名')

const unknown = await call('GET', `${ROUTE}?jobId=nope`)
if (unknown.status !== 404) fail(`未知 jobId 应 404，实际 ${unknown.status}`)
const wrongMethod = await call('DELETE', ROUTE)
if (wrongMethod.status !== 405) fail(`非 POST/GET 应 405，实际 ${wrongMethod.status}`)
const deadSession = await call('POST', ROUTE, JSON.stringify({ sessionId: 'missing' }))
if (deadSession.status !== 404) fail(`非活跃会话应 404，实际 ${deadSession.status}`)

// 只有图片、没有文字的人类消息 -> 409，且错误文案必须短到能塞进顶栏 pill。
const imageOnly = {
  id: 'image-only',
  snapshotEvents: () => [
    {
      seq: 8,
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 483, height: 38, bytes: 5106 } }],
      },
    },
  ],
  requestHeader: () => undefined,
}
fakeCtx.sessions.get = (id) => (id === 'live' ? session : id === 'image-only' ? imageOnly : undefined)
const imageOnlyCall = await call('POST', ROUTE, JSON.stringify({ sessionId: 'image-only' }))
if (imageOnlyCall.status !== 409) fail(`纯图片会话应 409，实际 ${imageOnlyCall.status}`)
if (imageOnlyCall.json.code !== 'no-human-message') fail(`409 应带 code=no-human-message，实际 ${JSON.stringify(imageOnlyCall.json)}`)
if (String(imageOnlyCall.json.error).length > 12) fail(`409 文案太长，会撑爆顶栏 pill: ${imageOnlyCall.json.error}`)

// ---- 6b) 信任围栏：路由不在 /api 下，必须自己对每个请求过闸
let fencedHandler = null
let fenceCalls = 0
const fencedCtx = {
	...fakeCtx,
	connection: { requestRejection: () => { fenceCalls += 1; return 401 } },
	webServer: { register: (route) => { fencedHandler = route.handler; return () => {} } },
	sessions: { get: () => { throw new Error('围栏拒绝时不应查询会话') } },
}
module.apply(fencedCtx)
if (fencedHandler === null) fail('apply 没有注册路由（围栏用例）')

const callFenced = (method, url, body) =>
	new Promise((resolve, reject) => {
		const req = {
			method,
			url,
			headers: {},
			on(event, callback) {
				if (event === 'data' && body !== undefined) callback(Buffer.from(body))
				if (event === 'end') callback()
				return req
			},
			destroy() {},
		}
		const res = {
			statusCode: 0,
			body: undefined,
			writeHead(status) {
				this.statusCode = status
				return this
			},
			end(chunk) {
				this.body = chunk
				resolve({ status: this.statusCode, body: this.body })
			},
		}
		Promise.resolve(fencedHandler(req, res)).catch(reject)
	})

const fencedGet = await callFenced('GET', ROUTE)
if (fencedGet.status !== 401) fail('GET 未过围栏时应返回 401，实际 ' + fencedGet.status)
if (fencedGet.body !== undefined) fail('围栏拒绝时不应带响应体')
const fencedPost = await callFenced('POST', ROUTE, JSON.stringify({ sessionId: 'live' }))
if (fencedPost.status !== 401) fail('POST 未过围栏时应返回 401，实际 ' + fencedPost.status)
if (fenceCalls < 2) fail('GET 与 POST 都必须经过围栏，实际调用 ' + fenceCalls + ' 次')

// ---- 6c) DSH >= 0.2.1 的共享策略：executeSessionTitleLlm 全流程
const { titleFromResponse, frameMessages, systemPrompt, MODERN_TITLE_LLM } = module.__test
if (MODERN_TITLE_LLM !== true) fail('桩导出 executeSessionTitleLlm 时应识别为新版共享策略')
if (titleFromResponse({ blocks: [{ type: 'text', text: '**新标题**\n第二行解释' }], finish: { kind: 'stop' } }) !== '**新标题**') {
	fail('新版响应应取第一条非空行')
}
for (const finish of ['tool-calls', 'max-tokens']) {
	let threw = false
	try {
		titleFromResponse({ blocks: [], finish: { kind: finish } })
	} catch {
		threw = true
	}
	if (!threw) fail(`finish=${finish} 时应当抛错`)
}
const promptText = systemPrompt({ targetWords: 8, targetCjkCharacters: 12 }, false)
if (!promptText.includes('8 words') || !promptText.includes('12 CJK characters')) {
	fail('系统提示词没有带上标题长度目标')
}
if (promptText.includes('exactly unchanged')) fail('没有当前标题时不应带稳定性规则')
const anchoredPrompt = systemPrompt({ targetWords: 8, targetCjkCharacters: 12 }, true)
if (!anchoredPrompt.includes('exactly unchanged')) fail('有当前标题时应带稳定性规则')
const framed = frameMessages({ humanMessages: [{ seq: 1, text: 'hi' }] })
if (!framed.includes('JSON object') || !framed.includes('"seq":1')) fail('输入 framing 应把载荷框成 JSON 对象')

let modernHandler = null
const modernRenames = []
let captured = null
const assistantEvent = (seq, text) => ({
	seq,
	type: 'assistant/message',
	data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const toolEvent = (seq, name) => ({ seq, type: 'tool/call', data: { name, arguments: '{}' } })
const modernSession = {
	id: 'modern',
	snapshotEvents: () => [
		userEvent(1, '第一段需求'),
		userEvent(2, '补充要求'),
		toolEvent(3, 'bash'),
		assistantEvent(4, '已经完成插件兼容性修复'),
		toolEvent(5, 'read'),
	],
	requestHeader: () => ({ config: { provider: 'tx', model: 'deepseek-v4.1-flash' } }),
	append: () => {},
}
const modernCtx = {
	connection: { requestRejection: () => undefined },
	effect: (fn) => {
		fn()
		return () => {}
	},
	webServer: { register: (route) => { modernHandler = route.handler; return () => {} } },
	sessions: { get: (id) => (id === 'modern' ? modernSession : undefined) },
	sessionTitle: {
		get: () => ({ title: '旧标题', source: { kind: 'provider' } }),
		rename: (_session, title) => modernRenames.push(title),
	},
	logger: { info: () => {}, warn: () => {} },
	llm: {
		__stubTitleCall: (input) => {
			captured = input
			return {
				blocks: [
					{ type: 'text', text: '**新版标题**' },
					{ type: 'text', text: '第二行解释' },
				],
				finish: { kind: 'stop' },
				model: input.request.route,
			}
		},
	},
}
module.apply(modernCtx)
if (modernHandler === null) fail('新版路径 apply 没有注册路由')

const requestOn = (targetHandler, method, url, body) =>
	new Promise((resolve, reject) => {
		const req = {
			method,
			url,
			on(event, callback) {
				if (event === 'data' && body !== undefined) callback(Buffer.from(body))
				if (event === 'end') callback()
				return req
			},
			destroy() {},
		}
		const res = {
			writeHead(status) {
				this.statusCode = status
				return this
			},
			end(chunk) {
				const text = chunk ?? ''
				try {
					resolve({ status: this.statusCode, json: JSON.parse(text) })
				} catch {
					reject(new Error('新版路径响应不是 JSON: ' + text))
				}
			},
		}
		Promise.resolve(targetHandler(req, res)).catch(reject)
	})

const startedModern = await requestOn(modernHandler, 'POST', ROUTE, JSON.stringify({ sessionId: 'modern' }))
if (startedModern.status !== 202 || typeof startedModern.json.jobId !== 'string') {
	fail('新版路径 POST 应立刻返回 202 + jobId，实际 ' + JSON.stringify(startedModern))
}
let done = null
for (let attempt = 0; attempt < 50; attempt += 1) {
	const polledModern = await requestOn(modernHandler, 'GET', `${ROUTE}?jobId=${encodeURIComponent(startedModern.json.jobId)}`)
	if (polledModern.json.status === 'done' || polledModern.json.status === 'error') {
		done = polledModern.json
		break
	}
	await new Promise((resolve) => setTimeout(resolve, 20))
}
if (done === null) fail('新版路径轮询超时')
if (done.status !== 'done') fail('新版路径没有成功改名: ' + JSON.stringify(done))
if (done.title !== '新版标题') fail('标题收窄结果不符: ' + JSON.stringify(done))
if (modernRenames.length !== 1 || modernRenames[0] !== '新版标题') {
	fail('新版路径应调用 sessionTitle.rename 一次且标题正确，实际 ' + JSON.stringify(modernRenames))
}
if (captured === null) fail('新版共享策略没有被调用')
if (captured.titleProvider !== 'dsh-session-namer') fail('titleProvider 身份不符: ' + captured.titleProvider)
if (!Array.isArray(captured.prepared.messageSeqs) || captured.prepared.messageSeqs.join(',') !== '1,2') {
	fail('messageSeqs 应来自选中的消息: ' + JSON.stringify(captured.prepared.messageSeqs))
}
const payload = JSON.parse(captured.prepared.input.slice(captured.prepared.input.indexOf('\n') + 1))
if (payload.currentTitle !== '旧标题') fail('载荷应带上当前标题作为稳定性锚点: ' + JSON.stringify(payload.currentTitle))
if (!Array.isArray(payload.humanMessages) || payload.humanMessages.length !== 2) {
	fail('载荷应带上选中的用户消息: ' + JSON.stringify(payload.humanMessages))
}
if (payload.lastAssistantReply !== '已经完成插件兼容性修复') {
	fail('载荷应带上最后一条助手回复: ' + JSON.stringify(payload.lastAssistantReply))
}
if (JSON.stringify(payload.toolsUsed) !== JSON.stringify(['bash', 'read'])) {
	fail('载荷应带上工具名: ' + JSON.stringify(payload.toolsUsed))
}
if (!captured.prepared.system.includes('exactly unchanged')) fail('有锚点时系统提示词应包含稳定性规则')
if (captured.prepared.selectReasoningEffort({ reasoning: { efforts: [{ id: 'off' }] } }) !== 'off') {
	fail('推理档位应取模型支持的最低档')
}
if (captured.config.targetWords !== undefined || captured.config.targetCjkCharacters !== undefined) {
	fail('执行控制里不应混入标题长度目标（0.2.1 会抛 unknown config key）')
}
if (captured.request.signal === undefined) fail('必须把取消信号传给共享策略')
if (captured.request.route.provider !== 'tx') fail('应跟随会话当前路由: ' + JSON.stringify(captured.request.route))

// ---- 6d) 失败路径：默认不再兜底到 deepseek-official；错误要带出每次尝试
const failSession = {
	id: 'fail',
	snapshotEvents: () => [userEvent(1, 'hi')],
	requestHeader: () => ({ config: { provider: 'tx', model: 'm' } }),
}
let failHandler = null
const failRoutes = []
const failCtx = {
	connection: { requestRejection: () => undefined },
	effect: (fn) => {
		fn()
		return () => {}
	},
	webServer: { register: (route) => { failHandler = route.handler; return () => {} } },
	sessions: { get: (id) => (id === 'fail' ? failSession : undefined) },
	sessionTitle: { rename: () => fail('失败路径不应改名') },
	logger: { info: () => {}, warn: () => {} },
	llm: {
		__stubTitleCall: (input) => {
			failRoutes.push(input.request.route)
			throw new Error('primary boom')
		},
	},
}
module.apply(failCtx)
const failStarted = await requestOn(failHandler, 'POST', ROUTE, JSON.stringify({ sessionId: 'fail' }))
let failResult = null
for (let attempt = 0; attempt < 50; attempt += 1) {
	const polled = await requestOn(failHandler, 'GET', `${ROUTE}?jobId=${encodeURIComponent(failStarted.json.jobId)}`)
	if (polled.json.status !== 'running') {
		failResult = polled.json
		break
	}
	await new Promise((resolve) => setTimeout(resolve, 20))
}
if (failResult?.status !== 'error') fail('失败路径应进入 error: ' + JSON.stringify(failResult))
if (!String(failResult.error).includes('session: primary boom')) {
	fail('错误里应带上会话路由的真实原因: ' + failResult.error)
}
if (String(failResult.error).includes('deepseek-official')) {
	fail('默认不应再尝试 deepseek-official 兜底: ' + failResult.error)
}
if (failRoutes.length !== 1) fail('默认只应尝试会话路由一次，实际 ' + failRoutes.length)

// 显式配置兜底时才打第二条路由
let fbHandler = null
const fbRoutes = []
const fbRenames = []
const fbCtx = {
	...failCtx,
	webServer: { register: (route) => { fbHandler = route.handler; return () => {} } },
	sessionTitle: { rename: (_session, title) => fbRenames.push(title) },
	llm: {
		__stubTitleCall: (input) => {
			const route = input.request.route
			fbRoutes.push(route.provider)
			if (route.provider === 'tx') throw new Error('primary down')
			return { blocks: [{ type: 'text', text: '兜底标题' }], finish: { kind: 'stop' }, model: route }
		},
	},
}
module.apply(fbCtx, { fallbackProvider: 'fp', fallbackModel: 'fm' })
const fbStarted = await requestOn(fbHandler, 'POST', ROUTE, JSON.stringify({ sessionId: 'fail' }))
let fbResult = null
for (let attempt = 0; attempt < 50; attempt += 1) {
	const polled = await requestOn(fbHandler, 'GET', `${ROUTE}?jobId=${encodeURIComponent(fbStarted.json.jobId)}`)
	if (polled.json.status !== 'running') {
		fbResult = polled.json
		break
	}
	await new Promise((resolve) => setTimeout(resolve, 20))
}
if (fbResult?.status !== 'done' || fbResult.title !== '兜底标题') {
	fail('显式兜底没有拿到标题: ' + JSON.stringify(fbResult))
}
if (fbRoutes.join(',') !== 'tx,fp') {
	fail('显式兜底应依次尝试会话路由与兜底路由，实际 ' + fbRoutes.join(','))
}
if (fbRenames.length !== 1 || fbRenames[0] !== '兜底标题') {
	fail('显式兜底改名不符: ' + JSON.stringify(fbRenames))
}

// ---- 7) client half：错误文案映射与顶栏宽度上限（假 DOM + 假 react）
const clientPath = join(dirname(target), 'client.js')
const styles = []
globalThis.document = {
	getElementById: (id) => styles.find((style) => style.id === id) ?? null,
	createElement: () => ({ id: '', textContent: '', dataset: {} }),
	head: { appendChild: (tag) => { styles.push(tag) } },
}
const cells = []
let cursor = 0
const fakeReact = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (init) => {
		const index = cursor++
		cells[index] ??= { value: typeof init === 'function' ? init() : init }
		return [cells[index].value, (next) => { cells[index].value = typeof next === 'function' ? next(cells[index].value) : next }]
	},
	useEffect: () => {},
	useRef: (init) => { const index = cursor++; cells[index] ??= { current: init }; return cells[index] },
}
let registered = null
const fakeWindow = { __ModuleLoader__: { load: (mod) => { registered = mod } } }
const fakeRequire = (spec) => {
	if (spec === 'react') return fakeReact
	throw new Error(`client half 意外 require: ${spec}`)
}
try {
	new Function('window', 'require', readFileSync(clientPath, 'utf8'))(fakeWindow, fakeRequire)
} catch (error) {
	fail(`client half 执行失败: ${String(error?.message ?? error)}`)
}
if (registered === null) fail('client half 没有注册模块')
const clientMod = registered.factory(fakeRequire)
let Button = null
clientMod.apply({
	effect: (fn) => { fn(); return () => {} },
	slots: { inject: (_name, fn) => fn(), register: (_meta, component) => { Button = component; return () => {} } },
})
if (typeof Button !== 'function') fail('client half 没有注册按钮组件')
const css = styles[0]?.textContent ?? ''
if (!/text-overflow:ellipsis/.test(css) || !/max-width:15em/.test(css)) fail('按钮缺少宽度上限/省略号，长文案会撑爆顶栏')

const renderButton = () => { cursor = 0; return Button({ sessionId: 's1' }) }
const buttonLabel = () => {
	const element = renderButton()
	return (Array.isArray(element.children) ? element.children : [element.children]).join('')
}
const reply = (status, body) => () => Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) })
const originalWarn = console.warn
console.warn = () => {}
try {
	// 服务端旧英文文案也必须映射成短中文（升级前装的服务端仍在跑）
	globalThis.fetch = reply(409, { ok: false, error: 'this session has no human message to summarize' })
	renderButton().props.onClick()
	await new Promise((resolve) => setTimeout(resolve, 30))
	if (buttonLabel() !== '失败：无文字可总结') fail(`旧英文 409 未映射成短文案: ${buttonLabel()}`)
	// 未知错误要原样透出，不能被吞成"失败：失败"
	globalThis.fetch = reply(500, { ok: false, error: 'boom' })
	renderButton().props.onClick()
	await new Promise((resolve) => setTimeout(resolve, 30))
	if (buttonLabel() !== '失败：boom') fail(`未知错误应原样显示: ${buttonLabel()}`)
} finally {
	console.warn = originalWarn
	delete globalThis.document
}

// ---- 8) --installed：工作区构建产物 vs profile 安装副本（逐字节）
if (checkInstalled) {
	const home = (process.env.DSH_HOME ?? '').trim() !== ''
		? process.env.DSH_HOME.trim()
		: join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.dsh')
	const profilesRoot = join(home, 'profiles')
	const files = ['lib/index.js', 'lib/client.js', 'package.json', 'cordis.patch.yml']
	const copies = []
	try {
		for (const name of readdirSync(profilesRoot)) {
			const dir = join(profilesRoot, name, 'node_modules', 'dsh-session-namer')
			if (existsSync(join(dir, 'lib', 'index.js'))) copies.push({ name, dir })
		}
	} catch {
		// profiles 目录不存在：按"没有安装副本"处理
	}
	if (copies.length === 0) {
		skip('在 ' + profilesRoot + ' 下没有找到 dsh-session-namer 的安装副本')
	} else {
		for (const copy of copies) {
			for (const file of files) {
				if (!existsSync(join(copy.dir, file))) fail(copy.name + ': 缺少 ' + file)
				const same = readFileSync(join(here, file)).equals(readFileSync(join(copy.dir, file)))
				if (!same) fail(copy.name + ': ' + file + ' 与工作区构建产物不一致（安装副本过期）')
			}
			console.log('[ok] ' + copy.name + ': ' + files.length + ' 个文件与工作区一致')
		}
	}
}

console.log('[ok] 消息采集、字节裁剪、标题收窄、围栏、POST->jobId->轮询流程、新版共享策略、client 文案映射全部通过')
console.log('     ' + target)
