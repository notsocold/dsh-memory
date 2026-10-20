# dsh-memory — 内部契约（v1）

本文件冻结宿主半（Host）与浏览器半（Client）之间的接口、模块边界与持久化 schema。
实现必须与本文一致；修改契约需要同步改本文件、`client.js` 和测试。

## 1. 项目形态

- 包名 `@local/dsh-memory`，`private: true`，纯 ESM JavaScript，**无构建步骤、无 npm 依赖、无 TypeScript**。
- `index.js` 是 Host 入口；`client.js` 是浏览器半（lazy-CJS，只 `require('react')`）。
- `cordis.patch.yml` 只有一行 `insert`（`id: dsh-memory`）。
- Host 半只通过 Cordis `ctx` 与服务交互；Client 半只通过同源认证 HTTP API 拿数据。
- 所有可调设置保存在 `$DSH_HOME/dsh-memory/memory.json` 的 `settings` 中（由设置页编辑），Host 不导出 `Config` schema。
- 代码约定：ESM、`node:` 前缀内置模块、JSDoc 类型注释、错误用 `memoryError(code, message)`、日志用 `ctx.logger.warn/info` 且绝不影响会话。

## 2. 持久化

### 2.1 路径

`resolveDshHome()` 解析顺序：显式参数 → `$DSH_HOME` → `~/.dsh`。

```
$DSH_HOME/dsh-memory/memory.json     # 唯一事实源（原子写）
$DSH_HOME/dsh-memory/audit.jsonl     # 追加式审计日志（create/update/delete/archive/redact）
$DSH_HOME/dsh-memory/MEMORY.md       # 只读镜像（索引 + 正文），供用户查看/备份
```

`memory.json` 损坏时重命名为 `memory.json.broken-<ts>` 并从默认状态继续；缺失视为默认状态。

### 2.2 状态文档 schema（`version: 1`）

```jsonc
{
  "version": 1,
  "settings": {
    "enabled": true,                 // 总开关：false 时读写/注入全部暂停
    "autoExtract": true,             // 自动判定开关
    "quietSeconds": 30,              // 一轮结束后静默多久触发判定（3-600）
    "minNewChars": 120,              // 自上次判定以来新增人类字符下限
    "minIntervalSeconds": 60,        // 同一会话两次自动判定最小间隔
    "maxRunsPerHour": 12,            // 同一会话每小时自动判定上限
    "maxTopicsInPrompt": 30,         // 注入索引的最大条数
    "maxIndexChars": 4000,           // 注入索引的最大字符数
    "projectsEnabled": true,         // 是否注入项目级记忆
    "redactSecrets": true,           // 落库前密钥脱敏
    "toolEnabled": true,             // 是否向模型暴露 memory 工具
    "allowModelDelete": true,        // 模型可否在用户要求时 forget
    "allowSensitive": false,         // 是否允许保存敏感类别（默认拒绝）
    "judgeProvider": "",             // 空 = 沿用当前会话路由
    "judgeModel": ""
  },
  "memories": [ /* MemoryRecord[]，见 2.3 */ ],
  "watermarks": {
    "<sessionId>": { "seq": 0, "at": "ISO", "chars": 0 }
  },
  "sessionOptOut": { "<sessionId>": true },
  "activity": [ /* ActivityEntry[]，最多 100 条，最新在前 */ ],
  "stats": { "created": 0, "updated": 0, "deleted": 0, "runs": 0, "errors": 0 }
}
```

### 2.3 MemoryRecord（记忆主题）

```jsonc
{
  "id": "m_1a2b3c4d",                 // m_ + 8 位小写 hex，全局唯一
  "title": "用户偏好：使用 pnpm",       // ≤120 字符
  "summary": "用户要求所有 Node 项目使用 pnpm。", // ≤240 字符，索引展示用
  "content": "……",                    // ≤8000 字符，正文
  "kind": "user | preference | project | decision | reference | todo",
  "scope": "global | project",
  "project": null | { "key": "/abs/git/root", "name": "dsh-memory" },
  "tags": ["pnpm"],                   // ≤8 个，每个 ≤40 字符
  "importance": 3,                    // 1-5 整数
  "pinned": false,
  "status": "active | archived",
  "createdAt": "ISO", "updatedAt": "ISO",
  "revision": 1,                      // 每次 update +1
  "source": {
    "sessionId": "…", "sessionTitle": "…",
    "origin": "auto | tool | manual | import",
    "model": "deepseek-official/deepseek-flash"
  }
}
```

