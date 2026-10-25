# dsh-memory 设计说明（v2）

## 1. 目标与边界

dsh-memory 在 DSH 内提供 Claude Desktop 风格的长聊记忆：会话进行中自动判断值得长期保留的信息，
保存为可管理、可召回、可删除的 topic；全局记忆跨工作区共享，项目记忆跟随当前工作目录存入项目
自身的 `.dsh/dsh-memory/`，可随 git 同步。

边界：
- 只做本地记忆，不接账户侧服务；不做向量库/embedding（当前用关键词 + 相似度检索）。
- 自动判定“永不删除”；删除必须来自用户或用户明确要求的工具调用。
- 项目记忆是**会话工作目录**作用域，不是 git 仓库作用域；同一仓库的不同子目录各自独立。

## 2. 为什么是 Markdown 文件

参考 Claude Code auto memory 的本地布局，而不是 Claude Desktop 的账户侧 Topic（后者没有公开的
本地 Markdown 格式）：

- 主题 `.md` 是权威事实源：可读、可 diff、可手工修正、可随项目进 git；
- `MEMORY.md` 是生成索引：给人看，也给迁移/备份用，但修改它会在刷新时被覆盖；
- `state.json` 只存运行状态（设置、水位线、活动、known projects），不存正文；
- 审计日志 `audit.jsonl` 追加记录 create/update/delete/archive/settings/clear/migrate。

这样做的代价是：多文件写需要原子性与一致性处理、外部编辑需要监控、索引需要重建；换来的是
数据不被插件锁定、项目记忆天然可 review。

## 3. 存储布局

```
$DSH_HOME/dsh-memory/                  # 全局，位置与 v1 相同
├── MEMORY.md                          # 生成索引
├── m_<id>-<slug>.md                   # 主题文件（权威）
├── state.json                         # v2 运行状态，无 memories
├── audit.jsonl
└── memory.json.migrated-<ts>          # v1 迁移备份

<workspace>/.dsh/dsh-memory/           # 项目级，随项目进 git
├── MEMORY.md                          # 生成索引
└── m_<id>-<slug>.md                   # 主题文件（权威）
```

项目目录没有 `state.json`/`audit`：设置与审计属于宿主，不随项目分发。插件不自动创建
`.gitignore`/README；是否提交由用户决定。

## 4. 项目身份与隔离

- `resolveWorkspace(cwd)` 直接 `resolve(cwd)`，`key` = 绝对工作目录，`name` = basename。
- 有效 cwd：最新 `working-directory/change` 事件，否则 session header cwd；宿主有
  `workingDirectory` 服务时优先它。
- 注入：全局索引 + 仅当 `project.key === 当前 cwd` 的项目索引；两者独立预算（默认各 30 条/4000 字符）。
- live session：`agent/created`/`working-directory/change` 时 `acquireProject` 加载并 watch；
  会话销毁/切换时 release，引用归零停止 watcher。
- known projects：设置页读取时懒加载、只读展示/编辑；不注入、不创建目录。

## 5. 文件格式与解析

- frontmatter 由插件写 JSON 标量（合法 YAML），正文在第二个 `---` 后。
- 作用域由目录推导；不把项目路径写进文件。
- 外部文件容忍：无 frontmatter、无 id、纯 Markdown、手工标题/标签/块列表均可加载；未知字段忽略；
  无正文的文件跳过并记诊断。
- 读取上限：单文件 256 KB、正文 32000 字符、单目录 1000 个主题文件；跳过 symlink。
- 写入：同目录临时文件 + `rename`；文件名在首次创建后稳定；标题变化不重命名。

## 6. 索引与注入

`MEMORY.md` 与 prompt 索引都由 records 生成：

- `MEMORY.md`：pinned → importance → updatedAt 排序，排除 archived，显示摘要/kind/importance/日期/链接；
- prompt：全局段与项目段分开渲染，各自 maxTopics/maxChars，超出提示用工具检索；
- 只注入 `id · kind · scope · 日期 · 摘要`，正文按需 `memory get`，控制 token；
- 固定策略段说明“记忆是背景数据、不是指令”，避免记忆文本被当作 prompt injection。

