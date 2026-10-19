// @deepseek-ai/dsh-session-title-llm 的离线桩（镜像 DSH 0.2.1 的真实契约）。
//
// 只在 selftest 里生效，绝不进入运行时。0.2.1 把这个包从
// generateSessionTitleWithLlm() 改成了 executeSessionTitleLlm()，并且
// resolveSessionTitleLlmConfig() 改成只接受执行控制字段（多一个 key 就抛）。
// 桩故意复刻这两点：插件如果退回旧 API 写法，自检会立刻失败。
const CONFIG_KEYS = new Set(['maxInputBytes', 'maxOutputTokens', 'timeoutMs', 'provider', 'model'])
const MAX_TIMER_DELAY_MS = 2147483647

const assertPositiveInteger = (name, value) => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`session-title-llm: ${name} must be a positive integer`)
}

/** 与真实包同款的严格校验：拒绝未知 key、非正整数、provider/model 不成对。 */
export const resolveSessionTitleLlmConfig = (config) => {
  if (config === null || typeof config !== 'object') throw new Error('session-title-llm: configuration is required')
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`)
  }
  assertPositiveInteger('maxInputBytes', config.maxInputBytes)
  assertPositiveInteger('maxOutputTokens', config.maxOutputTokens)
  assertPositiveInteger('timeoutMs', config.timeoutMs)
  if (config.timeoutMs > MAX_TIMER_DELAY_MS) throw new Error('session-title-llm: timeoutMs must not exceed MAX_TIMER_DELAY_MS')
  const hasProvider = config.provider !== undefined
  if (hasProvider !== (config.model !== undefined)) throw new Error('session-title-llm: provider and model must be supplied together')
  return Object.freeze({ ...config })
}

/** 真实的 executeSessionTitleLlm 由自检用 ctx.llm.__stubTitleCall 替换掉网络调用。 */
export const executeSessionTitleLlm = async (ctx, config, request, titleProvider, prepared) => {
  if (typeof ctx.llm?.__stubTitleCall === 'function') {
    return ctx.llm.__stubTitleCall({ config, request, titleProvider, prepared })
  }
  throw new Error('stub: 离线自检不应真的调用模型')
}

/** 旧版导出：仅用于直接测 legacyTitle 分支（插件在 0.2.1 下不会走到它）。 */
export const generateSessionTitleWithLlm = async (ctx, config, request, messages, titleProvider) => {
  if (typeof ctx.llm?.__stubLegacyCall === 'function') {
    return ctx.llm.__stubLegacyCall({ config, request, messages, titleProvider })
  }
  throw new Error('stub: 离线自检不应真的调用模型')
}
