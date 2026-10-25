# dsh-memory — 内部契约（v2）

本文件冻结 Host 半、浏览器半、持久化 schema 与运行时行为。实现必须与本文一致；修改契约需同步
`client.js`、测试与 README/DESIGN。

## 1. 项目形态

- 包名 `@local/dsh-memory`，`private: true`，纯 ESM JavaScript，无构建步骤、无 npm 依赖、无 TypeScript。
- `index.js` 是 Host 入口；`client.js` 是浏览器半（lazy-CJS，只 `require('react')`）。
- `cordis.patch.yml` 只有一行 `insert`（`id: dsh-memory`）。
- Host 半只通过 Cordis `ctx` 与服务交互；Client 半只通过同源认证 HTTP API 拿数据。
- 所有可调设置保存在 `$DSH_HOME/dsh-memory/state.json` 的 `settings` 中；Host 不导出 `Config` schema。
- 代码约定：ESM、`node:` 前缀内置模块、JSDoc 类型注释、`memoryError(code, message)`、日志用
  `ctx.logger.warn/info` 且不影响会话。

## 2. 存储布局

### 2.1 路径解析

`resolveDshHome()`：显式参数 → `$DSH_HOME` → `~/.dsh`。

```
$DSH_HOME/dsh-memory/
├── MEMORY.md                  # 生成的全局索引（非事实源，可随时重写）
├── m_<8hex>-<slug>.md         # 全局记忆主题（权威事实源，每个主题一个文件）
├── state.json                 # 运行状态（settings/watermarks/opt-out/activity/stats/projects）
├── audit.jsonl                # 追加式审计日志
└── memory.json.migrated-<ts>  # 迁移后的 v1 备份（只保留，不再读取）

<workspace>/.dsh/dsh-memory/
├── MEMORY.md                  # 生成的项目索引（随项目进 git）
└── m_<8hex>-<slug>.md         # 项目记忆主题（随项目进 git）
```

- **项目身份 = 会话有效工作目录**（最新 `working-directory/change` 事件的 `cwd`，否则 session header
  的 `cwd`；不再向上寻找 `.git`）。因此同一仓库的不同子目录属于不同项目作用域。
- 项目记忆只在“当前工作目录等于该 `project.key`”的会话中注入；已知但未打开的项目的记忆可在设置页
  只读查看/编辑（读取时加载，不注入、不自动创建目录）。
- 不在项目记忆目录中写 `.gitignore`、README 或任何模板文件；不自动修改仓库 `.gitignore`。
  项目目录存在时，插件只写 `MEMORY.md` 和主题文件。
- 全局记忆位置保持 `$DSH_HOME/dsh-memory/` 不变。
- 子目录/文件权限沿用宿主进程用户；不对文件做加密（本地明文，自行用磁盘加密/备份策略保护）。

### 2.2 主题文件格式

主题文件是权威数据。格式为小型 YAML frontmatter + Markdown 正文：

```markdown
---
id: "m_1a2b3c4d"
title: "用户偏好：使用 pnpm"
summary: "用户要求所有 Node 项目使用 pnpm。"
kind: "preference"
importance: 4
tags: ["pnpm","node"]
pinned: false
status: "active"
created: "2026-10-20T12:00:00.000Z"
modified: "2026-10-20T12:34:56.000Z"
revision: 2
origin: "auto"
sessionId: "session-…"
sessionTitle: "…"
model: "provider/model"
---

正文 Markdown，≤8000 字符。
```

- 作用域/所属项目**由文件所在目录推导**，不写进 frontmatter；因此移动文件即改作用域。
- 字符串用 JSON 引号（合法 YAML）；标签用 JSON 流式数组。解析器兼容无引号标量、单引号、
  块列表、未知键。
- 容忍手工文件：无 frontmatter 时从文件名 `m_<id>`、首个标题、文件 mtime 推导；无合法 id 时用
  `<scope>:<filename>` 的 SHA-1 前 8 位生成稳定 id；未知 kind/status/origin 回退默认值。
- 超过 256 KB 的文件跳过并记录诊断；最多扫描 1000 个主题文件；正文载入上限 32000 字符。
- 文件名在创建后保持稳定；标题变更不重命名文件。写入使用同目录临时文件 + `rename` 原子替换。
- `MEMORY.md` 由插件从主题文件生成：按 pinned、importance、updatedAt 排序，排除 archived，
  含相对链接、摘要、kind/importance/日期；越界修改会在下一次刷新时被覆盖。