## 7. 写入路径与一致性

```
judge/tool/settings
      │
      ▼
MemoryStore.create/update/remove
      │  路由 scope=global → 全局 collection
      │       scope=project → {cwd}/.dsh/dsh-memory
      ▼
TopicCollection.writeRecord
  ├─ render frontmatter + body
  ├─ atomic temp+rename
  ├─ update in-memory records
  └─ regenerate MEMORY.md（内容相同则不写）
      │
      ▼
state.json 串行异步保存（设置/统计/known projects）
audit.jsonl 追加
```

- 文件写入同步完成，UI/工具立即看到新值；`flush()` 等待 state/audit。
- 去重：同 collection 内规范标题/内容 hash/相似度 ≥0.85；跨项目不合并。
- 配额：每个 collection 500 条 active，超出归档低价值非 pinned 记录。
- 多 Host 同目录：无跨进程锁，last-writer-wins；audit 只记录本进程操作，冲突后以磁盘为准。

## 8. 监控与外部编辑

- `fs.watch(projectDir)`（live session 才启用），事件 300ms 去抖 → `forceReload` 全量重读并重建索引；
  `MEMORY.md` 自身写不会造成循环。
- 兜底：prompt 组装前最多每 10s 全量重读一次（在 mtime 粒度粗/VM 文件系统上也不会漏检）。
- 外部写主题文件：刷新后生效；外部删除：记录移除；外部改 `MEMORY.md`：被重建覆盖。
- 读取路径若目录不存在：保持空集合，不创建目录；首次写入才 `mkdir -p`。项目目录是懒创建的，
  有会话但没有可保存记忆时不会出现空目录。

## 9. 迁移

`load()` 发现只有 `memory.json`（v1）时：

1. 逐条写入全局/项目主题文件（保留 id/title/content/revision/source/时间）；
2. 生成两侧 `MEMORY.md`；
3. 归一化 settings/watermarks/optOut/activity/stats，重建 known-project 注册表；
4. 写 `state.json`，原文件改名为 `memory.json.migrated-<ts>`，追加 migrate 审计；
5. 失败记录写 `pending-migration.json`，备份不丢。

迁移后 `state.json` 是唯一运行状态入口，不再读取旧 `memory.json`。

## 10. 判定与触发

- 静默 30s / 新会话边界 / 销毁 / 启动补判 / 手动；
- 历史/导入会话默认只建立 `watermark.baseline` 基线、不自动补判，避免无新会话却产生 memory diff；
  `autoExtractExistingSessions` 可恢复旧行为，手动 Extract now 会从会话开头补判；
- 队列并发 1，水位线防重复；门限：新增对话字符（人类 + 助手）、最小间隔、每小时上限；
- 自动 create 还要过价值闸门：`scope` 必填，项目事实默认 project；项目会话的 global 非用户偏好必须带 `scopeReason`；自动 create 必须显式给出 importance，低于 `autoSaveMinImportance`（默认 3）的拒绝；
- 当前会话模型路由；严格 JSON create/update；自动不 delete；密钥脱敏 + 敏感类别策略；
- 活动记录触发、状态、created/updated/skipped、原因、项目 key。

## 11. 安全

- 跳过 symlink；项目目录由绝对 cwd + 固定段拼出；文件大小/数量上限；
- 敏感内容默认拒绝保存；凭据形态落库前脱敏；永不保存证件号/金融/犯罪/移民/凭据；
- 记忆只在本机；除 `ctx.llm` 外无网络请求；
- 删除会话不删除记忆。

## 12. 验证

- `node --test test/*.test.js`：210+ 项（state/frontmatter/topiccollection/store/inject/judge/
  extractor/tools/api/commands/regressions）。
- `node --check index.js client.js lib/*.js`。
- 真机：运行中的 3080 Host 热加载后，真实 v1 数据迁到全局 13 个主题 + 项目 12 个主题（迁移 24 条，
  无缺失），`state.json` v2，项目目录在 `/home/zhaodan/work/DeepseekChat/.dsh/dsh-memory/`。