- 种类语义：`user` 用户身份/背景；`preference` 偏好与协作反馈；`project` 项目事实/约定/环境；
  `decision` 重要决策与结论；`reference` 外部资源；`todo` 未完成事项。
- 去重：同 scope（及同 project key）下标题规范化相同 → 合并为 update；内容 hash 相同 → skip；
  相似度 ≥0.85 → 合并；其余 create。合并保留较新内容并 `revision + 1`。
- 配额：active 记录默认上限 500；超出时把「非 pinned、importance 最低、最久未更新」的 active 记录
  置为 `archived`（不删除）。
- 自动判定**永不 delete**；删除只来自用户 UI、`/memory forget` 或模型在用户明确要求时调用工具。

### 2.4 ActivityEntry

```jsonc
{
  "at": "ISO", "sessionId": "…", "sessionTitle": "…",
  "trigger": "quiet | boundary | dispose | manual | tool-extract",
  "status": "ok | skipped | error",
  "created": 0, "updated": 0, "skipped": 0,
  "reason": "…",        // skipped/error 时的简短原因（≤200 字符）
  "durationMs": 123
}
```

## 3. 模块契约（`lib/`）

### 3.1 `lib/state.js`

- `resolveDshHome(explicit?)`, `expandHome(value)`, `errorMessage(error)`, `isMissing(error)`, `apiErrorOf(error)`。
- `memoryError(code, message)` — `code ∈ {invalid-request, not-found, io-error, disabled, judge-failed, session-not-live, internal}`。
- `defaultState()`, `normalizeState(raw)`（丢弃未知/坏字段，不抛）。
- `class StateStore { constructor({home?}); home; root; statePath; auditPath; mirrorPath; async load(); async save(); async appendAudit(entry); }`
  - `save()` 同目录临时文件 + rename 原子写。
  - `appendAudit(entry)` 追加一行 JSON，失败只 warn（由调用方传 logger 或静默）。

### 3.2 `lib/privacy.js`

- `redactSecrets(text)` → `{ text, hits: string[] }`：识别并替换 `sk-*`、`ghp_/gho_/ghu_/ghs_/ghr_`、
  `AKIA/ASIA`、`Bearer <token>`、PEM 私钥块、`password/passwd/pwd/secret/api_key/token =` 形态的值。
- `sanitizeText(value, maxChars)` → 去控制字符、压缩空白、截断、可选脱敏。
- `HARD_SENSITIVE_TOPICS`（政府证件、金融账号、犯罪记录、移民身份）与 `SENSITIVE_TOPICS`
  （健康、政治、宗教、性别认同、性取向、民族/国籍）的英文标签，供判定提示词使用。
- `looksCredentialLike(text)` 供判定结果兜底拒绝。

### 3.3 `lib/project.js`

- `resolveProject(cwd)` → `{ key, name, root } | undefined`：从 cwd 向上找最近含 `.git`（目录或文件）的祖先；
  找不到时以 cwd 为 root；`key` 为解析后的绝对路径（尽量 realpath），`name` 为 basename。带进程内缓存。
- `projectFromSession(session)` → 同步读 `session.header.cwd` 并调用 `resolveProject`（无 cwd 返回 undefined）。
- `isSubagentSession(session)` → `session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0`。

### 3.4 `lib/retrieval.js`

纯函数，不触碰磁盘：

- `normalizeTitle(text)`, `contentHash(text)`, `similarity(a, b)`（拉丁词 + CJK 字符 bigram 的 Jaccard）。
- `matchesQuery(record, query)` 与 `scoreRecord(record, query)`：标题/摘要/tag/正文命中加权。
- `searchRecords(records, { query, scope, kind, status, projectKey, limit, offset })` → `{ items, total }`。
- `sortForPrompt(records)`：pinned → importance → updatedAt 降序。
- `renderIndex(records, { maxTopics, maxChars })` → `{ text, included, omitted }`（Markdown 行，
  每行 `- id · kind · scope · YYYY-MM-DD · summary`）。
