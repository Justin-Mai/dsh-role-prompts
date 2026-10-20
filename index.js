/**
 * dsh-role-prompts — node 端（host）
 *
 * 功能：
 *   1) 维护角色定义文件（默认 ~/.dsh/dsh-role-prompts.md），浏览器端设置页通过
 *      /dsh-role-prompts/api/* 读写它；
 *   2) 监听 agent/inbox/inserted 事件：当用户消息以 `-角色名称`（或 chip 序列化出的
 *      `@角色名称`）开头、且该名称命中角色表时，激活该角色，此后本对话持续有效；
 *   3) 监听 system-prompt/assemble 事件：把激活的角色作为一段 system prompt 注入，
 *      让模型严格按该岗位角色执行。走 system prompt 而非改写用户消息，因此对话框里
 *      只显示用户自己写的那句话，不会被一长串角色设定刷屏。
 *
 * 角色文件格式（也方便用户手工编辑）：
 *
 *   # dsh-role-prompts
 *
 *   <!-- 注释 -->
 *
 *   ## 代码评审员
 *   你是一名严格的代码评审员……
 *
 *   ## 产品经理
 *   你是……
 *
 * 二级标题即角色名，标题下的全部内容即该角色的岗位指令。
 */
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

const name = "dsh-role-prompts";
/** Required services: webServer（HTTP 路由）。 */
const inject = ["webServer"];

// ---------------------------------------------------------------------------
// 存储位置
// ---------------------------------------------------------------------------

const DSH_HOME =
  typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), ".dsh");

/** 角色定义文件：文件名即插件对应的名称。 */
const STORE_FILE = join(DSH_HOME, `${name}.md`);
/** 会话激活状态文件：记录每个会话当前激活的角色名。 */
const ACTIVATION_FILE = join(DSH_HOME, `${name}.state.json`);
/** 单个角色指令长度上限（字符）。 */
const MAX_ROLE_CONTENT = 200_000;
/** 角色名长度上限。 */
const MAX_ROLE_NAME = 80;
/** 激活状态最多保留的会话数（防止文件无限增长）。 */
const MAX_ACTIVATIONS = 200;
/**
 * 激活状态文件的结构版本。
 * v1 时代客户端在「选中角色」时就预激活会话，导致用户把 chip 回删后提示词仍被注入；
 * 那些记录无法与「真正提交过带角色标记的消息」区分，所以升级时整体丢弃一次。
 */
const STATE_VERSION = 2;

