/**
 * dsh-role-prompts host 端离线自检（基础链路）。
 *
 * 用一个最小的 ctx 模拟 cordis 宿主，验证：
 *   1) webServer 路由注册齐全；
 *   2) /api/list、/api/state 能读到角色表；
 *   3) 未激活时不注入；
 *   4) /api/activate 之后每轮注入岗位指令；
 *   5) /api/deactivate 之后恢复原样；
 *   6) 显式 `-角色名` / `@角色名` 前缀能激活。
 *
 * 运行：node test/basic.mjs（或 npm test）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// 用临时 DSH_HOME 完全隔离，绝不碰本机真实的 ~/.dsh
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "role-probe-"));

const TARGET = new URL("../index.js", import.meta.url);
const SESSION = "probe-session-0001";

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

/** @param {string} path @param {{method?: string, url?: string, body?: any}} options */
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

// ---------------------------------------------------------------- 路由注册
console.log("== 路由 ==");
const expectedRoutes = [
  "/dsh-role-prompts/api/list",
  "/dsh-role-prompts/api/state",
  "/dsh-role-prompts/api/activate",
  "/dsh-role-prompts/api/deactivate",
  "/dsh-role-prompts/api/save",
];
for (const path of expectedRoutes) check(`route ${path}`, routes.has(path), [...routes.keys()]);
check("event agent/inbox/inserted", events.has("agent/inbox/inserted"), [...events.keys()]);
check("event system-prompt/assemble", events.has("system-prompt/assemble"), [...events.keys()]);

// ---------------------------------------------------------------- 角色表
console.log("\n== 角色表 ==");
const list = await call("/dsh-role-prompts/api/list");
check("GET /api/list ok", list.status === 200 && list.json && list.json.ok === true, list.raw);
const roles = (list.json && list.json.value && list.json.value.roles) || [];
check("读到一个以上角色", roles.length > 0, roles.length);
const target = roles[0];
console.log(`  角色：${roles.map((r) => r.name).join(" / ")}`);

// ---------------------------------------------------------------- 注入夹具
const insertEvent = events.get("agent/inbox/inserted");
const assembleEvent = events.get("system-prompt/assemble");
const BASE = "BASE-SECTION";

function userMessage(text) {
  return { id: "probe-msg", role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

/** 模拟用户发一条消息（只触发 inbox 插入，不改写消息本身）。 */
async function send(text) {
  const message = userMessage(text);
  await insertEvent({ agent: { id: SESSION }, message });
  return message;
}

/** 模拟一次 system prompt 组装，返回拼起来的 section 文本。 */
async function assemble(scope = { id: SESSION }) {
  const assembly = {
    sections: [{ name: "base", text: BASE }],
    contexts: [],
    tools: [],
    variables: {},
  };
  const out = await assembleEvent(assembly, { scope }, async () => assembly);
  const texts = (out.sections || []).map((section) => section.text).join("\n");
  return { out, texts };
}

const markdownOf = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

// ---------------------------------------------------------------- 未激活
console.log("\n== 未激活 ==");
const plainMessage = await send("帮我看一下这个函数");
check("消息原样不改写", markdownOf(plainMessage) === "帮我看一下这个函数", markdownOf(plainMessage));
const before = await assemble();
check("未激活时不注入 system prompt", !before.texts.includes("<role_activation"), before.texts.slice(0, 160));
check("未激活时保留原有 section", before.texts.includes(BASE), before.texts.slice(0, 160));

// ---------------------------------------------------------------- 激活
console.log("\n== 激活会话角色 ==");
const activated = await call("/dsh-role-prompts/api/activate", {
  method: "POST",
  body: { sessionId: SESSION, name: target.name },
});
check("POST /api/activate ok", activated.status === 200 && activated.json && activated.json.ok === true, activated.raw);

const state = await call("/dsh-role-prompts/api/state", { url: `/dsh-role-prompts/api/state?sessionId=${SESSION}` });
check("/api/state 反映激活", state.json && state.json.value && state.json.value.active === target.name, state.raw);

// ---------------------------------------------------------------- 每轮注入
console.log("\n== 激活后每轮注入 ==");
const round1 = await assemble();
check("第一轮注入角色块", round1.texts.includes(target.name), round1.texts.slice(0, 160));
check("第一轮下发完整岗位指令", round1.texts.includes(target.content.trim().slice(0, 24)), round1.texts.slice(0, 240));
check("第一轮保留原有 section", round1.texts.includes(BASE), round1.texts.slice(0, 160));
check("角色段排在最后", (round1.out.sections[round1.out.sections.length - 1] || {}).name !== "base", round1.out.sections.map((s) => s.name).join(","));

const round2 = await assemble();
check("第二轮仍然注入（会话级）", round2.texts.includes(target.name), round2.texts.slice(0, 160));
const occurrences = round2.out.sections.filter((section) => section.name === "base").length;
check("原有 section 不被重复", occurrences === 1, round2.out.sections.map((s) => s.name).join(","));
const roleSections = round2.out.sections.filter((section) => (section.text || "").includes("<role_activation")).length;
check("角色段只有一份", roleSections === 1, roleSections);

// ---------------------------------------------------------------- 停用
console.log("\n== 停用 ==");
const deactivated = await call("/dsh-role-prompts/api/deactivate", {
  method: "POST",
  body: { sessionId: SESSION },
});
check("POST /api/deactivate ok", deactivated.status === 200 && deactivated.json && deactivated.json.ok === true, deactivated.raw);
const after = await assemble();
check("停用后不再注入", !after.texts.includes("<role_activation"), after.texts.slice(0, 160));

// ---------------------------------------------------------------- 显式 -角色名 前缀
console.log("\n== 显式 -角色名 前缀 ==");
const explicitMessage = await send(`-${target.name} 帮我审一下这段代码`);
check("显式前缀不改写消息", markdownOf(explicitMessage) === `-${target.name} 帮我审一下这段代码`, markdownOf(explicitMessage));
const explicit = await assemble();
check("显式前缀触发激活", explicit.texts.includes(target.name), explicit.texts.slice(0, 160));
check("正文不进入 system prompt", !explicit.texts.includes("帮我审一下这段代码"), explicit.texts.slice(0, 200));
const explicitState = await call("/dsh-role-prompts/api/state", { url: `/dsh-role-prompts/api/state?sessionId=${SESSION}` });
check("显式前缀顺带激活会话", explicitState.json && explicitState.json.value && explicitState.json.value.active === target.name, explicitState.raw);
await call("/dsh-role-prompts/api/deactivate", { method: "POST", body: { sessionId: SESSION } });

// ---------------------------------------------------------------- @角色名 chip
console.log("\n== @角色名 chip ==");
await send(`@${target.name} 继续上次的评审`);
const chip = await assemble();
check("chip 形态也能激活", chip.texts.includes(target.name), chip.texts.slice(0, 160));
await call("/dsh-role-prompts/api/deactivate", { method: "POST", body: { sessionId: SESSION } });

// ---------------------------------------------------------------- 边界
console.log("\n== 边界 ==");
const noScope = await assemble(undefined);
check("无 scope 时不注入", !noScope.texts.includes("<role_activation"), noScope.texts.slice(0, 120));
const unknown = await send("-不存在的角色 随便聊聊");
const unknownAssembly = await assemble();
check("未知角色不激活", !unknownAssembly.texts.includes("<role_activation"), unknownAssembly.texts.slice(0, 120));
check("未知角色消息不改写", markdownOf(unknown) === "-不存在的角色 随便聊聊", markdownOf(unknown));

console.log(`\n== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ==`);
process.exit(failures === 0 ? 0 : 1);