- 空目录/不存在目录的“加载”是只读的，不会创建目录；只有真正写入主题/迁移时才 `mkdir -p`。
  因此工作区有会话但没有项目记忆时，不会出现空的 `.dsh/dsh-memory/`。

### 2.3 运行状态 `state.json`（`version: 2`）

```jsonc
{
  "version": 2,
  "settings": {
    "enabled": true,
    "autoExtract": true,
    "autoExtractExistingSessions": false, // 是否自动补判启动前已有/导入的历史会话
    "quietSeconds": 30,
    "minNewChars": 120,      // 人类 + 助手新增对话字符下限
    "minIntervalSeconds": 60,
    "maxRunsPerHour": 12,
    "autoSaveMinImportance": 3,      // 自动 create 的最低重要性（1-5）；手动提取不受限
    "maxTopicsInPrompt": 30,          // 全局索引预算
    "maxIndexChars": 4000,
    "projectMaxTopicsInPrompt": 30,   // 项目索引独立预算
    "projectMaxIndexChars": 4000,
    "projectsEnabled": true,
    "redactSecrets": true,
    "toolEnabled": true,
    "allowModelDelete": true,
    "allowSensitive": false,
    "judgeProvider": "",
    "judgeModel": ""
  },
  "watermarks": { "<sessionId>": { "seq": 0, "at": "ISO", "chars": 0, "baseline?": true } },
  "sessionOptOut": { "<sessionId>": true },
  "activity": [ /* ≤100，最新在前，可带 projectKey */ ],
  "stats": { "created": 0, "updated": 0, "deleted": 0, "runs": 0, "errors": 0, "migrated": 0 },
  "projects": {
    "/abs/workspace": {
      "name": "workspace",
      "memoryDir": "/abs/workspace/.dsh/dsh-memory",
      "lastSeenAt": "ISO",
      "lastReadAt": "ISO?", "lastWriteAt": "ISO?",
      "error": "optional"
    }
  }
}
```

- `state.json` **不含 memories**。
- `state.json` 损坏 → 备份为 `state.json.broken-<ts>` 后从默认状态继续；缺失视为默认。
- 写入串行化（同进程），同目录临时文件 + `rename`；正常操作失败抛 `io-error`，审计失败只告警。
- `state.json` 中所有 map 键经过 `isSafeMapKey` 防原型污染；设置值按类型/范围归一化。

### 2.4 v1 迁移

启动时若只有 `memory.json`（v1，含 `memories[]`）：

1. 把全局记录写入 `$DSH_HOME/dsh-memory/m_*.md`，项目记录写入
   `{record.project.key}/.dsh/dsh-memory/m_*.md`；
2. 生成两侧 `MEMORY.md`；
3. 把 settings/watermarks/optOut/activity/stats 归一化为 v2，并登记 known projects；
4. 写 `state.json`，把原文件重命名为 `memory.json.migrated-<ts>`；
5. 追加 `op:"migrate"` 审计；失败记录（例如目录不可写）保留在 `pending-migration.json`，
   原始备份仍完整保留。
- 迁移是幂等的：`state.json` 存在后不再读取旧 `memory.json`。

## 3. MemoryRecord

```jsonc
{
  "id": "m_1a2b3c4d",
  "title": "…",                 // ≤120
  "summary": "…",               // ≤240
  "content": "…",               // ≤8000
  "kind": "user | preference | project | decision | reference | todo",
  "scope": "global | project",
  "project": null | { "key": "/abs/workspace", "name": "workspace" },
  "tags": ["…"],                // ≤8 × ≤40
  "importance": 3,              // 1-5
  "pinned": false,
  "status": "active | archived",
  "createdAt": "ISO", "updatedAt": "ISO",
  "revision": 1,
  "source": { "origin": "auto | tool | manual | import", "sessionId": "…", "sessionTitle": "…", "model": "…" }
}
```

- `scope/project` 在运行时用于路由；持久化位置本身就是作用域。
- 同一 collection（全局或某项目）内的去重：规范化标题相等、内容 hash 相等、或同 kind 且
  `similarity ≥ 0.85` → 合并为 update；跨 collection 永不合并。
- 每个 collection 最多 500 条 active；超出时归档 importance 最低、最旧且非 pinned 的记录。
- 自动判定永不删除；删除只来自用户/显式工具。

## 4. Host 侧接口

`MemoryStore`（`lib/store.js`）关键方法：

