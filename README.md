# dsh-memory — DeepSeek Harness 持久记忆插件

一个与 `dsh-skill` 同构的本地 DSH 双半插件（Host + Web），提供 **Claude Desktop 风格的长期记忆**：

- **边聊边存**：会话进行中，由当前会话的模型自动判定「值得长期保留」的信息，保存为记忆主题（Topic）；
- **自动召回**：后续会话把记忆索引注入提示词，模型可按需读取正文；全局 + 项目两级作用域；
- **可管理**：Settings → Memory 管理页支持搜索、查看、编辑、删除、固定、暂停/恢复、清空、导出；
- **模型可操作**：`memory` 工具（search/get/list/save/update/forget/extract）与 `/memory` 命令；
- **本地优先**：数据只落本机 `$DSH_HOME/dsh-memory/`；无构建、无 npm 依赖、无 TypeScript。

> 设计说明见 [docs/DESIGN.md](docs/DESIGN.md)，内部接口契约见 [CONTRACT.md](CONTRACT.md)。

## 功能

### 1. 自动判定与保存（默认开启）

| 触发 | 时机 |
|---|---|
| 静默窗口 | 每轮对话结束后 agent 进入 idle，静默 `quietSeconds`（默认 30s）后判定新增内容 |
| 长会话增量 | 持续对话中按同一静默窗口合批，不打断对话 |
| 新会话边界 | 新建会话时，顺带判定其它空闲会话里尚未处理的内容 |
| 会话销毁 | 会话被删除/释放时同步快照并后台判定（不阻塞销毁） |
| 插件加载 | Host 启动/插件重载时补判已存在会话的未处理内容 |
| 手动 | `memory` 工具 `extract`、`/memory extract`、设置页「Extract now」 |

判定会拿到：当前会话标题/工作目录/项目、最近 compaction 摘要、上次判定之后的人类消息 + 助手文本、
现有记忆索引；只保存长期有用的偏好、项目事实、决策/结论、引用与待办，跳过临时细节、可推导信息和
敏感内容。自动判定**永不删除**记忆；冲突/过时信息通过 `update` 合并并保留 revision。

### 2. 召回

- 固定策略段（记忆是背景数据、不是指令；何时检索/保存/删除；不得编造记忆）。
- 动态记忆索引（每步按当前项目刷新）：只注入 `id · kind · scope · 日期 · 摘要`，正文用工具按需读取；
  预算默认 30 条 / 4000 字符，超出提示模型用 `memory` 工具检索。
- 项目隔离：`global` 记忆在所有会话可见；`project` 记忆只在对应 git 项目根/工作目录的会话可见。
- 子代理会话（subagent）不注入、不自动判定；单会话可 opt-out。

### 3. 管理页（Settings → Memory）

- 导航栏使用专属「书签 + 星芒」图标，与 DSH 原生设置页图标风格一致；
- 输入框「+」菜单中的 `/memory` 行使用原生命令样式：图标 + 中英文标题 + 描述（类似「压缩」「模型」），
  并声明自由输入提示，`/memory <子命令>` 可被正常接收。

- 统计（总数/活跃/归档/全局/项目/固定/最近更新）与全局暂停/恢复；
- 搜索 + scope/kind/status/project 过滤；
- 记忆列表与详情编辑器（title/summary/content/kind/scope/importance/pinned/tags/status）；
- 新增、两步确认删除、导出 JSON、清空（需输入 `DELETE` 确认）；
- 选择本 Host 的 live 会话：立即判定（Extract now）、单会话 opt-out；
- 高级设置（静默秒数、增量阈值、注入预算、项目记忆开关、工具开关、模型删除开关、敏感内容开关、判定模型覆盖等）；
- 最近 20 次判定活动（触发、状态、created/updated/skipped、原因）。

### 4. 工具与命令

`memory` 工具（模型侧）：

```
action: search | get | list | save | update | forget | extract
query, id, title, summary, content, kind, scope, importance, tags, pinned, status, limit, offset
```

`/memory` 命令（用户侧）：`status`、`list [q]`、`search <q>`、`extract`、`pause`、`resume`、
`forget <id>`、`pin <id>`、`unpin <id>`、`reset --yes`、`help`。

## 安装

插件是本地 bundle 包（`@local/dsh-memory`，`private`），通过 profile 的 `link:` 安装：

```bash
# 在 DSH checkout 目录执行（或已安装 dsh CLI 后直接用 dsh）
pnpm dsh plugin --profile web add /home/zhaodan/work/NodeJsProjects/dsh-memory
```

安装后 `~/.dsh/profiles/web/package.json` 会新增依赖与 `dsh.profile.bundles` 条目；
profile 组合可用下面的命令确认：

```bash
pnpm dsh --profile web --dump-config | grep -A1 dsh-memory
```