- `renderJudgeIndex(records, maxChars)` → 紧凑文本（`id | kind | scope | title | summary`）。
- `counts(records)` → `{ total, active, archived, global, project, pinned }`。

### 3.5 `lib/store.js`

`class MemoryStore`：

- `constructor({ stateStore, now?, logger? })`；`async load()`；`get settings()`；`get state()`；`snapshot()`。
- `list(options)` / `get(id)` / `search(query, options)`。
- `create(input, { origin })` → `{ action: 'created' | 'merged', record }`；`update(id, patch, { origin })`；
  `remove(id, { origin })`；`clear()` → `{ count }`；`setPinned(id, pinned)`。
- `applyOperations(operations, { origin, source })` → `{ created, updated, skipped, rejected }`（判定结果落库）。
- `setSettings(patch)`（校验范围，非法值抛 `invalid-request`）；`setSessionOptOut(sessionId, value)`;
  `isSessionOptOut(sessionId)`。
- `getWatermark(sessionId)` / `setWatermark(sessionId, { seq, chars })`。
- `indexForPrompt({ projectKey, maxTopics, maxChars })` → `{ text, included, omitted }`；
  `indexForJudge(maxChars)` → `string`。
- `stats()`；`listActivity(limit)`；`recordActivity(entry)`。
- `onChange(listener)` → dispose；`async flush()`（等待挂起的写盘）。
- 写盘策略：内存状态同步更新后异步串行 `save()`；失败只记日志并保留 `dirty`，下次重试。
- `MEMORY.md` 与 `audit.jsonl` 在每次变更后异步刷新/追加。

### 3.6 `lib/transcript.js`

- `snapshotSession(session)` → 同步快照：
  `{ sessionId, title, cwd, projectKey?, isSubagent, route: {provider, model} | undefined, events, header }`
  （`events` 来自 `session.snapshotEvents()`，try/catch；`route` 来自 `session.requestHeader()`）。
- `buildExtractionInput(snapshot, { watermarkSeq, maxInputChars })` →
  `{ transcript, compactionSummary, humanMessages, humanChars, nextSeq, totalEvents, toolNames }`
  - 只取 `user/message` 且 `source.kind === 'user'` 的人类消息 + `assistant/message` 的 text 块；
  - 工具只记录名称集合；`compaction/summary` 取最近 2 条文本作为背景；
  - 从最新往回截断到 `maxInputChars`，前缀注明省略数量；`nextSeq` 为快照内最大 seq。

### 3.7 `lib/judge.js`

- `resolveJudgeRoute(ctx, snapshot)` → `{ provider, model } | undefined`：
  `settings.judgeProvider/judgeModel`（两者同时非空）→ `snapshot.route` → `ctx.get('agentDefaultModel')?.currentSelection()`。
