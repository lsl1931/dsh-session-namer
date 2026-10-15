// @deepseek-ai/dsh-session-title-llm 的离线桩。
//
// 只在 selftest 里生效，绝不进入运行时。字段必须与真实包的
// resolveSessionTitleLlmConfig() 返回形状保持一致，否则 apply() 里读到的
// resolved.timeoutMs / resolved.maxInputBytes 会变成 undefined。
export const generateSessionTitleWithLlm = async () => {
  throw new Error('stub: 离线自检不应真的调用模型')
}
export const resolveSessionTitleLlmConfig = (config) => ({
  targetWords: 5,
  targetCjkCharacters: 8,
  maxInputBytes: 60000,
  maxOutputTokens: 160,
  timeoutMs: 30000,
  ...config,
})
