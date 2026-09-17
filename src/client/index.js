// dsh-session-namer client half: one button beside the session title. It asks the
// Node half to summarize the whole conversation with the session's own model and
// write the result as the session title; the title then flows to the header and the
// sidebar through the official title projection, so nothing else needs updating.
//
// 请求分两步：POST 拿 jobId（服务端立刻返回，避免长响应被中间层切断）→ 轮询 GET 拿结果。
//
// 刻意写成 JSX-free 的 CJS（和 dsh-usage-bar 一样），build.mjs 只做一层
// window.__ModuleLoader__ 包装，不需要任何转译工具链。
const { createElement, useEffect, useRef, useState } = require("react");

const BASE = "/dsh-session-namer";
const STYLE_ID = "dsh-session-namer-style";
const NOTE_TTL_MS = 6000;
const POLL_INTERVAL_MS = 700;
const POLL_DEADLINE_MS = 120000;
const POST_RETRIES = 2;
const POLL_MISS_TOLERANCE = 10;

const CSS =
  ".dsh-session-namer{box-sizing:border-box;height:24px;padding:0 10px;margin:0;border:1px solid var(--dsw-alias-border-l3);" +
  "border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;" +
  "line-height:16px;white-space:nowrap;cursor:pointer}" +
  ".dsh-session-namer:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
  ".dsh-session-namer:disabled{opacity:.55;cursor:default}";

// 顶栏空间有限：文案再长也只占这么多，超出打省略号（否则 pill 会把标题栏撑变形）。
const NOTE_MAX_WIDTH = "15em";
const CSS_NOTE = ".dsh-session-namer{overflow:hidden;text-overflow:ellipsis;max-width:" + NOTE_MAX_WIDTH + "}";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 服务端错误 -> 能塞进 pill 的短文案（匹配不上就原样显示）。 */
const SHORT_ERRORS = [
  [/no human message|no-human-message/i, "无文字可总结"],
  [/session is not live/i, "会话未打开"],
  [/unknown or expired jobId/i, "结果已过期"],
];

function shortError(text) {
  for (const [pattern, label] of SHORT_ERRORS) {
    if (pattern.test(text)) return label;
  }
  return text;
}

/**
 * 读一次响应：先拿文本再自己解析，好把"响应体不完整"和"服务端明确报错"区分开。
 * @param res - fetch 的 Response。
 * @returns {status, json, text}
 */
function readResponse(res) {
  return res.text().then((text) => {
    let json = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch (error) {
      json = null;
    }
    return { status: res.status, json, text };
  });
}

/**
 * 总结当前会话并重命名。
 * @param props - 头栏插槽注入的会话上下文（含 sessionId）。
 * @returns 按钮元素。
 */
function NamerButton(props) {
  const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setNote("");
  }, [sessionId]);

  useEffect(() => {
    if (note === "") return undefined;
    const timer = setTimeout(() => setNote(""), NOTE_TTL_MS);
    return () => clearTimeout(timer);
  }, [note]);

  const run = () => {
    if (busy || sessionId === "") return;
    setBusy(true);
    setNote("");

    const settle = (text) => {
      if (!aliveRef.current) return;
      setNote(text);
      setBusy(false);
    };

    // POST 只负责拿到 jobId；网络层偶发失败重试几次，服务端明确报错则不重试。
    const start = (left) =>
      fetch(BASE + "/name", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
        .then(readResponse)
        .catch((error) => {
          if (left > 0) return delay(600).then(() => start(left - 1));
          throw error;
        });

    const poll = (jobId, deadline, misses) => {
      if (Date.now() > deadline) return Promise.reject(new Error("等待结果超时"));
      return delay(POLL_INTERVAL_MS)
        .then(() =>
          fetch(BASE + "/name?jobId=" + encodeURIComponent(jobId))
            .then(readResponse)
            .catch(() => null),
        )
        .then((out) => {
          if (out === null || out.json === null || out.json === undefined) {
            if (misses + 1 >= POLL_MISS_TOLERANCE) throw new Error("轮询连续失败");
            return poll(jobId, deadline, misses + 1);
          }
          if (out.json.ok !== true) throw new Error(String(out.json.error ?? "HTTP " + String(out.status)));
          if (out.json.status === "done") return String(out.json.title ?? "");
          return poll(jobId, deadline, 0);
        });
    };

    start(POST_RETRIES)
      .then((out) => {
        if (out.json === null || out.json === undefined || out.json.ok !== true) {
          throw new Error(String(out.json?.error ?? "HTTP " + String(out.status)));
        }
        if (typeof out.json.jobId !== "string") throw new Error("服务端没有返回 jobId");
        return poll(out.json.jobId, Date.now() + POLL_DEADLINE_MS, 0);
      })
      .then((title) => settle(title === "" ? "已重命名" : "已重命名：" + title))
      .catch((error) => {
        console.warn("dsh-session-namer:", error);
        settle("失败：" + shortError(String(error?.message ?? error)));
      });
  };

  return createElement(
    "button",
    {
      type: "button",
      className: "dsh-session-namer",
      disabled: busy || sessionId === "",
      title: note === "" ? "用该会话当前的模型总结整段对话，并把它重命名为简短标题" : note,
      onClick: run,
    },
    busy ? "总结中…" : note === "" ? "总结命名" : note,
  );
}

const inject = ["slots"];

function apply(ctx) {
  if (typeof document === "undefined") return;

  ctx.effect(() => {
    if (document.getElementById(STYLE_ID) === null) {
      const tag = document.createElement("style");
      tag.id = STYLE_ID;
      tag.textContent = CSS + CSS_NOTE;
      document.head.appendChild(tag);
    }
    return () => {
      const existing = document.getElementById(STYLE_ID);
      if (existing) existing.remove();
    };
  }, "dsh-session-namer: stylesheet");

  // 挂 utilities 而不是 actions：桌面壳（DSH Desktop 的 preload 布局）把 titleRow 顶到
  // 0–36px 的无边框标题栏拖拽区里，actions 落在 y≈9–33，正好被 #dsh-desktop-windows-drag-region
  // 盖住（elementFromPoint 命中的是拖拽层，不是按钮），点不动。壳的 CSS 只把 utilities 重排到
  // top:38px（拖拽区下方）并给按钮兜底 no-drag，所以放这里才能点。
  ctx.slots.inject("conversation.session.header.utilities", () =>
    ctx.slots.register(
      { name: "conversation.session.header.utilities", id: "dsh-session-namer", order: 60 },
      NamerButton,
    ),
  );
}

exports.inject = inject;
exports.apply = apply;