const FILE_HEADER = [
  `# ${name}`,
  "",
  "<!--",
  "  角色定义文件 · 由 dsh-role-prompts 插件的设置页维护，也可以手工编辑。",
  "  格式：每个角色以二级标题 `## 角色名称` 开始，标题下的全部内容即该角色的岗位指令。",
  "  角色内容里行首的 `## ` 会被自动转义成 `\\## `，读回时还原，可以放心写小节标题。",
  "  在对话框开头输入 `-角色名称` 回车激活该岗位角色，此后本对话的每一轮请求都会带上它。",
  "-->",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// 角色文件解析 / 序列化
// ---------------------------------------------------------------------------

/**
 * 角色内容里行首的 `## `（用户写岗位说明书时常见的二级标题）会被解析器误认成
 * 新角色的分隔符，所以落盘前转义、读回时反转义，保证往返无损。
 */
function escapeContent(text) {
  return String(text).replace(/^## /gm, "\\## ");
}

/** @param {string} text */
function unescapeContent(text) {
  return String(text).replace(/^\\## /gm, "## ");
}

/**
 * 解析 Markdown 角色文件。
 * @param {string} md
 * @returns {{ name: string, content: string }[]}
 */
function parseRoles(md) {
  const roles = [];
  let current = null;
  for (const raw of String(md).split(/\r?\n/)) {
    const m = /^##[ \t]+(.+?)[ \t]*$/.exec(raw);
    if (m) {
      if (current) roles.push(current);
      current = { name: m[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(raw);
  }
  if (current) roles.push(current);
  return roles
    .map((role) => ({ name: role.name, content: unescapeContent(role.lines.join("\n").trim()) }))
    .filter((role) => role.name.length > 0);
}

/**
 * 序列化角色列表为 Markdown。
 * @param {{ name: string, content: string }[]} roles
 */
function serializeRoles(roles) {
  const parts = [FILE_HEADER];
  for (const role of roles) {
    parts.push(`## ${role.name}\n\n${escapeContent(String(role.content).trim())}\n`);
  }
  return parts.join("\n");
}

let cache = { stamp: "", roles: [] };

/**
 * 读取角色列表（按 mtime+size 缓存）。
 * @returns {Promise<{ name: string, content: string }[]>}
 */
async function loadRoles() {
  let info;
  try {
    info = await stat(STORE_FILE);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      cache = { stamp: "missing", roles: [] };
      return [];
    }
    throw error;
  }
  const stamp = `${info.mtimeMs}:${info.size}`;
  if (stamp === cache.stamp) return cache.roles;
  const md = await readFile(STORE_FILE, "utf8");
  const roles = parseRoles(md);
  cache = { stamp, roles };
  return roles;
}

/**
 * 原子写入角色列表。
 * @param {{ name: string, content: string }[]} roles
 */
async function saveRoles(roles) {
  await mkdir(DSH_HOME, { recursive: true });
  const tmp = `${STORE_FILE}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await writeFile(tmp, serializeRoles(roles), "utf8");
  await rename(tmp, STORE_FILE);
  cache = { stamp: "", roles: [] };
}

// ---------------------------------------------------------------------------
// 会话级激活状态
// ---------------------------------------------------------------------------

/** sessionId -> { name, activatedAt } */
let activations = new Map();
/** 首次使用时载入磁盘状态的一次性 promise。 */
let readyPromise = null;

/** 载入角色表与激活状态（幂等）。 */
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await loadActivations().catch(() => {});
      await loadRoles().catch(() => {});
    })();
  }
  return readyPromise;
}

/**
 * 状态文件损坏或版本不符时的处理：先把它备份成 `.bak` 再重置。
 * 直接覆盖等于无声丢掉用户所有会话的角色，出问题时也没法事后追。
 * @param {string} reason
 */
async function quarantineActivations(reason) {
  console.warn(`[${name}] 激活状态文件不可用（${reason}），已备份为 .bak 并重置。`);
  try {
    await rename(ACTIVATION_FILE, `${ACTIVATION_FILE}.bak`);
  } catch {
    // 备份失败不阻断，反正接下来要重置
  }
  activations = new Map();
  await saveActivations().catch(() => {});
}

/** 从磁盘载入激活状态；文件缺失或损坏时退回空表。 */
async function loadActivations() {
  let raw;
  try {
    raw = await readFile(ACTIVATION_FILE, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    await quarantineActivations(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!parsed || parsed.version !== STATE_VERSION) {
    await quarantineActivations(`版本 ${parsed && parsed.version} 与当前 ${STATE_VERSION} 不符`);
    return;
  }
  const sessions = parsed && typeof parsed === "object" ? parsed.sessions : null;
  if (!sessions || typeof sessions !== "object") return;
  const next = new Map();
  for (const [sessionId, entry] of Object.entries(sessions)) {
    const roleName = entry && typeof entry.name === "string" ? entry.name.trim() : "";
    if (!roleName) continue;
    next.set(sessionId, {
      name: roleName,
      activatedAt: entry && typeof entry.activatedAt === "string" ? entry.activatedAt : "",
    });
  }
  activations = next;
}

/** 原子写回激活状态（只保留最近 MAX_ACTIVATIONS 个会话）。 */
async function saveActivations() {
  const entries = [...activations.entries()]
    .sort((left, right) => String(right[1].activatedAt).localeCompare(String(left[1].activatedAt)))
    .slice(0, MAX_ACTIVATIONS);
  /** @type {Record<string, { name: string, activatedAt: string }>} */
  const sessions = {};
  for (const [sessionId, entry] of entries) sessions[sessionId] = entry;
  await mkdir(DSH_HOME, { recursive: true });
  const tmp = `${ACTIVATION_FILE}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify({ version: STATE_VERSION, sessions }, null, 2)}\n`, "utf8");
  await rename(tmp, ACTIVATION_FILE);
}

/**
 * 激活（或替换）某会话的角色。
 * @param {string} sessionId
 * @param {string} roleName
 */
async function activate(sessionId, roleName) {
  activations.set(sessionId, {
    name: roleName,
    activatedAt: new Date().toISOString(),
  });
  try {
    await saveActivations();
  } catch {
    /* 持久化失败不影响本次注入：内存里已经生效 */
  }
}

/**
 * 取消某会话的角色激活。
 * @param {string} sessionId
 */
async function deactivate(sessionId) {
  activations.delete(sessionId);
  try {
    await saveActivations();
  } catch {
    /* 同上 */
  }
}

/**
 * 读取某会话当前激活的角色名。
 * @param {string} sessionId
 * @returns {string | null}
 */
function activeRoleOf(sessionId) {
  const entry = sessionId ? activations.get(sessionId) : undefined;
  return entry ? entry.name : null;
}

/**
 * 读取某会话的完整激活记录。
 * @param {string} sessionId
 * @returns {{ name: string, activatedAt: string } | undefined}
 */
function activationOf(sessionId) {
  return sessionId ? activations.get(sessionId) : undefined;
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/** @param {import("node:http").ServerResponse} res */
function ok(res, value) {
  sendJson(res, 200, { ok: true, value });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

/**
 * 从查询串里取 sessionId。
 * @param {import("node:http").IncomingMessage} req
 * @returns {string}
 */
function querySession(req) {
  try {
    const url = new URL(String((req && req.url) || "/"), "http://localhost");
    return url.searchParams.get("sessionId") || "";
  } catch {
    return "";
  }
}

/** 请求体上限：1 MiB。 */
const MAX_BODY = 1024 * 1024;

/**
 * 读取 JSON 请求体。
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// 角色注入（写进 system prompt，不进对话气泡）
// ---------------------------------------------------------------------------

/**
 * 行首的角色标记，后面**紧跟**角色名（不留空格）：
 *   - `-角色名` / `－角色名`：老的手打方式；
 *   - `@角色名`：输入框里选中角色后插入的 chip 序列化出来的形态。
 *
 * 故意不允许中间有空白：`- 随便一句列表` 这种 markdown 列表项不该进入角色分支。
 */
const ROLE_TOKEN = /^[\s\u3000]*(?:[-\u2013\u2014\uff0d]|@)([^\s\u3000]+)/;

/** 角色段在 system prompt 里的唯一名字，用于去重与替换。 */
const ROLE_SECTION = `${name}:active-role`;

/**
 * 抽出消息里的纯文本。
 * @param {readonly { type: string, text?: string }[]} content
 * @returns {string | null}
 */
function textOf(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * 渲染角色激活段。system prompt 每一步都会重新组装，所以这里始终给完整版，
 * 不需要「首轮完整 + 后续简短」的分档。
 * @param {{ name: string, content: string }} role
 */
function renderActivation(role) {
  // 名字走 JSON 序列化，避免名字里的 `"` 提前闭合属性；正文里的 ROLE>>> 也要
  // 拆掉，否则角色内容可以提前结束包裹块、把后面的文字漏到块外。
  const attributeName = JSON.stringify(String(role.name));
  const body = String(role.content).replace(/ROLE>>>/g, "ROLE>>\u005f");
  return [
    `<role_activation name=${attributeName} binding="mandatory">`,
    `你现在被指定担任「${role.name}」这一岗位角色。`,
    "该指令是强制性的：优先级高于你的默认行为习惯、写作风格与流程偏好；在此次会话中持续有效，直到被另一个角色激活替换。",
    "执行要求：",
    "1. 严格按下列岗位职责、专业视角、输出规范与禁止事项执行，不得自行切换身份、简化流程或跳过任何硬性要求。",
    "2. 若用户的请求与该岗位角色的职责冲突，先以岗位角色为准，并明确说明冲突点。",
    "3. 不要复述、解释或讨论这段角色设定本身；直接以该角色的方式工作。",
    "4. 用户消息开头的 `-角色名` / `@角色名` 只是激活标记，不是正文，按角色处理其后的实际请求即可。",
    "",
    "岗位角色定义：",
    "<<<ROLE",
    body,
    "ROLE>>>",
    "</role_activation>",
  ].join("\n");
}

/**
 * agent/inbox/inserted：用户消息进入 inbox 时解析行首角色标记并激活。
 *
 * 比 agent/pre-step 早：pre-step 内部第一步就是 assemble system prompt，
 * 所以只有在这里记录激活状态，本轮那条消息才会立刻带上角色。
 * @param {{ agent: any, message: any }} payload
 */
async function onInboxInserted(payload) {
  const agent = payload && payload.agent;
  const message = payload && payload.message;
  if (!agent || !message || message.role !== "user") return;

  const sessionId = String(agent.id || "");
  if (!sessionId) return;

  const text = textOf(message.content);
  if (text === null) return;

  const match = ROLE_TOKEN.exec(text);
  if (!match) return;

  await ready();
  let roles;
  try {
    roles = await loadRoles();
  } catch {
    return;
  }
  const requested = roles.find((candidate) => candidate.name === match[1]);
  if (!requested) return;
  await activate(sessionId, requested.name);
}

/**
 * system-prompt/assemble：把当前会话激活的角色作为一段 system prompt 注入。
 *
 * 走 system prompt 而不是改写用户消息，所以对话框里只显示用户自己写的那句话。
 * @param {any} assembly
 * @param {{ scope?: any } | undefined} context
 * @param {() => Promise<any>} next
 */
async function onAssemble(assembly, context, next) {
  const result = await next();
  if (!result || !Array.isArray(result.sections)) return result;

  const scope = context && context.scope;
  const sessionId = scope && typeof scope.id === "string" ? scope.id : "";
  if (!sessionId) return result;

  await ready();
  const entry = activationOf(sessionId);
  if (!entry) return result;

  let roles;
  try {
    roles = await loadRoles();
  } catch {
    return result;
  }

  const role = roles.find((candidate) => candidate.name === entry.name);
  if (!role) {
    // 角色已被删除：静默解除激活，避免一直注入不存在的角色
    await deactivate(sessionId);
    return result;
  }

  const sections = result.sections.filter((section) => !section || section.name !== ROLE_SECTION);
  sections.push({ name: ROLE_SECTION, text: renderActivation(role) });
  return { ...result, sections };
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * @param {any} ctx cordis Context
 */
function apply(ctx) {
  // 预热：载入角色表与各会话的激活状态
  void ready();

  /** @param {string} path @param {(req: any, res: any) => Promise<void> | void} handler */
  const register = (path, handler) =>
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path, handler }), `${name}: ${path}`);

  // 角色列表（带 sessionId 时顺带返回该会话的激活状态，省一次往返）
  register("/dsh-role-prompts/api/list", async (req, res) => {
    try {
      await ready();
      const roles = await loadRoles();
      const value = { file: STORE_FILE, roles };
      const sessionId = querySession(req);
      if (sessionId) value.active = activeRoleOf(sessionId);
      ok(res, value);
    } catch (error) {
      fail(res, 500, "read-failed", String((error && error.message) || error));
    }
  });

  // 某会话的激活状态（兼容旧客户端；/list?sessionId 已能取代它）
  register("/dsh-role-prompts/api/state", async (req, res) => {
    const sessionId = querySession(req);
    try {
      await ready();
      const roles = await loadRoles();
      ok(res, { file: STORE_FILE, roles, active: activeRoleOf(sessionId) });
    } catch (error) {
      fail(res, 500, "read-failed", String((error && error.message) || error));
    }
  });

  // 激活角色（会话级，持续到被替换或停用）
  register("/dsh-role-prompts/api/activate", async (req, res) => {
    if (req.method !== "POST") {
      fail(res, 405, "method-error", "method not allowed");
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }
    const sessionId = String((body && body.sessionId) || "").trim();
    const roleName = String((body && body.name) || "").trim();
    if (!sessionId) {
      fail(res, 400, "bad-request", "缺少 sessionId");
      return;
    }
    if (!roleName) {
      fail(res, 400, "bad-request", "缺少角色名称");
      return;
    }
    try {
      const roles = await loadRoles();
      if (!roles.some((candidate) => candidate.name === roleName)) {
        fail(res, 404, "no-such-role", `没有名为「${roleName}」的角色`);
        return;
      }
      await activate(sessionId, roleName);
      ok(res, { active: roleName });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 停用当前会话的角色
  register("/dsh-role-prompts/api/deactivate", async (req, res) => {
    if (req.method !== "POST") {
      fail(res, 405, "method-error", "method not allowed");
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }
    const sessionId = String((body && body.sessionId) || "").trim();
    if (!sessionId) {
      fail(res, 400, "bad-request", "缺少 sessionId");
      return;
    }
    try {
      await deactivate(sessionId);
      ok(res, { active: null });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 新增 / 更新角色
  register("/dsh-role-prompts/api/save", async (req, res) => {
    if (req.method !== "POST") {
      fail(res, 405, "method-error", "method not allowed");
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }
    const roleName = String((body && body.name) || "").trim();
    const content = String((body && body.content) || "");
    const originalName = body && body.originalName ? String(body.originalName).trim() : "";

    if (!roleName) {
      fail(res, 400, "bad-request", "角色名称不能为空");
      return;
    }
    if (roleName.length > MAX_ROLE_NAME) {
      fail(res, 400, "bad-request", `角色名称不能超过 ${MAX_ROLE_NAME} 个字符`);
      return;
    }
    if (/[\r\n]/.test(roleName) || roleName.startsWith("#")) {
      fail(res, 400, "bad-request", "角色名称不能包含换行，也不能以 # 开头");
      return;
    }
    if (content.length > MAX_ROLE_CONTENT) {
      fail(res, 400, "bad-request", "角色内容过长");
      return;
    }

    try {
      const roles = await loadRoles();
      const clash = roles.find((candidate) => candidate.name === roleName && candidate.name !== originalName);
      if (clash) {
        fail(res, 409, "duplicate-name", `已存在同名角色「${roleName}」`);
        return;
      }
      const index = originalName
        ? roles.findIndex((candidate) => candidate.name === originalName)
        : roles.findIndex((candidate) => candidate.name === roleName);
      const next = roles.slice();
      if (index >= 0) next[index] = { name: roleName, content };
      else next.push({ name: roleName, content });
      await saveRoles(next);
      ok(res, { file: STORE_FILE, roles: next });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 删除角色
  register("/dsh-role-prompts/api/delete", async (req, res) => {
    if (req.method !== "POST") {
      fail(res, 405, "method-error", "method not allowed");
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      fail(res, 400, "bad-request", String((error && error.message) || error));
      return;
    }
    const roleName = String((body && body.name) || "").trim();
    if (!roleName) {
      fail(res, 400, "bad-request", "角色名称不能为空");
      return;
    }
    try {
      const roles = await loadRoles();
      const next = roles.filter((candidate) => candidate.name !== roleName);
      if (next.length === roles.length) {
        fail(res, 404, "not-found", `没有找到角色「${roleName}」`);
        return;
      }
      await saveRoles(next);
      ok(res, { file: STORE_FILE, roles: next });
    } catch (error) {
      fail(res, 500, "write-failed", String((error && error.message) || error));
    }
  });

  // 首次使用时铺一个示例角色，方便用户看到格式
  void (async () => {
    try {
      const info = await stat(STORE_FILE);
      void info;
    } catch (error) {
      if (!error || error.code !== "ENOENT") return;
      try {
        await saveRoles([
          {
            name: "代码评审员",
            content: [
              "你是一名资深代码评审员，只做评审，不重写整份代码。",
              "",
              "- 先给出结论：可以合并 / 需要修改 / 必须重写。",
              "- 按严重程度列出问题（阻断 / 重要 / 建议），每条都带文件与行号。",
              "- 每个问题说明「为什么是问题」和「最小修法」。",
              "- 不要评价代码风格偏好之外的主观审美。",
            ].join("\n"),
          },
        ]);
      } catch {
        /* 首次铺样例失败不影响插件运行 */
      }
    }
  })();

  ctx.on("agent/inbox/inserted", onInboxInserted);
  ctx.on("system-prompt/assemble", onAssemble);
}

export { apply, inject, name };