- `buildJudgePrompt({ settings, snapshot, indexText, extraction })` → `{ system, user }`。
- `parseJudgeOutput(text)` → `{ operations, skipped }`；容忍 ```json 围栏，严格校验对象/数组；失败抛 `judge-failed`。
- `validateOperations(operations, { allowSensitive })` → `{ accepted, rejected }`：白名单字段、枚举、
  长度、数量上限（create ≤5、update ≤10、delete 不来自自动判定）、脱敏后文本。
- `async runJudge({ ctx, store, snapshot, extraction, signal, settings })` →
  `{ status: 'ok'|'skipped'|'error', created, updated, skipped, reason?, model? }`
  - 用 `ctx.llm.stream({ provider, model, system, messages: [{ role: 'user', content: [{ type: 'text', text }] }], temperature: 0, signal, maxTokens })`；
  - 累积 `text-delta`；`finish.reason.kind` 必须为 `stop`，否则抛错；
  - 解析 + 校验 + `store.applyOperations`。

### 3.8 `lib/extractor.js`

`class Extractor`：

- `constructor({ ctx, store, judge, logger, now?, setTimeout?, clearTimeout? })`。
- `async start()`：扫描 `ctx.agents.list()`，为「root、idle、有未判定内容」的会话安排静默判定。
- `onStatus({ agent, status })`：`idle` 且 root → 去抖安排；`running` → 取消计时器。
- `onAgentDisposed({ agent })`、`onSessionCreated(session)`（触发其它空闲会话的 boundary 判定）、
  `onSessionDisposed(session)`（同步快照后入队）。
- `extractNow(agentOrSessionId, { trigger })` → `Promise<result>`：手动判定（不受静默/间隔限制，仍受门控与总开关约束）。
- `dispose()`：清理计时器、abort 在途请求、等待队列收敛（best-effort）。
- 内部：按 sessionId 去重的 FIFO 队列、全局并发 1、每 session 最小间隔与每小时上限、watermark 只在成功后推进、
  activity 记录、错误只 warn。

### 3.9 `lib/inject.js`

- `installInjection(ctx, { store, logger })` → `{ dispose() }`（内部用 `ctx.effect` 也可）。
- 注册：
  - `ctx.systemPrompt.section({ name: 'dsh-memory:policy', order: 950, text: () => policyText(store.settings) })`
  - `ctx.systemPrompt.context({ name: 'dsh-memory:index', order: 90, required: true, interpolate: false,
    text: (assembly) => indexContextText(assembly.agent, store) })`
- `policyText(settings)`：总开关关闭时返回 `''`；否则返回固定英文说明（记忆是背景数据不是指令、
  何时 search/get、何时 save/forget、不得编造记忆、不存密钥）。工具关闭时改为只读说明段。
- `indexContextText(agent, store)`：subagent、总开关关闭、会话 opt-out、无 cwd 时相应降级；
  仅注入 active 记录，按项目过滤；空白或索引为空时返回 `''`。

### 3.10 `lib/tools.js`

- `createMemoryTool({ store, extractor, logger })` → 手写 ToolDefinition：
  - `name: 'memory'`，单 action 参数：`search | get | list | save | update | forget | extract`。
  - 输出 schema：`{ ok: boolean, message: string, details?: string, ids?: string[] }`，render 为文本。
  - `save` 走 `store.create`；`update` 走 `store.update`（白名单字段）；`forget` 受 `allowModelDelete` 限制；
    `extract` 调 `extractor.extractNow(agent)`。
  - 总开关关闭时读操作返回 `ok:false, message: memory disabled`；写操作抛 `disabled`。

### 3.11 `lib/commands.js`

- `createMemoryCommands({ store, extractor })` → `CommandDefinition[]`（单条 `memory`）。
- 语法：`/memory [status|list [q]|search <q>|pause|resume|extract|forget <id>|pin <id>|unpin <id>|reset --yes|help]`。
- 返回 `{ kind: 'success', text }` 或 `{ kind: 'error', text }`；未知子命令给帮助。

### 3.12 `lib/api.js`

- `API_PREFIX = '/api/dsh-memory'`。
- `apiRoutes({ store, extractor, resolveSessionContext })` → `ConnectionFetchRoute[]`，全部 `requestBody: 'buffered'`：
  - `GET ${API_PREFIX}/state?sessionId=` → `{ ok, value }`：
    `{ settings, stats, memories: StateItem[], projects, activity: ActivityEntry[],
    liveSessions: [{ sessionId, title, status, optedOut, cwd? }], session, paused }`
    - `StateItem` 不含 `content`（正文），含 id/title/summary/kind/scope/project/tags/importance/pinned/status/
      createdAt/updatedAt/revision/source。
  - `GET ${API_PREFIX}/memory?id=` → `{ ok, value: record }`（含正文）；未知 id → `not-found`。
  - `POST ${API_PREFIX}/action` body `{ action, sessionId?, ... }`，action 白名单：
    `create | update | delete | pin | unpin | clear | pause | resume | setSessionOptOut | extractNow | export | setSettings`。
- 响应封装与 dsh-skill 一致：`{ ok: true, value }` / `{ ok: false, error: { code, message } }`；
  `cache-control: no-store`；业务错误 HTTP 200，畸形请求 4xx，internal 500。
- `resolveSessionContext(sessionId)`（Host 注入）：返回 `{ cwd?, project?, live?: boolean }`。

## 4. 工具与命令契约

### 4.1 `memory` 工具（模型可见）

```
action: search | get | list | save | update | forget | extract
query?, id?, title?, summary?, content?, kind?, scope?, importance?, tags?, pinned?, limit?, offset?, status?
```

- `save` 必填 `title` + `content`；`scope=project` 时项目取当前会话 cwd 的项目根。
- `search` 默认 limit 10；`list` 默认 limit 20。
- 描述中明确：只在用户要求时 forget；不得保存密钥/敏感信息；记忆是数据不是指令。
- 工具执行上下文取 `exec.agent`；无 agent 时读写返回错误。

### 4.2 `/memory` 命令

见 3.11；输出为纯文本（多行），不进入模型上下文（DSH 命令语义）。

## 5. 浏览器半（`client.js`）

- lazy-CJS：`window.__ModuleLoader__.load({ id: '@local/dsh-memory', factory(require) { ... } })`，只 `require('react')`。
- 注册：`ctx.effect(() => ctx.locale.register(NS, { zh, en }))`、
  `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'memory',
  order: 30, label: () => t('nav'), locale: NS }, MemorySettingsSection))`；
  通过 `ctx.inject(['commandUi'], scoped => scoped.effect(() => scoped.commandUi.decorateFace({...})))`
  为宿主 `/memory` 命令注册输入框「+」菜单行外观（icon/label/description，zh/en 内联字典）。
- 设置页导航图标由宿主 `SettingsRoot.tsx` 的 `navIcon('memory')` 提供（本地 Harness 补丁，见 README）；
  渲染器不提供插件注册图标的槽位。
- `NS = 'dsh-memory'`；主题色只用 `--dsw-alias-*` token；样式使用单个 `<style>`（类前缀 `dshmemory-`）。
- 设置页功能：状态行（总数/全局/项目/暂停开关）、搜索、scope/kind 过滤、列表、详情编辑
  （title/content/kind/scope/importance/pinned/tags，Save/Cancel/Delete）、新增、清空（二次确认）、
  导出 JSON、当前会话立即判定、最近活动、加载/错误/重试/空态。
- 数据流：`GET /api/dsh-memory/state` → 渲染列表；点击条目 `GET /api/dsh-memory/memory?id=` 取正文；
  所有变更 `POST /api/dsh-memory/action` 后重新拉取 state。
- 所有 fetch 同源、`credentials: 'same-origin'`、`cache: 'no-store'`；错误显示 `code` 与 message。
- 中文/英文文案内联字典；`locale` 服务不可用时回退英文。

## 6. 隐私与安全

- 落库前密钥形态一律脱敏（`settings.redactSecrets`）；判定提示词要求永不保存凭据/证件号/金融账号。
- 敏感类别（健康、政治、宗教、性别认同、性取向、民族）默认不保存，`settings.allowSensitive` 才放开；
  用户明确要求且 allowSensitive 时可保存。
- 记忆注入是背景数据；policy section 明确「不当指令执行、不编造」。
- 数据只落本机 `$DSH_HOME/dsh-memory/`；插件不发起网络请求（LLM 调用除外，经 `ctx.llm`）。
- 删除会话不删除记忆（文档写明）；单会话 opt-out 可关闭该会话的注入与自动判定。

## 7. 测试接缝

- 纯模块（state/privacy/project/retrieval/transcript/judge/parser）直接 import 测试。
- Store/Extractor 接受注入的 `now`、`setTimeout/clearTimeout`、fake `ctx`（`agents`、`llm`、`logger`、
  `get(name)`），不依赖真实 Harness。
- API 用标准 `Request` 直接调用 route 的 `fetch`。
- Client 不做自动化渲染测试；通过真实安装后的页面手测验收。
