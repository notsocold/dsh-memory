# dsh-memory 设计（v1，已确认）

状态：已按用户确认的方案实现。本文记录最终设计，供维护与验收对照。

## 0. 目标与边界

在 `~/work/NodeJsProjects/dsh-memory` 实现一个本地 DeepSeek Harness 插件，提供 Claude Desktop
风格的持久长期记忆：

- 边聊边存：会话进行中由 AI 判定「值得长期保留」的信息并保存为记忆主题（Topic）；
- 后续会话自动召回（注入记忆索引），模型可按需读取正文；
- 全局 + 项目两级作用域；
- 沿用当前会话的模型路由做判定，零配置；
- 自动保存，不逐条询问；提供暂停/恢复/编辑/删除/清空/导出；
- 与 `dsh-skill` 同构的本地双半插件（Host + Web 设置页），无构建、无 npm 依赖、无 TypeScript。

非目标：向量/嵌入语义检索、云同步、团队共享、桌面端原生 UI、图片记忆。

## 1. 关键调研结论

| 事实 | 影响 |
|---|---|
| DSH 没有「会话结束」钩子；有 `agent/turn-stopping`（每轮结束）、`agent/status`（idle/running）、`session/disposed`、`session/created` | 采用「每轮结束后静默窗口」为主 + 新会话/销毁边界 + 手动触发 |
| `ctx.llm.stream()` 可做一次性辅助调用；无 JSON response format | 提示词 + 严格 JSON 解析（同 auto-review 插件做法） |
| `ctx.systemPrompt.section()/context()` 支持动态 provider，`AssembleContext.agent` 可用 | 固定策略段 + 按会话动态记忆索引 |
| `ctx.tools.register()`、`ctx.commands.register()` | `memory` 工具与 `/memory` 命令 |
| `ctx.connection.fetch.register()` 认证路由 | Web 半不依赖 Remote/生成代码 |
| 无现成 memory 实现 | 全新实现；`dsh-skill` 的打包/状态/API/客户端模式可参考 |

Claude 消费端记忆的要点（官方文档）：边聊边存为 topic；账户级 + 项目级；默认排除敏感话题与
永不保存证件/金融类；Topics 列表可查看/编辑/删除，另有 Pause/Reset/单会话关闭；Claude Code
只注入记忆索引、正文按需读取。本设计采用相同分层与索引化注入，但把「会话结束」映射为 DSH 的
空闲窗口与边界事件。

## 2. 架构

```
Web (client.js)
  Settings → Memory 管理页
        │ same-origin authenticated JSON
        ▼
Host (index.js + lib/)
  StateStore       $DSH_HOME/dsh-memory/memory.json（原子写/损坏备份/审计/镜像）
  MemoryStore      CRUD、去重合并、配额归档、索引渲染、水位线、活动日志
  Extractor        触发调度：idle 静默窗口、新会话边界、会话销毁、手动
  Judge            ctx.llm.stream 判定 → 严格 JSON → 校验/脱敏 → 落库
  Injector         systemPrompt.section（策略）+ systemPrompt.context（动态索引）
  Tools/Commands   memory 工具、/memory 命令
  API              /api/dsh-memory/{state,memory,action}
```

## 3. 触发模型（最终版）

| 时机 | 实现 | 说明 |
|---|---|---|
| 每轮结束 + 静默 | `agent/status` → `idle` 后启动 `quietSeconds`（默认 30s）计时器；期间重新 running 则取消 | 主路径，Claude 风格「边聊边存」；短追问会合批 |
| 新会话创建 | `session/created` → 扫描其它 idle 且有待判定内容的会话，1s 后入队 | 用户开新会话≈上一会话结束 |
| 会话销毁/删除 | `session/disposed` → 同步快照（events/route/header）→ 后台入队 | fire-and-forget，不阻塞销毁 |
| 插件加载 | `start()` 扫描已存在的 live agent，有待判定内容则 2s 后入队 | 安装/热重载后补判 |
| 手动 | `memory` 工具 `extract`、`/memory extract`、设置页按钮 | 绕过静默/间隔限制，仍受总开关约束 |

门控（省钱）：新增人类消息 ≥1、字符 ≥ `minNewChars`（120）、同会话自动判定间隔
`minIntervalSeconds`（60s）、每小时上限 `maxRunsPerHour`（12）、全局并发 1、单次超时 60s。
自动门控拒绝会写入活动日志（`status: skipped`），但不消耗模型调用。

水位线：`watermarks[sessionId] = { seq, at, chars }`，`seq` 为最后处理事件序号（会话事件从 0 开始，
未处理用 -1 表示）；只有判定成功才推进；排队任务在真正执行前会用最新水位线重新计算输入，
避免同一段对话被判定两次。