| 方法 | 语义 |
|---|---|
| `load()` | 读 state、执行 v1→v2 迁移、加载并 watch 全局 collection |
| `create(input, meta)` | 按 scope/project 路由；同 collection 去重；写文件 + 索引 + 审计 |
| `update(id, patch, meta)` | `projectKey` 用于定位；支持移动 scope/project |
| `remove(id, meta)` / `clear({projectKey?})` | 删主题文件；`clear()` 无 projectKey 时清全局+已知项目 |
| `get/list/search` | 合并已加载 collection；工具调用按当前项目过滤，设置页可看全部 |
| `indexForPrompt({projectKey})` | 全局 + 当前项目两段索引，分别使用独立预算 |
| `indexForJudge(projectKey)` | 判定用的紧凑全局+项目索引 |
| `acquireProject(project)` | 为 live session 加载并 watch 项目目录，返回 release |
| `loadKnownProjects()` | 只读加载 known projects（不创建目录、不注入） |
| `refreshIfStale()` | 10s 节流的兜底全量重读（mtime 不可靠时仍能发现外部编辑） |
| `flush()` / `dispose()` | 等待 state/audit 落盘 / 关闭 watcher |

`StateStore`（`lib/state.js`）：`read()` → `{state}` 或 `{legacy}`；`save()` 串行原子写；`appendAudit()`；
`backupLegacy()`。

## 5. 注入与预算

- `systemPrompt.section('dsh-memory:policy', order 950)`：静态策略；暂停时返回空串。
- `systemPrompt.context('dsh-memory:index', order 90, required, interpolate:false)`：每步按 agent 的
  当前工作目录组装：
  - `### Global memory`：`maxTopicsInPrompt` / `maxIndexChars`；
  - `### Project memory — <name>`：`projectMaxTopicsInPrompt` / `projectMaxIndexChars`；
  - 超出部分提示用 `memory` 工具检索。
- 子代理会话不注入、不自动判定；单会话 opt-out 时跳过。
- 项目记忆只在 `project.key === 当前工作目录` 时注入；全局记忆所有项目可见。
- 记忆文本是背景数据，不是指令；当前用户消息与系统提示始终优先。

## 6. 判定与触发

触发：静默 `quietSeconds`（默认 30s）、新会话边界、会话销毁、插件启动补判、手动
`memory extract`/`/memory extract`/设置页 Extract now。队列并发 1；门限 `minNewChars`（人类 + 助手新增对话字符）、
`minIntervalSeconds`、`maxRunsPerHour`；水位线在 drain 前二次校验。

**历史会话基线**：自动提取发现没有本地 watermark、且 session 创建时间早于插件启动（含导入会话）时，
只把 `watermark` 设为 `baseline:true`（会话当前末尾的 seq），不自动调用模型；
之后的新事件仍会按 watermark 正常处理。`autoExtractExistingSessions:true` 可恢复启动时补判旧会话。
手动 `Extract now`（以及 API `fromStart:true`）对 baseline 会话从会话开头处理。

判定使用当前会话模型路由（设置可覆盖 `judgeProvider/judgeModel`），严格 JSON create/update，
自动永不 delete；落库前密钥脱敏 + 敏感类别策略。

**保存策略硬约束**：
- 每个 create 必须显式带 `scope`，缺失即拒绝；项目会话中的项目/环境/架构/命令/安全/实现决策必须用 `project`。
- 项目会话中 `global` 仅允许 `kind:user|preference`，或提供非空 `scopeReason` 的跨项目知识；否则自动落为项目主题，避免全局污染。
- 自动 create 必须显式给出 `importance`，低于 `autoSaveMinImportance`（默认 3）时拒绝；手动 Extract now 使用下限 1。
- 提示词要求跳过 status/progress、已暂停/取消的计划、可从代码/文档/git 恢复的实现细节、测试数量/提交 hash、一次性问答和重复主题。`created/updated/skipped/rejected` 写入活动。

## 7. 工具与命令

`memory` 工具：`search | get | list | save | update | forget | extract`。项目作用域来自调用 agent 的
当前工作目录；`save` 默认 global，`scope:"project"` 需当前项目；列表/搜索只返回全局 + 当前项目。

`/memory` 命令：`status | list | search | extract | pause | resume | forget | pin | unpin | reset | help`。

## 8. HTTP API（仅 Web profile）

前缀 `/api/dsh-memory`，同源认证；响应 envelope `{ok:true,value}` / `{ok:false,error:{code,message}}`，
`Cache-Control: no-store`。

