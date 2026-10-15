// 离线自检用的模块解析钩子。
//
// lib/index.js 顶层 import '@deepseek-ai/dsh-session-title-llm'，而那个包由宿主的
// Loader 在运行时解析 —— 普通 node 进程按 Node 的解析规则找不到它，旧版自检因此
// 在导入阶段就 exit(1)，后面的断言从未执行过。
//
// 这里只把这一个 specifier 指到本地桩，让导入图能走通；桩不参与任何运行时逻辑。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-session-title-llm') {
    return { url: new URL('./stub-title-llm.js', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
