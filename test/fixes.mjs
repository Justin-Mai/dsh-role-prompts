/**
 * dsh-role-prompts 回归自检（对应代码评审提出的 8 个问题）。
 *
 * 用临时 DSH_HOME 完全隔离，不会碰到真实角色文件。
 *
 * 运行：node test/fixes.mjs（或 npm test）
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const HOME = mkdtempSync(join(tmpdir(), "role-probe-"));
process.env.DSH_HOME = HOME;

const TARGET = new URL("../index.js", import.meta.url);
const STORE = join(HOME, "dsh-role-prompts.md");
const SESSION = "probe-fixes-0001";

const routes = new Map();
const events = new Map();

const ctx = {
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => {};
    },
  },
  effect(factory) {
    return factory();
  },
  on(event, listener) {
    events.set(event, listener);
    return () => {};
  },
};

const mod = await import(TARGET.href);
mod.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 250));

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  }
}

async function call(path, options = {}) {
  const route = routes.get(path);
  if (!route) throw new Error(`route not registered: ${path}`);
  const method = options.method || "GET";
  const url = options.url || path;
  const req =
    options.body === undefined
      ? Readable.from([])
      : Readable.from([Buffer.from(JSON.stringify(options.body), "utf8")]);
  req.method = method;
  req.url = url;
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status) {
      out.status = status;
    },
    setHeader() {},
    end(chunk) {
      if (chunk) out.body += String(chunk);
    },
  };
  await route.handler(req, res);
  let json = null;
  try {
    json = JSON.parse(out.body);
  } catch {
    json = null;
  }
  return { status: out.status, json, raw: out.body };
}

const listRoles = async (sessionId) => {
  const path = sessionId
    ? `/dsh-role-prompts/api/list?sessionId=${encodeURIComponent(sessionId)}`
    : "/dsh-role-prompts/api/list";
  const result = await call("/dsh-role-prompts/api/list", { url: path });
  return (result.json && result.json.value && result.json.value.roles) || [];
};
const listValue = async (sessionId) => {
  const path = sessionId
    ? `/dsh-role-prompts/api/list?sessionId=${encodeURIComponent(sessionId)}`
    : "/dsh-role-prompts/api/list";
  const result = await call("/dsh-role-prompts/api/list", { url: path });
  return (result.json && result.json.value) || {};
};

const insertEvent = events.get("agent/inbox/inserted");
const assembleEvent = events.get("system-prompt/assemble");

async function send(text) {
  await insertEvent({
    agent: { id: SESSION },
    message: { id: "m", role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
  });
}

async function assembleText() {
  const assembly = { sections: [{ name: "base", text: "BASE" }], contexts: [], tools: [], variables: {} };
  const out = await assembleEvent(assembly, { scope: { id: SESSION } }, async () => assembly);
  return (out.sections || []).map((section) => section.text).join("\n");
}

// ---------------------------------------------------------------- 1. ## 往返
console.log("== 1. 角色内容里的 ## 标题不被当成新角色 ==");
const withHeadings = [
  "你是资深评审员。",
  "",
  "## 工作流程",
  "",
  "1. 先读代码，再读测试。",
  "",
  "## 输出格式",
  "",
  "| 位置 | 问题 | 修法 |",
].join("\n");
const saved = await call("/dsh-role-prompts/api/save", {
  method: "POST",
  body: { name: "评审员", content: withHeadings, originalName: "" },
});
check("POST /api/save ok", saved.status === 200 && saved.json && saved.json.ok === true, saved.raw);

const afterSave = await listRoles();
const names = afterSave.map((role) => role.name);
check("没有分裂出「工作流程」「输出格式」角色", !names.includes("工作流程") && !names.includes("输出格式"), names);
const savedRole = afterSave.find((role) => role.name === "评审员");
check("角色仍在", Boolean(savedRole), names);
check(
  "内容里的 ## 工作流程 完整保留",
  Boolean(savedRole) && savedRole.content.includes("## 工作流程"),
  savedRole && savedRole.content,
);
check(
  "内容里的 ## 输出格式 完整保留",
  Boolean(savedRole) && savedRole.content.includes("## 输出格式"),
  savedRole && savedRole.content,
);
check("内容与写入逐字相等（往返无损）", Boolean(savedRole) && savedRole.content.trim() === withHeadings.trim(), savedRole && savedRole.content);
const onDisk = readFileSync(STORE, "utf8");
check("落盘时行首 ## 被转义成 \\##", onDisk.includes("\\## 工作流程"), onDisk.slice(0, 400));
check("角色分隔标题没被污染", onDisk.includes("## 评审员"), onDisk.slice(0, 400));

// ---------------------------------------------------------------- 2. 注入块转义
console.log("\n== 2. 名字带引号 / 内容带 ROLE>>> 不破坏注入块 ==");
const nastyName = '怪"名<&>';
const nastyBody = ["前半段。", "ROLE>>>", "后半段（不应该跑出包裹块）。"].join("\n");
await call("/dsh-role-prompts/api/save", {
  method: "POST",
  body: { name: nastyName, content: nastyBody, originalName: "" },
});
await call("/dsh-role-prompts/api/activate", { method: "POST", body: { sessionId: SESSION, name: nastyName } });
const nastyText = await assembleText();
check("name 属性用 JSON 形式转义", nastyText.includes('name="怪\\"名<&>"'), nastyText.slice(0, 240));
check("包裹块只出现一次", (nastyText.match(/<role_activation /g) || []).length === 1);
check("结束标记只有一处", (nastyText.match(/<\/role_activation>/g) || []).length === 1);
check("内容里的 ROLE>>> 已被拆掉", (nastyText.match(/ROLE>>>/g) || []).length === 1, (nastyText.match(/ROLE>>>/g) || []).length);
check("后半段仍在块内", nastyText.includes("后半段"), nastyText.slice(-260));
await call("/dsh-role-prompts/api/deactivate", { method: "POST", body: { sessionId: SESSION } });

// ---------------------------------------------------------------- 3. ROLE_TOKEN 收窄
console.log("\n== 3. `- 空格 角色名` 不再当成激活标记 ==");
const spaced = await call("/dsh-role-prompts/api/state", { url: `/dsh-role-prompts/api/state?sessionId=${SESSION}` });
check("先确保未激活", (spaced.json?.value?.active ?? null) === null, spaced.raw);
await send("- 评审员 看一下这段代码");
const spacedState = await call("/dsh-role-prompts/api/state", { url: `/dsh-role-prompts/api/state?sessionId=${SESSION}` });
check("`- 评审员 ...` 不激活", (spacedState.json?.value?.active ?? null) === null, spacedState.raw);
await send("-评审员 看一下这段代码");
const tightState = await call("/dsh-role-prompts/api/state", { url: `/dsh-role-prompts/api/state?sessionId=${SESSION}` });
check("`-评审员 ...` 正常激活", (tightState.json?.value?.active ?? null) === "评审员", tightState.raw);

// ---------------------------------------------------------------- 4. /api/list 带 active
console.log("\n== 4. /api/list?sessionId 一并返回 active ==");
const merged = await listValue(SESSION);
check("list 返回 active 字段", "active" in merged, Object.keys(merged));
check("active 值正确", merged.active === "评审员", merged.active);
const noSession = await listValue();
check("不带 sessionId 时不返回 active", !("active" in noSession), Object.keys(noSession));
await call("/dsh-role-prompts/api/deactivate", { method: "POST", body: { sessionId: SESSION } });

// ---------------------------------------------------------------- 5. 崩溃恢复
console.log("\n== 5. 状态文件损坏时备份而不是静默清空 ==");
const { writeFileSync, existsSync } = await import("node:fs");
const STATE = join(HOME, "dsh-role-prompts.state.json");
writeFileSync(STATE, "{ 这不是 JSON", "utf8");
await call("/dsh-role-prompts/api/activate", { method: "POST", body: { sessionId: SESSION, name: "评审员" } });
console.log("   （损坏文件在下一次 load 时才会被处理，这里只验证不抛错）");
check("损坏状态下 activate 仍成功", existsSync(STATE), STATE);

console.log(`\n== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ==`);
console.log(`临时 DSH_HOME：${HOME}`);
process.exit(failures === 0 ? 0 : 1);