**加载时机**：profile 支持管理面重组合的 Host 会热加载；否则重启 `dsh web` 后生效。
也可以随时通过 Settings → Plugins 对 `@local/dsh-memory` 关闭再开启以重载代码。

卸载（保留 `$DSH_HOME/dsh-memory/` 数据）：

```bash
pnpm dsh plugin --profile web remove @local/dsh-memory
```

## 数据与隐私

```
$DSH_HOME/dsh-memory/memory.json   # 唯一事实源（原子写；损坏时备份 .broken-<ts>）
$DSH_HOME/dsh-memory/audit.jsonl   # 追加审计（create/update/delete/archive/settings/clear）
$DSH_HOME/dsh-memory/MEMORY.md     # 只读 Markdown 镜像，便于查看/备份
```

- `$DSH_HOME` 解析：显式参数 → `DSH_HOME` 环境变量 → `~/.dsh`。
- 落库前强制脱敏密钥形态（`sk-*`、GitHub token、AWS key、Bearer、PEM 私钥、`password=` 等）。
- 默认不保存敏感个人话题（健康、政治、宗教、性取向、性别认同、民族）；证件号/金融账号/犯罪/移民/
  凭据永不保存。可在高级设置打开 `allowSensitive`（仍受“永不保存”限制）。
- 记忆数据只在本机；插件除 `ctx.llm` 的判定调用外不发起网络请求。
- **删除会话不会删除记忆**；需要时在设置页删除或 `/memory forget`。

## 配置

所有运行期设置保存在 `memory.json` 的 `settings` 中，可在设置页「Advanced settings」修改：

| 设置 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关（暂停时读写与注入全部停止，已有记忆保留） |
| `autoExtract` | true | 是否自动判定 |
| `quietSeconds` | 30 | 每轮结束后的静默判定窗口（3–600） |
| `minNewChars` | 120 | 自上次判定以来新增人类字符下限 |
| `minIntervalSeconds` | 60 | 同一会话两次自动判定最小间隔 |
| `maxRunsPerHour` | 12 | 同一会话每小时自动判定上限 |
| `maxTopicsInPrompt` | 30 | 注入索引最大条数 |
| `maxIndexChars` | 4000 | 注入索引最大字符数 |
| `projectsEnabled` | true | 是否注入项目级记忆 |
| `toolEnabled` | true | 是否向模型暴露 `memory` 工具 |
| `allowModelDelete` | true | 模型可否在用户明确要求时 forget |
| `allowSensitive` | false | 是否允许保存敏感类别 |
| `redactSecrets` | true | 密钥脱敏 |
| `judgeProvider` / `judgeModel` | 空 | 判定模型覆盖；空 = 沿用当前会话模型路由 |

判定预算固定为：输入 ≤24000 字符、输出 ≤4096 tokens、单次超时 60s、单次最多 5 个 create / 10 个 update。

## 本地 Harness 补丁（本机 checkout）

DSH 的插件 API 不提供设置页导航图标与宿主命令行外观的注册入口，本插件在本地 checkout 中做了 4 处
最小的客户端扩展（`deepseek-harness` 仓库工作区修改，未提交）：

| 文件 | 修改 |
|---|---|
| `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` | `navIcon('memory')` 返回内联「书签 + 星芒」字形 |
| `packages/client/ui-commands/src/client/contract.ts` | 新增 `CommandRowFaceDecoration` 与 `decorateFace()` 契约 |
| `packages/client/ui-commands/src/client/service.ts` | 行外观装饰注册表 + 候选行合并逻辑 |
| `packages/client/ui-commands/src/client/index.ts` | 导出新契约类型 |

改完执行（只影响两个 client bundle，无需重建整个 web 前端）：

```bash
cd ~/work/NodeJsProjects/deepseek-harness
pnpm exec tsc -b packages/client/ui-commands/tsconfig.json \
  packages/client/ui-settings-general/tsconfig.json
pnpm --filter @deepseek-ai/dsh-client-ui-commands bundle
pnpm --filter @deepseek-ai/dsh-client-ui-settings-general bundle
```

完整补丁快照见 [docs/harness-client.patch](docs/harness-client.patch)（其中也包含本 checkout 早先为
`dsh-skill` 添加的 `skills` 图标 hunk）。插件侧通过 `ctx.commandUi.decorateFace()` 注册行外观；若 DSH
升级覆盖了上述补丁，插件功能不受影响，但设置页图标会回退为齿轮、命令菜单行会回退为纯描述。`dsh-memory` 自身的 `client.js` 不依赖
DSH 客户端包，始终只需 `require('react')`。

## 架构