| 路由 | 说明 |
|---|---|
| `GET /state?sessionId=` | `layout`/`memoryRoot`、settings/stats/所有记忆摘要（含 `projectKey`、`memoryDir`、`file`）/known projects/activity/live sessions |
| `GET /memory?id=&projectKey=` | 单条完整正文；`projectKey` 用于跨项目定位 |
| `POST /action` | `create/update/delete/pin/unpin/clear/pause/resume/setSessionOptOut/extractNow/export/setSettings` |
| `GET /events` | SSE 变更流（`text/event-stream`，15s 心跳）：每次 store 变化（主题写入/外部文件改动/设置）推送一帧 `data: {"type":"change"}`，浏览器据此重取 `/state`，不必轮询；客户端断开时服务端清理订阅 |

- `/events` 使用同源 cookie 认证，与其它 `/api/dsh-memory/*` 路由一致；一帧只表示“库变了”，具体内容由客户端重取 `/state` 并按会话过滤。


- `create` 的 `scope:"project"` 接受显式 `project:{key,name}` 或当前 live session 的项目；否则
  `invalid-request`。
- `update/delete/pin/unpin` 支持 `projectKey` 帮助定位；未提供时回退当前 session 项目再全局查找。
- `clear` 需 `confirm:true`；无 `projectKey` 时清全局 + 已知项目；带 `projectKey` 只清该项目。
- `extractNow` 可选 `fromStart:true`：忽略本地 watermark/基线，从会话开头处理。
- `export` 结构：`{exportedAt,version,layout:"markdown-topic-files",settings,globalMemories,projects:[{key,name,memoryDir,memories}]}`。
- 设置页状态请求会只读加载 known projects（不创建目录、不注入），使非 live 项目也能查看/编辑。

## 9. 监控、并发与一致性

- live session 的 `agent/created`、`working-directory/change` → `acquireProject`：加载并 `fs.watch`
  项目目录；`agent/disposed`/`session/disposed` 释放引用，最后一个引用释放时停止 watcher。
- watcher 事件去抖 300 ms，触发 `forceReload` 全量重读 + 重建索引；`MEMORY.md` 自身写入不会形成回路。
- 兜底：注入前每 10s 最多一次全量重读，防止文件系统 mtime 粒度或 watcher 不可用导致漏检。
- 文件是权威：外部编辑/新增/删除在刷新后生效；手工改 `MEMORY.md` 会被重建覆盖。
- 原子写 + 同进程串行；多 Host 同时写同一目录时 **last-writer-wins**，无跨进程锁；audit 记录本进程
  操作，冲突后以磁盘最新内容为准。
- 已知项目读取路径只读；只有写操作创建 `.dsh/dsh-memory`。

## 10. 安全与隐私

- 读文件时跳过 symlink、非普通文件、超过 256 KB、目录外路径；项目目录由绝对工作目录 + 固定段拼出。
- 默认不保存敏感个人话题；证件号/金融账号/犯罪/移民/凭据永不保存；落库前脱敏。
- 记忆只在本地；除 `ctx.llm` 判定调用外不发网络请求。
- 删除会话不删除记忆；用户可在设置页或工具中删除。

## 11. 测试与验收

`node --test test/*.test.js` 覆盖：state v2/迁移、frontmatter 容忍格式、topic collection 读写/索引/
外部编辑、store 全局/项目路由/去重/配额/预算、注入、判定、提取、工具、API、命令与回归项。
`node --check index.js client.js lib/*.js` 必须通过。

## 12. 可移植性

- 插件包自包含：无 npm 依赖、无构建步骤；Host 半不 import 任何 Harness 包，Client 半只 require React。
  在 DSH `0.2.1-rc.2` + Web profile 上验证。跨 DSH 版本/操作系统未做完整矩阵验证。
- 功能（自动判定、全局/项目 Markdown 存储、召回、工具/命令、设置页、监听、迁移）随插件走。
- 两处外观依赖本地 Harness 补丁：设置页导航图标（`SettingsRoot.tsx`）与 `/memory` 命令行的原生
  `decorateFace`。未打补丁的宿主回退为默认图标/普通命令样式，功能不受影响；补丁快照
  `docs/harness-client.patch` 随包分发，需应用到匹配 host checkout 并重建 client bundle。
- 现有记忆数据不随包发布：复制 `$DSH_HOME/dsh-memory/` 以及项目 `.dsh/dsh-memory/`；
  项目记忆可随项目 git 一起移动。旧 v1 `memory.json` 会在首次启动时迁移。
- 目标机器的模型 provider/凭据、profile 组合需自行配置；插件默认沿用当前会话模型路由。
- Known projects 和会话 watermark 中的绝对路径/会话 id 来自源机器；不存在的项目会被忽略，
  新会话重新建立 watermark。