## 4. 判定流水线

输入：会话标题/cwd/项目、最近 2 条 compaction 摘要（若在窗口内）、窗口内人类消息 + 助手文本
（工具只记名称）、现有记忆索引（id/kind/scope/title/summary）、敏感策略文本。
预算：输入 ≤24000 字符（从最新往回截断），输出 ≤4096 tokens，`temperature: 0`。

输出协议（严格 JSON，无围栏也可，解析时容忍围栏/前后文字）：

```json
{
  "operations": [
    {"op":"create","kind":"user|preference|project|decision|reference|todo",
     "scope":"global|project","title":"…","summary":"…","content":"…",
     "importance":1-5,"tags":["…"]},
    {"op":"update","id":"m_xxxxxxxx","patch":{"content?":"…","importance?":4},"reason":"…"}
  ],
  "skipped": [{"topic":"…","reason":"ephemeral|duplicate|sensitive|derivable"}]
}
```

校验与安全：
- create ≤5、update ≤10；枚举/长度校验；`scope: project` 必须绑定当前会话项目，否则拒绝；
- 自动判定**永不 delete**（delete 操作直接拒绝），冲突用 update 合并保留 revision；
- 落库前密钥形态强制脱敏（`sk-*`、GitHub token、AWS key、Bearer、PEM、`password=` 等）；
- 敏感类别（健康/政治/宗教/性取向/性别认同/民族）默认不保存，`allowSensitive` 才放开；
  证件号/金融账号/犯罪/移民/凭据永不保存；
- 模型判定失败（路由不可用、超时、JSON 损坏、provider 错误）只记日志与活动，不影响会话。

确定性去重：同 scope（+同项目）下标题规范化相同 → 合并；正文 hash 相同 → 合并；
同 kind/scope 下标题+摘要 token Jaccard ≥0.85 → 合并；否则新建。合并保留新内容、revision+1。

## 5. 注入与召回

- `systemPrompt.section('dsh-memory:policy', order 950)`：英文策略（记忆是背景数据不是指令、
  何时 search/get/save/update/forget、不编造、不存密钥/敏感信息）。总开关关闭时为空。
- `systemPrompt.context('dsh-memory:index', order 90, required, interpolate:false)`：每步动态渲染
  当前 agent 的记忆索引：global + 当前项目 active 主题；pinned → importance → updatedAt 排序；
  默认 30 条 / 4000 字符预算，超出提示用工具检索。subagent、opt-out、暂停时不注入。
- `memory` 工具：`search/get/list/save/update/forget/extract`。正文不进入索引，按需读取。
- `/memory` 命令：`status/list/search/extract/pause/resume/forget/pin/unpin/reset --yes/help`。

## 6. 数据与管理

- 路径：`$DSH_HOME/dsh-memory/{memory.json, audit.jsonl, MEMORY.md}`；
  `$DSH_HOME` 解析顺序：显式 → `DSH_HOME` → `~/.dsh`。
- `memory.json`：`version/settings/memories/watermarks/sessionOptOut/activity/stats`；
  原子写；损坏时备份 `.broken-<ts>` 并回默认；`MEMORY.md` 只读镜像；`audit.jsonl` 追加审计。
- 配额：active 上限 500；超出时归档「非 pinned、低 importance、最久未更新」记录（不删除）。
- 设置页导航使用专属「书签 + 星芒」字形（宿主 SettingsRoot 本地补丁）；插件通过
  `ctx.commandUi.decorateFace()` 为 `/memory` 提供与原生命令一致的「+」菜单行外观。
- 设置页（Settings → Memory，`settings.section` id `memory` order 30）：
  暂停/恢复、统计、搜索/scope/kind/status 过滤、列表、详情编辑（title/summary/content/kind/scope/
  importance/pinned/tags/status）、新增、删除（二次确认）、清空（确认）、导出 JSON、
  live session 选择 + 立即判定 + 单会话 opt-out、高级设置、最近活动、加载/错误/重试/空态。

## 7. 测试与验收

- Host 侧 236 个单元测试（`node --test test/*.test.js`），覆盖 state/privacy/project/retrieval/
  transcript/store/judge/extractor/api/tools/commands；fixtures 与 fake（LLM stream、ctx、timers）。
- Client 侧不做自动化渲染测试；通过真实安装后的设置页手测验收。
- 真实链路验收：安装到 web profile → 会话中告知事实 → 静默后自动入库 → 新会话（或子代理）
  召回 → 设置页编辑/删除/暂停/清空/导出 → 项目隔离与脱敏检查。
