/**
 * dsh-role-prompts — 浏览器端（client.js）
 *
 * 挂两个槽位：
 *   1) conversation.input.overlay —— 输入框上方浮层：草稿整段为 `-查询` 时
 *      弹出角色候选，↑↓ 选择、Enter/Tab 确认、Esc 取消。确认后经
 *      `slash/input-insert-reference` 在草稿里插入一枚与 `@文件` 同构的
 *      reference chip（序列化形态 `@角色名`），用户继续输入正文后回车发送。
 *   2) settings.section —— 设置左栏「角色指令」页：增删改角色（名称 + 岗位指令），
 *      通过同源 fetch 调用 node 端 /dsh-role-prompts/api/* 路由，持久化到
 *      ~/.dsh/dsh-role-prompts.md。
 *
 * 角色指令真正生效的位置在 node 端：
 *   - `agent/inbox/inserted` 解析行首标记并记录该会话的激活角色；
 *   - `system-prompt/assemble` 把角色段拼进 system prompt（不污染对话气泡）。
 */
window.__ModuleLoader__.load({
  id: "dsh-role-prompts",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** react-dom 的 portal（不可用时退化为就地渲染 fixed 浮层）。 */
    let createPortal = null;
    try {
      const reactDom = require("react-dom");
      if (reactDom && typeof reactDom.createPortal === "function") createPortal = reactDom.createPortal;
    } catch (error) {
      createPortal = null;
    }

    // ------------------------------------------------------------------ 样式
    // 颜色一律使用「灰阶半透明 + 继承文本色」：不依赖主题 token 名，明暗主题下都自然。
    const STYLE_ID = "dsh-role-prompts-style";
    const CSS = `
.rp-popup{position:fixed;z-index:2147483000;box-sizing:border-box;max-height:min(48vh,420px);display:flex;flex-direction:column;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  color:inherit;background:rgba(128,128,128,.16);border:1px solid rgba(128,128,128,.34);border-radius:14px;
  box-shadow:0 18px 48px rgba(0,0,0,.28);backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);
  overflow:hidden;animation:rp-pop .12s ease-out}
@keyframes rp-pop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.rp-popup-head{display:flex;align-items:center;gap:8px;padding:9px 13px 7px;font-size:11px;letter-spacing:.04em;
  text-transform:uppercase;opacity:.62;border-bottom:1px solid rgba(128,128,128,.22);flex:0 0 auto}
.rp-popup-head b{font-weight:650;letter-spacing:.02em;text-transform:none;font-size:12px;opacity:1}
.rp-popup-body{overflow-y:auto;overscroll-behavior:contain;padding:5px;flex:1 1 auto;min-height:0}
.rp-item{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border-radius:9px;cursor:pointer;user-select:none}
.rp-item[data-active="true"]{background:rgba(128,128,128,.30)}
.rp-item:hover{background:rgba(128,128,128,.22)}
.rp-item-main{min-width:0;flex:1 1 auto}
.rp-item-name{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rp-item-name em{font-style:normal;font-weight:400;opacity:.45;font-size:11px;margin-left:6px;letter-spacing:.03em}
.rp-item-desc{margin-top:2px;font-size:11.5px;line-height:1.45;opacity:.62;display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.rp-popup-foot{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:7px 13px;font-size:11px;opacity:.55;
  border-top:1px solid rgba(128,128,128,.22)}
.rp-popup-foot kbd{font:inherit;font-size:10.5px;padding:1px 5px;border-radius:5px;border:1px solid rgba(128,128,128,.4);
  background:rgba(128,128,128,.16)}
.rp-empty{padding:16px 14px;font-size:12px;opacity:.66;line-height:1.6}
.rp-empty b{font-weight:600}

.rp-settings{display:flex;flex-direction:column;gap:14px;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",
  "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:inherit;height:100%;min-height:380px;box-sizing:border-box}
.rp-settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex:0 0 auto}
.rp-title{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}
.rp-desc{margin:6px 0 0;font-size:12px;line-height:1.65;opacity:.62;max-width:62ch}
.rp-desc code,.rp-path code{font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;padding:1px 5px;border-radius:5px;
  background:rgba(128,128,128,.20)}
.rp-path{margin:0;font-size:11.5px;opacity:.55;word-break:break-all}
.rp-body{display:flex;gap:16px;flex:1 1 auto;min-height:0}
.rp-list{flex:0 0 208px;display:flex;flex-direction:column;gap:3px;overflow-y:auto;padding-right:4px;min-height:0}
.rp-list-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;text-align:left;
  background:transparent;border:1px solid transparent;color:inherit;font:inherit;width:100%;box-sizing:border-box}
.rp-list-item:hover{background:rgba(128,128,128,.14)}
.rp-list-item[data-active="true"]{background:rgba(128,128,128,.22);border-color:rgba(128,128,128,.34)}
.rp-list-name{flex:1 1 auto;min-width:0;font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rp-badge{flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(128,128,128,.26);opacity:.75}
.rp-editor{flex:1 1 auto;display:flex;flex-direction:column;gap:9px;min-width:0;min-height:0}
.rp-field{display:flex;flex-direction:column;gap:5px;min-height:0}
.rp-label{font-size:11.5px;font-weight:600;opacity:.7;letter-spacing:.01em}
.rp-input,.rp-textarea{width:100%;box-sizing:border-box;border:1px solid rgba(128,128,128,.34);border-radius:9px;
  background:rgba(128,128,128,.10);color:inherit;font:12.5px/1.6 inherit;padding:8px 10px;outline:none;transition:border-color .12s}
.rp-input:focus,.rp-textarea:focus{border-color:rgba(128,128,128,.62);background:rgba(128,128,128,.14)}
.rp-textarea{resize:vertical;min-height:190px;font-family:ui-monospace,SFMono-Regular,Consolas,"Microsoft YaHei",monospace;
  font-size:12px;line-height:1.7}
.rp-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.rp-btn{appearance:none;border:1px solid rgba(128,128,128,.38);background:rgba(128,128,128,.14);color:inherit;
  font:inherit;font-size:12px;padding:6px 13px;border-radius:8px;cursor:pointer;transition:background .12s,border-color .12s}
.rp-btn:hover{background:rgba(128,128,128,.24);border-color:rgba(128,128,128,.5)}
.rp-btn:disabled{opacity:.4;cursor:not-allowed}
.rp-btn-primary{background:rgba(96,165,250,.20);border-color:rgba(96,165,250,.55)}
.rp-btn-primary:hover{background:rgba(96,165,250,.32)}
.rp-btn-danger{color:#e05252;border-color:rgba(224,82,82,.42)}
.rp-btn-danger:hover{background:rgba(224,82,82,.14)}
.rp-spacer{flex:1 1 auto}
.rp-hint{font-size:11.5px;opacity:.58}
.rp-error{color:#e05252;font-size:12px}
.rp-ok{color:#3fa45b;font-size:12px}
.rp-blank{display:flex;align-items:center;justify-content:center;flex:1 1 auto;font-size:12.5px;opacity:.5;text-align:center;
  border:1px dashed rgba(128,128,128,.3);border-radius:12px;padding:24px}
@media (max-width:720px){.rp-body{flex-direction:column}.rp-list{flex:0 0 auto;flex-direction:row;overflow-x:auto}}
.rp-item-action{margin-top:2px;border-top:1px solid rgba(128,128,128,.18)}
.rp-item-action .rp-item-name{font-weight:500;opacity:.72}
`;

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const tag = document.createElement("style");
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ------------------------------------------------------------------ HTTP
    const API = "/dsh-role-prompts/api";

    /**
     * 调用本插件的 node 端路由。
     * @param {string} path - 例如 "/list"
     * @param {unknown} [body] - 有值则 POST JSON
     */
    async function callApi(path, body) {
      const init =
        body === undefined
          ? { method: "GET" }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            };
      const response = await fetch(API + path, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const message =
          payload && payload.error && payload.error.message
            ? String(payload.error.message)
            : `请求失败（HTTP ${response.status}）`;
        throw new Error(message);
      }
      return payload.value;
    }

    /** 角色内容的首行摘要。 */
    function summaryOf(role) {
      const first = String(role.content || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)[0];
      return first || "（尚未填写岗位指令）";
    }

    // ------------------------------------------------------------- 输入框定位
    /** 找到当前编辑器的输入元素（优先焦点元素）。 */
    function composerElement() {
      if (typeof document === "undefined") return null;
      const active = document.activeElement;
      if (active && (active.tagName === "TEXTAREA" || active.isContentEditable === true)) return active;
      const areas = document.querySelectorAll("textarea");
      return areas.length > 0 ? areas[areas.length - 1] : null;
    }

    // ------------------------------------------------------- @ 角色引用（chip）
    /** 注册到 inputTriggers 的 source 名；input 机器按它把 chip 路由回本插件做序列化。 */
    const ROLE_SOURCE = "role";
    /** sessions 服务（apply 时捕获）：把 sessionId 解析成 session scope 才能派发输入事件。 */
    let sessionsRef = null;

    /**
     * 把草稿里的 `-查询` 片段替换成真正的 reference chip —— 和 `@文件` 是同一类节点，
     * 因此外观、整体删除、复制行为都与官方提及一致。
     * @param {string} sessionKey - 当前会话 id
     * @param {string} name - 角色名
     * @param {{ start: number, end: number, draftRev: number }} span - 被替换的草稿区间（含修订号 CAS）
     * @returns {boolean} input 机器是否真的执行了替换
     */
    function insertRoleChip(sessionKey, name, span) {
      const sessions = sessionsRef;
      if (!sessions || !sessionKey || typeof sessions.scope !== "function") return false;
      if (!span || !Number.isFinite(span.draftRev)) return false;
      let actx = null;
      try {
        actx = sessions.scope(sessionKey);
      } catch (error) {
        return false;
      }
      if (!actx || typeof actx.bail !== "function") return false;
      try {
        // bail(name, request) —— 不能传 thisArg，监听器签名是 (request) => true | undefined
        return (
          actx.bail("slash/input-insert-reference", {
            reference: {
              source: ROLE_SOURCE,
              ref: name,
              label: name,
              appearance: "file",
              clipboardText: `@${name}`,
            },
            span,
          }) === true
        );
      } catch (error) {
        return false;
      }
    }

    /** 整段草稿正好是 `-查询词` 时，算出要替换的草稿区间（跳过前导空白）。 */
    function tokenSpanOf(text, match, draftRev) {
      const lead = /^[\s\u3000]*/.exec(text)[0].length;
      return { start: lead, end: match[0].length, draftRev };
    }

    /**
     * 从槽 props 里取当前会话 id。
     * @param {any} props
     * @returns {string}
     */
    function sessionOf(props) {
      const raw = (props && (props.sessionKey || props.sessionId)) || "";
      return typeof raw === "string" ? raw : String(raw);
    }

    // ------------------------------------------------------------------ 浮层
    /** 整段草稿正好是 `-查询词` 时捕捉查询词。 */
    const TRIGGER = /^[\s\u3000]*[-\u2013\u2014\uff0d][\s\u3000]*([^\s\u3000]*)$/;

    /**
     * 输入框上方的角色候选浮层。
     * @param {any} props - conversation.input.overlay 的 Session standard props
     *        （useInput / inputActions / useConversation）。
     */
    function RolePopup(props) {
      const useInput = typeof props.useInput === "function" ? props.useInput : null;
      const inputActions = props.inputActions;
      const draft = useInput ? useInput((state) => (state ? state.draft : "")) : "";
      const draftRev = useInput ? useInput((state) => (state && state.draftRev) || 0) : 0;
      const text = typeof draft === "string" ? draft : "";

      const match = TRIGGER.exec(text);
      const sessionKey = sessionOf(props);
      const query = match ? match[1] : "";

      const [roles, setRoles] = useState(null);
      const [error, setError] = useState(null);
      const [dismissed, setDismissed] = useState(null);
      const [activeIndex, setActiveIndex] = useState(0);
      const [rect, setRect] = useState(null);
      const [activeRole, setActiveRole] = useState(null);

      const open = match !== null && dismissed !== text;

      // 每次打开都拉一次：角色表 + 本会话当前激活的角色（省一次 /state 往返）。
      // 依赖里不放 roles，否则 setRoles 会把自己再触发一遍。
      useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        const path = sessionKey ? `/list?sessionId=${encodeURIComponent(sessionKey)}` : "/list";
        callApi(path)
          .then((value) => {
            if (!alive) return;
            setRoles(Array.isArray(value.roles) ? value.roles : []);
            setActiveRole(typeof value.active === "string" ? value.active : null);
            setError(null);
          })
          .catch((cause) => {
            if (!alive) return;
            setError(cause instanceof Error ? cause.message : String(cause));
            setRoles([]);
          });
        return () => {
          alive = false;
        };
      }, [open, sessionKey]);

      const filtered = useMemo(() => {
        const list = roles || [];
        const needle = query.trim().toLowerCase();
        if (!needle) return list;
        return list.filter((role) => String(role.name).toLowerCase().includes(needle));
      }, [roles, query]);

      // 激活角色变化后（重新打开浮层）由上面的 /list 调用带回，无需单独轮询

      /** 列表行：普通角色行 + 有激活角色时的「停用」行。 */
      const rows = useMemo(() => {
        const list = filtered.map((role) => ({ kind: "role", role, key: role.name }));
        if (activeRole && !query.trim()) {
          list.push({ kind: "clear", role: null, key: "\u0000clear", name: activeRole });
        }
        return list;
      }, [filtered, activeRole, query]);

      useEffect(() => {
        setActiveIndex(0);
      }, [query, open]);

      // 跟踪输入框位置（浮层贴在它上方）
      useEffect(() => {
        if (!open) return undefined;
        let timer = null;
        const measure = () => {
          const element = composerElement();
          if (!element) return;
          const bounds = element.getBoundingClientRect();
          setRect((previous) => {
            if (
              previous &&
              Math.abs(previous.left - bounds.left) < 0.5 &&
              Math.abs(previous.width - bounds.width) < 0.5 &&
              Math.abs(previous.top - bounds.top) < 0.5
            ) {
              return previous;
            }
            return { left: bounds.left, width: bounds.width, top: bounds.top };
          });
        };
        measure();
        timer = window.setInterval(measure, 300);
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return () => {
          if (timer !== null) window.clearInterval(timer);
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        };
      }, [open]);

      /** 停用本会话的角色，并清掉草稿里的角色标记（只删角色前缀，保留其它正文）。 */
      const clearRole = useCallback(async () => {
        if (!sessionKey) return;
        try {
          await callApi("/deactivate", { sessionId: sessionKey });
        } catch (cause) {
          console.warn("[dsh-role-prompts] 停用角色失败", cause);
        }
        setActiveRole(null);
        if (inputActions && typeof inputActions.setDraft === "function") {
          const marker = activeRole ? `@${activeRole}` : "";
          const rest = marker && text.startsWith(marker) ? text.slice(marker.length).replace(/^[ \t]+/, "") : text;
          if (rest !== text) inputActions.setDraft(rest);
        }
      }, [activeRole, inputActions, sessionKey, text]);

      const choose = useCallback(
        (row) => {
          if (!row) return;
          if (row.kind === "clear") {
            void clearRole();
            return;
          }
          const role = row.role;
          const canDraft = Boolean(inputActions) && typeof inputActions.setDraft === "function";
          if (!sessionKey) {
            // 拿不到会话标识：退回「草稿前缀」方式，由 host 的 agent/inbox/inserted 显式激活
            if (canDraft) inputActions.setDraft(`-${role.name} `);
            return;
          }
          // 把 `-查询` 换成真正的 reference chip（和 @文件 同一种节点）；失败再退回纯文本。
          //
          // 注意：这里**不**预激活会话角色。激活只发生在「带角色标记的消息真正进入
          // inbox」的那一刻（agent/inbox/inserted）—— 否则用户选中后又把 chip 回删，
          // 服务端已记下激活状态，提示词照样会被注入，和眼前的草稿对不上。
          const inserted =
            canDraft && match !== null && insertRoleChip(sessionKey, role.name, tokenSpanOf(text, match, draftRev));
          if (!inserted && canDraft) inputActions.setDraft(`@${role.name} `);
        },
        [clearRole, inputActions, sessionKey, text, match, draftRev],
      );

      // 键盘导航：capture 阶段拦截，避免 Enter 直接把消息发出去
      useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.isComposing || event.keyCode === 229) return;
          const count = rows.length;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            setActiveIndex((index) => (count > 0 ? (index + 1) % count : 0));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            setActiveIndex((index) => (count > 0 ? (index - 1 + count) % count : 0));
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            if (count === 0) return;
            event.preventDefault();
            event.stopPropagation();
            choose(rows[Math.min(activeIndex, count - 1)]);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(text);
          }
        };
        // window 的 capture 阶段最早触发：先于 React 的 root 委托与输入框自身的键处理，
        // 这样 Enter / Tab / 方向键不会漏到 composer 的发送逻辑里。
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
      }, [open, rows, activeIndex, choose, text]);

      if (!open) return null;

      const style = rect
        ? {
            left: Math.max(8, rect.left),
            width: Math.max(300, rect.width),
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
          }
        : { left: 24, width: 380, bottom: 140 };

      const body =
        error !== null
          ? h("div", { className: "rp-empty" }, h("b", null, "读取角色失败："), error)
          : roles === null
            ? h("div", { className: "rp-empty" }, "正在读取角色…")
            : rows.length === 0
              ? h(
                  "div",
                  { className: "rp-empty" },
                  roles.length === 0
                    ? h(
                        React.Fragment,
                        null,
                        "还没有任何角色。请到 ",
                        h("b", null, "设置 → 角色指令"),
                        " 里新建「名称 + 岗位指令」。",
                      )
                    : `没有匹配「${query}」的角色。`,
                )
              : rows.map((row, index) =>
                  h(
                    "div",
                    {
                      key: row.key,
                      className: row.kind === "clear" ? "rp-item rp-item-action" : "rp-item",
                      "data-active": index === activeIndex ? "true" : "false",
                      role: "option",
                      "aria-selected": index === activeIndex ? "true" : "false",
                      onMouseEnter: () => setActiveIndex(index),
                      onMouseDown: (event) => {
                        event.preventDefault();
                        choose(row);
                      },
                    },
                    h(
                      "div",
                      { className: "rp-item-main" },
                      row.kind === "clear"
                        ? h("div", { className: "rp-item-name" }, `停用「${row.name}」`)
                        : h(
                            "div",
                            { className: "rp-item-name" },
                            row.role.name,
                            h("em", null, "岗位角色"),
                          ),
                      h(
                        "div",
                        { className: "rp-item-desc" },
                        row.kind === "clear" ? "解除本会话的角色约束，回到默认行为" : summaryOf(row.role),
                      ),
                    ),
                  ),
                );

      const panel = h(
        "div",
        { className: "rp-popup", style, role: "dialog", "aria-label": "岗位角色" },
        h(
          "div",
          { className: "rp-popup-head" },
          h("b", null, "岗位角色"),
          h("span", null, query ? `匹配「${query}」` : "选择后会把该角色作为强制指令注入"),
        ),
        h("div", { className: "rp-popup-body", role: "listbox" }, body),
        h(
          "div",
          { className: "rp-popup-foot" },
          h("span", null, h("kbd", null, "↑"), h("kbd", null, "↓"), " 选择"),
          h("span", null, h("kbd", null, "Enter"), " 确认"),
          h("span", null, h("kbd", null, "Esc"), " 取消"),
        ),
      );

      return createPortal ? createPortal(panel, document.body) : panel;
    }

    // ------------------------------------------------------------------ 设置页
    /**
     * 设置左栏「角色指令」页。
     * @param {{ close?: () => void }} props - settings.section 的 owner props
     */
    function RoleSettings(props) {
      const [roles, setRoles] = useState(null);
      const [file, setFile] = useState("");
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      /** null = 未在编辑；否则为编辑草稿。 */
      const [editing, setEditing] = useState(null);
      const nameRef = useRef(null);
      /** 置 true 表示「下一次 editing 变化时要把焦点给名称框」。 */
      const focusNamePending = useRef(false);

      const applyValue = useCallback((value) => {
        setRoles(Array.isArray(value.roles) ? value.roles : []);
        setFile(typeof value.file === "string" ? value.file : "");
      }, []);

      useEffect(() => {
        let alive = true;
        callApi("/list")
          .then((value) => {
            if (!alive) return;
            applyValue(value);
            setError(null);
          })
          .catch((cause) => {
            if (!alive) return;
            setError(cause instanceof Error ? cause.message : String(cause));
            setRoles([]);
          });
        return () => {
          alive = false;
        };
      }, [applyValue]);

      useEffect(() => {
        setNotice(null);
      }, [editing]);

      // 只在「刚开始新建」时聚焦名称框。
      // 不能直接依赖 editing.isNew：editing 每次按键都是新对象，effect 会重跑，
      // 那样每敲一个字光标就被拽回名称输入框。
      useEffect(() => {
        if (!focusNamePending.current) return;
        focusNamePending.current = false;
        if (nameRef.current) nameRef.current.focus();
      }, [editing]);

      const startCreate = () => {
        focusNamePending.current = true;
        setEditing({ isNew: true, originalName: "", name: "", content: "" });
      };

      const startEdit = (role) => {
        setEditing({ isNew: false, originalName: role.name, name: role.name, content: role.content });
      };

      const submit = async () => {
        if (!editing) return;
        const name = editing.name.trim();
        if (!name) {
          setError("角色名称不能为空");
          return;
        }
        if (!editing.content.trim()) {
          setError("岗位指令内容不能为空");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const value = await callApi("/save", {
            name,
            content: editing.content,
            originalName: editing.isNew ? "" : editing.originalName,
          });
          applyValue(value);
          setEditing(null);
          setNotice(`已保存「${name}」`);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };

      const remove = async (role) => {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          if (!window.confirm(`删除角色「${role.name}」？此操作会立即改写 ${file || "角色文件"}。`)) return;
        }
        setBusy(true);
        setError(null);
        try {
          const value = await callApi("/delete", { name: role.name });
          applyValue(value);
          if (editing && editing.originalName === role.name) setEditing(null);
          setNotice(`已删除「${role.name}」`);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };

      const list =
        roles === null
          ? h("div", { className: "rp-hint" }, "正在读取…")
          : roles.length === 0
            ? h("div", { className: "rp-hint" }, "还没有角色")
            : roles.map((role) =>
                h(
                  "button",
                  {
                    key: role.name,
                    type: "button",
                    className: "rp-list-item",
                    "data-active": editing && !editing.isNew && editing.originalName === role.name ? "true" : "false",
                    onClick: () => startEdit(role),
                  },
                  h("span", { className: "rp-list-name" }, role.name),
                  h("span", { className: "rp-badge" }, `${String(role.content || "").length}`),
                ),
              );

      const editor = editing
        ? h(
            "div",
            { className: "rp-editor" },
            h(
              "div",
              { className: "rp-field" },
              h("label", { className: "rp-label" }, "角色名称"),
              h("input", {
                ref: nameRef,
                className: "rp-input",
                value: editing.name,
                placeholder: "例如：代码评审员 / 产品经理 / 法律顾问",
                spellCheck: false,
                onChange: (event) => setEditing({ ...editing, name: event.target.value }),
              }),
            ),
            h(
              "div",
              { className: "rp-field" },
              h("label", { className: "rp-label" }, "岗位角色指令"),
              h("textarea", {
                className: "rp-textarea",
                value: editing.content,
                placeholder:
                  "写清这个岗位的身份、职责边界、工作步骤、输出格式、禁止事项。\n\n越是明确、可检查的要求，模型越不会跑偏。",
                spellCheck: false,
                onChange: (event) => setEditing({ ...editing, content: event.target.value }),
              }),
            ),
            h(
              "div",
              { className: "rp-actions" },
              h(
                "button",
                { type: "button", className: "rp-btn rp-btn-primary", disabled: busy, onClick: submit },
                busy ? "保存中…" : "保存",
              ),
              h(
                "button",
                { type: "button", className: "rp-btn", disabled: busy, onClick: () => setEditing(null) },
                "取消",
              ),
              h("span", { className: "rp-spacer" }),
              editing.isNew
                ? null
                : h(
                    "button",
                    { type: "button", className: "rp-btn rp-btn-danger", disabled: busy, onClick: () => remove(editing) },
                    "删除",
                  ),
            ),
          )
        : h(
            "div",
            { className: "rp-blank" },
            roles && roles.length > 0
              ? "从左侧选择一个角色来编辑，或点右上角「新建角色」。"
              : "点右上角「新建角色」，写一个岗位角色开始。",
          );

      return h(
        "div",
        { className: "rp-settings" },
        h(
          "div",
          { className: "rp-settings-head" },
          h(
            "div",
            null,
            h("h2", { className: "rp-title" }, "角色指令"),
            h(
              "p",
              { className: "rp-desc" },
              "在输入框开头输入 ",
              h("code", null, "-"),
              " 会弹出角色列表，选中后即可开始对话。选中后该角色会",
              h("b", null, "对整个会话的后续每一轮都生效"),
              "：插件在每轮请求前把该角色的岗位指令拼进 system prompt，让模型按这个岗位的职责、视角与输出规范执行，而不是自由发挥。要换角色或停用，再输入 ",
              h("code", null, "-"),
              " 一次，浮层底部有「停用当前角色」一行。",
            ),
          ),
          h("button", { type: "button", className: "rp-btn rp-btn-primary", onClick: startCreate }, "新建角色"),
        ),
        file ? h("p", { className: "rp-path" }, "存储文件：", h("code", null, file)) : null,
        error !== null ? h("p", { className: "rp-error" }, error) : null,
        error === null && notice !== null ? h("p", { className: "rp-ok" }, notice) : null,
        h("div", { className: "rp-body" }, h("div", { className: "rp-list" }, list), editor),
      );
    }


    // ------------------------------------------------------------------ @ 引用源
    /**
     * 注册给 inputTriggers 的 source。它不提供 `@` 候选菜单（candidates 恒为空），
     * 只做两件事：
     *   1) `codec` —— 提交时把 chip 序列化成 `@角色名`，node 端据此识别角色；
     *   2) 让 input 机器按 source 名把 chip 路由回本插件。
     */
    const roleSource = {
      trigger: "@",
      name: ROLE_SOURCE,
      order: 900,
      showGroupTitle: false,
      candidates: async () => [],
      onPick: () => undefined,
      codec: {
        clipboardText: (ref) => `@${ref}`,
        serialize: async (ref) => `@${ref}`,
      },
    };

    // ------------------------------------------------------------------ 插件主体
    /** Required services: slots（布局挂载点）。 */
    const inject = ["slots"];

    /**
     * @param {any} ctx client root context
     */
    function apply(ctx) {
      ensureStyle();

      ctx.slots.inject("conversation.input.overlay", () =>
        ctx.slots.register(
          {
            name: "conversation.input.overlay",
            id: "role-prompts-popup",
            order: 10,
          },
          RolePopup,
        ),
      );

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "dsh-role-prompts",
            order: 50,
            label: "角色指令",
          },
          RoleSettings,
        ),
      );

      // 捕获 sessions 服务（插入 chip 时要按 sessionId 解析 session scope）
      ctx.inject(["sessions"], (scope) => {
        sessionsRef = scope.sessions;
        scope.effect(() => () => {
          sessionsRef = null;
        }, "dsh-role-prompts: sessions ref");
      });

      // 把 `@` 角色引用源注册进 input 触发管线（chip 的序列化与归属）
      ctx.inject(["inputTriggers"], (scope) => {
        scope.effect(() => scope.inputTriggers.registerSource(roleSource), "dsh-role-prompts: @role source");
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
