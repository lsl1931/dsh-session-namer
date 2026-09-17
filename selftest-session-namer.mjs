// dsh-session-namer 离线自检：
// 1) 装到 profile 里的那份能不能解析框架 import（这是 link/复制最容易踩的坑）；
// 2) 人类消息采集规则与字节预算裁剪的行为；
// 3) 默认配置能过官方 session-title-llm 的校验（provider/model 必须成对出现等）。
// 用法: node selftest-session-namer.mjs [lib/index.js 路径]
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const target =
	process.argv[2] ??
	`${process.env.USERPROFILE}\\.dsh\\profiles\\web\\node_modules\\dsh-session-namer\\lib\\index.js`

const fail = (message) => {
	console.error(`[fail] ${message}`)
	process.exit(1)
}

// ---- 1) 导入安装副本（顺带验证框架 import 能解析）
let module
try {
	module = await import(pathToFileURL(target).href)
} catch (error) {
	fail(`导入失败（框架 import 解析不了？）：${String(error?.message ?? error)}`)
}
if (typeof module.apply !== 'function') fail('缺少 apply 导出')
if (!Array.isArray(module.inject) || module.inject.includes('webServer') === false) fail('缺少 webServer 注入')
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

// ---- 4) 默认配置过官方校验（从安装副本解析官方包，顺带再验一次解析链）
if (ROUTE !== '/dsh-session-namer/name') fail(`路由不符: ${ROUTE}`)
const requireFromInstalled = createRequire(target)
let resolveSessionTitleLlmConfig
try {
	const resolved = requireFromInstalled.resolve('@deepseek-ai/dsh-session-title-llm')
	;({ resolveSessionTitleLlmConfig } = await import(pathToFileURL(resolved).href))
} catch (error) {
	fail(`解析官方 session-title-llm 失败：${String(error?.message ?? error)}`)
}
try {
	resolveSessionTitleLlmConfig({ ...DEFAULTS })
} catch (error) {
	fail(`默认配置没通过官方校验: ${String(error?.message ?? error)}`)
}
let paired = false
try {
	resolveSessionTitleLlmConfig({ ...DEFAULTS, provider: 'dy' })
} catch {
	paired = true
}
if (!paired) fail('只给 provider 不给 model 时官方校验应当报错')

// ---- 5) 标题收窄（显示宽度：CJK 记 2）
const { shortTitle, TITLE_MAX_WIDTH, DEFAULTS: DEFAULTS_REF } = module.__test
if (shortTitle === undefined) fail('缺少 shortTitle 导出')
const truncated = shortTitle('DSH模型推理强度获取与置顶会话')
if (truncated !== 'DSH模型推理强度获取与置顶会') fail(`短标题截断不符: ${JSON.stringify(truncated)}`)
if (shortTitle('a'.repeat(40)) !== 'a'.repeat(TITLE_MAX_WIDTH)) fail('纯 ASCII 标题应按宽度截断')
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
if (DEFAULTS_REF.targetCjkCharacters !== 8 || DEFAULTS_REF.targetWords !== 5) {
	fail(`默认标题长度应为 5 词 / 8 个 CJK 字，实际 ${JSON.stringify(DEFAULTS_REF)}`)
}

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

// ---- 7) client half：错误文案映射与顶栏宽度上限（假 DOM + 假 react）
const clientPath = target.replace(/lib[\\/]index\.js$/, 'lib\\client.js')
const styles = []
globalThis.document = {
	getElementById: (id) => styles.find((style) => style.id === id) ?? null,
	createElement: () => ({ id: '', textContent: '' }),
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

console.log('[ok] 框架 import 可解析；消息采集、字节裁剪、标题收窄、POST→jobId→轮询路由流程、默认配置校验、client 文案映射全部通过')
console.log(`     ${target}`)