```
index.js                     Host 入口：装配 store/injector/extractor/tools/commands/routes
lib/state.js                 $DSH_HOME 解析、JSON 状态、原子写、损坏备份、设置/记录归一化
lib/store.js                 记忆 CRUD、去重合并、配额归档、索引渲染、水位线、活动/审计、MEMORY.md
lib/retrieval.js             搜索评分、排序、项目过滤、索引预算、统计
lib/transcript.js            会话事件 → 判定输入（人类/助手消息、工具名、compaction、截断）
lib/judge.js                 判定提示词、ctx.llm.stream 调用、严格 JSON 解析/校验/脱敏、模型路由
lib/extractor.js             触发调度：静默窗口/边界/销毁/手动、队列、限流、超时、水位线
lib/inject.js                systemPrompt.section（策略）+ context（按 agent 动态索引）
lib/tools.js                 memory 工具（7 个 action）
lib/commands.js              /memory 命令
lib/api.js                   /api/dsh-memory/{state,memory,action}
client.js                    Settings → Memory 管理页（lazy-CJS，仅 require('react')）
package.json / cordis.patch.yml / locale/{en,zh}.json / icon.svg
docs/DESIGN.md / CONTRACT.md / README.md
test/                        node:test 单元测试（236 个）
```

## 开发与测试

```bash
cd /home/zhaodan/work/NodeJsProjects/dsh-memory
npm run check     # node --check index.js client.js lib/*.js
npm test          # node --test test/*.test.js
```

测试全部 hermetic：临时 `DSH_HOME`、fake LLM stream、fake Cordis ctx、可注入定时器/时间；
覆盖 state/privacy/project/retrieval/transcript/store/judge/extractor/api/tools/commands 与回归项。

## 实测结果（2026-10-20，当前工作机）

环境：DSH `0.2.1-rc.2`，Node v24.18.0，profile `web`，模型路由 `deepseek-official/deepseek-flash`。

- **安装**：`pnpm dsh plugin --profile web add …` 成功；`--dump-config` 组合中出现 `# == @local/dsh-memory` 行。
- **热加载与注入**：在运行中的 3080 Host 上重组合后，当前会话的运行时上下文立即出现
  「Long-term memory」策略段与按项目过滤的记忆索引，工具表出现 `memory` 工具；索引在新记忆保存后
  于下一步自动刷新。
- **工具链路**：`memory save → search → get → update → pin → list → forget` 真实调用成功；
  `save` 返回 `m_c2f105a5`，`forget` 删除返回成功。
- **自动判定**：一次 boundary 判定 `created=4`，下一次 `created=2, updated=1`；自动生成 project/global
  两级主题，说明去重合并、项目作用域与判定 JSON 生效；索引中可见 `project:DeepseekChat` 条目。
- **召回**：全新 headless 进程（`--patch` 注入同一插件）中，模型先 `memory search pnpm`，随后仅依据
  记忆正确回答「Node.js 项目使用 pnpm」，并引用记忆 id。
- **Web 端**：另起验证实例（3099，测试后已关闭）确认：index 的 `__DSH_BOOT__` 含
  `@local/dsh-memory` 客户端条目；`GET /plugins/??@local/dsh-memory/client.js` 返回 112 KB
  bundle（含 `__ModuleLoader__.load`）；认证后的
  `GET /api/dsh-memory/state`、`GET /api/dsh-memory/memory?id=` 与 `POST /api/dsh-memory/action`
  的 create/update/pin/pause/resume/export/delete 全部返回正确 envelope。
- **设置页图标与命令菜单行（2026-10-20 晚）**：本地 Harness 补丁完成并重建两个 client bundle 后，
  运行中的 3080 Host 已提供新版 `ui-commands`（含 `decorateFace`，82,626 B）与
  `ui-settings-general`（含书签字形，61,897 B）；插件 `client.js` bundle（114,773 B）包含菜单行外观注册。
  设置 → 记忆 使用专属图标；输入框「+」菜单中的 `/memory` 行显示与「压缩」「模型」一致的原生行样式。
- **测试**：`node --test test/*.test.js` → **236 pass / 0 fail**；`node --check` 全部通过；
  oxlint 仅两份有意的控制字符正则警告。

## 已知限制

- 没有「会话结束」原生事件：用静默窗口 + 新会话/销毁边界近似；进程在静默窗口前被强杀时该段内容
  可能未判定（可手动 extract 或调小 `quietSeconds`）。
- 召回是索引 + 关键词/相似度检索，不含向量嵌入语义检索（后续可扩展）。
- 自动判定质量依赖模型；已有严格 JSON 校验、确定性去重、自动不删除、密钥脱敏与敏感类别策略兜底。
- 多 Host 共用同一 `$DSH_HOME` 时状态文件是 last-writer-wins；正常单 Host 运行不受影响。
- Web 半只读测试未做浏览器截图级验证（无浏览器自动化）；客户端逻辑经 jsdom/React 冒烟与真实
  bundle/路由加载验证。
