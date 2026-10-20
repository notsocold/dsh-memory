/**
 * dsh-memory browser half: Settings → Memory.
 *
 * Build-free lazy CommonJS; the only require is React. Data comes exclusively
 * from the authenticated same-origin routes in lib/api.js.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const {
      Fragment, useCallback, useEffect, useId, useMemo, useRef, useState,
    } = React

    const NS = 'dsh-memory'

    const API_PREFIX = '/api/dsh-memory'
    const API_STATE = API_PREFIX + '/state'
    const API_MEMORY = API_PREFIX + '/memory'
    const API_ACTION = API_PREFIX + '/action'

    const SETTINGS_ORDER = 30

    const MEMORY_KINDS = ['user', 'preference', 'project', 'decision', 'reference', 'todo']
    const MEMORY_SCOPES = ['global', 'project']
    const MEMORY_STATUSES = ['active', 'archived']
    const MEMORY_ORIGINS = ['auto', 'tool', 'manual', 'import']
    const ACTIVITY_TRIGGERS = ['quiet', 'boundary', 'dispose', 'manual', 'tool-extract']
    const ACTIVITY_STATUSES = ['ok', 'skipped', 'error']
    const ERROR_CODES = [
      'invalid-request', 'not-found', 'io-error', 'disabled',
      'judge-failed', 'session-not-live', 'internal', 'network', 'request-failed',
    ]

    const KIND_TONES = {
      user: 'info',
      preference: 'success',
      project: 'neutral',
      decision: 'warning',
      reference: 'outline',
      todo: 'warning',
    }

    const STATUS_TONES = { ok: 'success', skipped: 'warning', error: 'error' }

    const DEFAULT_FILTERS = {
      query: '',
      scope: 'all',
      projectKey: '',
      kind: 'all',
      status: 'all',
    }

    const ADVANCED_BOOLEANS = [
      'autoExtract',
      'projectsEnabled',
      'toolEnabled',
      'allowModelDelete',
      'redactSecrets',
    ]

    const ADVANCED_NUMBERS = [
      { key: 'quietSeconds', min: 3, max: 600, fallback: 30 },
      { key: 'minNewChars', min: 0, max: 100000, fallback: 120 },
      { key: 'minIntervalSeconds', min: 0, max: 86400, fallback: 60 },
      { key: 'maxRunsPerHour', min: 1, max: 1000, fallback: 12 },
      { key: 'maxTopicsInPrompt', min: 1, max: 500, fallback: 30 },
      { key: 'maxIndexChars', min: 500, max: 200000, fallback: 4000 },
      { key: 'projectMaxTopicsInPrompt', min: 1, max: 500, fallback: 30 },
      { key: 'projectMaxIndexChars', min: 500, max: 200000, fallback: 4000 },
    ]

    const ADVANCED_STRINGS = ['judgeProvider', 'judgeModel']

    const SETTINGS_DEFAULTS = {
      enabled: true,
      autoExtract: true,
      quietSeconds: 30,
      minNewChars: 120,
      minIntervalSeconds: 60,
      maxRunsPerHour: 12,
      maxTopicsInPrompt: 30,
      maxIndexChars: 4000,
      projectMaxTopicsInPrompt: 30,
      projectMaxIndexChars: 4000,
      projectsEnabled: true,
      redactSecrets: true,
      toolEnabled: true,
      allowModelDelete: true,
      judgeProvider: '',
      judgeModel: '',
    }
    /* ------------------------- Inline dictionaries (flat string maps; registered through ctx.locale) ------------------------- */

    const en = {
      nav: 'Memory', 'command.label': 'Memory', 'command.description': 'Manage persistent memory topics across sessions',
      'common.loading': 'Loading…', 'common.retry': 'Retry',
      'common.cancel': 'Cancel', 'common.dismiss': 'Dismiss', 'common.working': 'Working…',
      'common.refresh': 'Refresh', 'common.all': 'All', 'common.unknown': 'Unknown',
      'page.title': 'Memory', 'page.intro': 'Long-term memory the assistant saves while you chat. Review, edit, pause, or export it here.', 'page.storage': 'Global: {global} · Project: {project}', 'status.line': '{total} total · {active} active · {archived} archived · {global} global · {project} project · {pinned} pinned · {projects} projects',
      'status.lastUpdated': 'Last updated {time}', 'status.never': 'never', 'paused.badge': 'Paused',
      'paused.hint': 'Memory is paused: automatic extraction, recall, and the memory tool are off until you resume.', 'action.pause': 'Pause memory', 'action.resume': 'Resume memory',
      'notice.paused': 'Memory paused.', 'notice.resumed': 'Memory resumed.', 'toolbar.search': 'Search memories',
      'toolbar.searchPlaceholder': 'Search title, summary, tags, kind, scope…', 'toolbar.scope': 'Scope', 'toolbar.kind': 'Kind',
      'toolbar.status': 'Status', 'toolbar.project': 'Project', 'toolbar.projectAll': 'All projects',
      'toolbar.clearFilters': 'Clear filters', 'kind.user': 'User', 'kind.preference': 'Preference',
      'kind.project': 'Project fact', 'kind.decision': 'Decision', 'kind.reference': 'Reference',
      'kind.todo': 'Todo', 'scope.global': 'Global', 'scope.project': 'Project',
      'scope.projectWith': 'Project · {project}', 'origin.auto': 'Auto', 'origin.tool': 'Tool',
      'origin.manual': 'Manual', 'origin.import': 'Import', 'memory.title': 'Memories',
      'memory.count': '{shown} of {total}', 'memory.untitled': '(Untitled memory)', 'memory.noSummary': 'No summary',
      'memory.updated': 'Updated {time}', 'memory.importance': 'Importance {importance}', 'memory.pin': 'Pin memory',
      'memory.unpin': 'Unpin memory', 'memory.status.active': 'Active', 'memory.status.archived': 'Archived',
      'memory.new': 'New memory', 'memory.emptyTitle': 'No memories yet', 'memory.emptyBody': 'Memory works continuously: as you chat, the assistant decides what is worth keeping and saves topics automatically. Recalled topics reappear in later sessions without any action from you.',
      'memory.emptyBodyAdd': 'Use this Settings → Memory page to add a memory yourself below, pause automatic memory, or export a backup at any time.', 'memory.emptyAdd': 'Add a memory', 'memory.noMatchesTitle': 'No memories match these filters',
      'memory.noMatchesBody': 'Clear the filters to see the full library.', 'editor.title': 'Edit memory', 'editor.loading': 'Loading memory…',
      'editor.loadError': 'Could not load this memory: {message}', 'editor.required': 'Title and content are required.', 'editor.projectRequired': 'Choose a project for a project-scoped memory.',
      'editor.field.title': 'Title', 'editor.field.summary': 'Summary', 'editor.field.content': 'Content',
      'editor.field.kind': 'Kind', 'editor.field.scope': 'Scope', 'editor.field.project': 'Project',
      'editor.field.importance': 'Importance', 'editor.field.tags': 'Tags', 'editor.field.status': 'Status',
      'editor.pinned': 'Pinned', 'editor.tagsHint': 'Comma-separated, up to 8 tags.', 'editor.projectNone': 'No project available',
      'editor.save': 'Save changes', 'editor.saving': 'Saving…', 'editor.delete': 'Delete',
      'editor.confirmDelete': 'Confirm delete', 'editor.id': 'Record ID', 'editor.revision': 'Revision',
      'editor.source': 'Source', 'editor.session': 'Source session', 'editor.model': 'Model',
      'editor.created': 'Created', 'editor.updated': 'Updated', 'editor.sourceUnknown': 'Not recorded',
      'editor.actionError': 'The change failed: {message}', 'add.title': 'New memory', 'add.desc': 'Write a topic yourself. It is stored immediately and can be recalled in later sessions.',
      'add.submit': 'Create memory', 'add.busy': 'Creating…', 'session.title': 'Session tools',
      'session.desc': 'Extract memory now from a live conversation, or opt that session out of memory entirely.', 'session.select': 'Live session', 'session.noneShort': 'No live sessions', 'session.none': 'No live sessions in this host. Open a conversation to extract memory or change its opt-out.',
      'session.untitled': 'Session {id}', 'session.optedOut': 'opted out', 'session.extract': 'Extract now',
      'session.extracting': 'Extracting…', 'session.optOut': 'Opt out for this session', 'session.optIn': 'Opt in',
      'session.lastResult': 'Last extraction', 'session.resultLine': '{created} created · {updated} updated · {skipped} skipped', 'session.reason': 'Reason: {reason}',
      'session.model': 'Model: {model}', 'session.noReason': 'No reason given.', 'session.status.idle': 'idle',
      'session.status.running': 'running', 'session.status.error': 'error', 'notice.updated': 'Saved “{title}”.',
      'notice.deleted': 'Deleted “{title}”.', 'notice.pinned': 'Pinned “{title}”.', 'notice.unpinned': 'Unpinned “{title}”.',
      'notice.created': 'Created “{title}”.', 'notice.extracted': 'Extraction finished: {created} created, {updated} updated, {skipped} skipped.', 'notice.extractSkipped': 'Extraction skipped: {reason}',
      'notice.extractFailed': 'Extraction failed: {reason}', 'notice.optedOut': 'This session will no longer use memory.', 'notice.optedIn': 'This session will use memory again.',
      'notice.settingsSaved': 'Settings saved.', 'notice.exported': 'Memory export downloaded.', 'notice.cleared': 'Deleted {count} memories.',
      'activity.title': 'Recent activity', 'activity.desc': 'The latest extraction runs and their outcomes.', 'activity.empty': 'No extraction activity yet. Automatic runs will appear here as you chat.',
      'activity.counts': '{created} created · {updated} updated', 'activity.countsSkipped': '{created} created · {updated} updated · {skipped} skipped', 'activity.reason': 'Reason: {reason}',
      'activity.session': 'Session: {title}', 'activity.duration': '{ms} ms', 'activity.trigger.quiet': 'Quiet',
      'activity.trigger.boundary': 'Boundary', 'activity.trigger.dispose': 'Session closed', 'activity.trigger.manual': 'Manual',
      'activity.trigger.tool-extract': 'Tool extract', 'activity.status.ok': 'OK', 'activity.status.skipped': 'Skipped',
      'activity.status.error': 'Error', 'advanced.title': 'Advanced settings', 'advanced.desc': 'Runtime limits for automatic extraction, recall, and the memory tool.',
      'advanced.save': 'Save settings', 'advanced.saving': 'Saving…', 'advanced.noChanges': 'No advanced settings changed.',
      'advanced.invalid': 'Fix the highlighted fields before saving.', 'advanced.rangeError': 'Enter an integer between {min} and {max}.', 'advanced.autoExtract': 'Automatic extraction',
      'advanced.autoExtract.hint': 'Let the assistant judge finished spans and save topics.', 'advanced.projectsEnabled': 'Recall project-scoped memories', 'advanced.projectsEnabled.hint': 'Inject memories from the current project in addition to global ones.',
      'advanced.toolEnabled': 'Expose the memory tool', 'advanced.toolEnabled.hint': 'Allow the model to search, read, and save memories through its tool.', 'advanced.allowModelDelete': 'Allow model-requested deletions',
      'advanced.allowModelDelete.hint': 'The model may forget a memory only when the user explicitly asks.', 'advanced.redactSecrets': 'Redact secrets before saving', 'advanced.redactSecrets.hint': 'Strip credential-like strings from stored titles, summaries, and bodies.',
      'advanced.quietSeconds': 'Quiet period before judging (seconds, 3–600)', 'advanced.quietSeconds.hint': 'How long a conversation must be idle after a turn.', 'advanced.minNewChars': 'Minimum new characters (0–100000)',
      'advanced.minNewChars.hint': 'New human text required since the previous run.', 'advanced.minIntervalSeconds': 'Minimum gap per session (seconds, 0–86400)', 'advanced.minIntervalSeconds.hint': 'Two automatic runs in one session never start closer than this.',
      'advanced.maxRunsPerHour': 'Maximum automatic runs per hour (1–1000)', 'advanced.maxRunsPerHour.hint': 'Per-session cap on automatic extraction.', 'advanced.maxTopicsInPrompt': 'Index topics injected (1–500)',
      'advanced.maxTopicsInPrompt.hint': 'Upper bound on memory lines placed in the prompt.', 'advanced.maxIndexChars': 'Index size budget (characters, 500–200000)', 'advanced.maxIndexChars.hint': 'Character budget for the injected global index.',
      'advanced.projectMaxTopicsInPrompt': 'Project index topics injected (1–500)',
      'advanced.projectMaxTopicsInPrompt.hint': 'Upper bound on project memory lines placed in the prompt.',
      'advanced.projectMaxIndexChars': 'Project index size budget (characters, 500–200000)',
      'advanced.projectMaxIndexChars.hint': 'Character budget for the injected project memory index.',
      'editor.memoryDir': 'Memory directory', 'editor.file': 'Topic file',
      'advanced.judgeProvider': 'Judge provider', 'advanced.judgeProvider.hint': 'Empty inherits the current session route.', 'advanced.judgeModel': 'Judge model',
      'advanced.judgeModel.hint': 'Empty inherits the current session route. Set both fields to override.', 'data.title': 'Backup & cleanup', 'data.desc': 'Export a snapshot, or erase the memory library.',
      'export.title': 'Export JSON', 'export.desc': 'Download every memory with its full body, plus settings, as a JSON file.', 'export.button': 'Export JSON',
      'export.working': 'Exporting…', 'clear.title': 'Clear all memories', 'clear.desc': 'Permanently delete every memory topic in the global library and every known project. Settings, activity, and session opt-outs are kept.',
      'clear.label': 'Type DELETE to confirm', 'clear.placeholder': 'DELETE', 'clear.button': 'Clear all memories',
      'clear.busy': 'Clearing…', 'error.load': 'Could not load memory: {message}', 'error.action': 'The action failed: {message}',
      'error.export': 'Could not export memory: {message}', 'error.payload': 'The server returned an unexpected response.', 'error.withCode': '{kind} — {message}',
      'error.code.invalid-request': 'request rejected', 'error.code.not-found': 'memory not found', 'error.code.io-error': 'storage error',
      'error.code.disabled': 'memory is paused', 'error.code.judge-failed': 'judge failed', 'error.code.session-not-live': 'session is not live',
      'error.code.internal': 'server error', 'error.code.network': 'network error', 'error.code.request-failed': 'request failed',
      'error.code.generic': 'unexpected error',
    }

    const zh = {
      nav: '记忆', 'command.label': '记忆', 'command.description': '管理跨会话的持久记忆主题',
      'common.loading': '加载中…', 'common.retry': '重试',
      'common.cancel': '取消', 'common.dismiss': '关闭', 'common.working': '处理中…',
      'common.refresh': '刷新', 'common.all': '全部', 'common.unknown': '未知',
      'page.title': '记忆', 'page.intro': '助手在对话中自动保存的长期记忆。可在此查看、编辑、暂停或导出。', 'page.storage': '全局：{global} · 项目：{project}', 'status.line': '共 {total} 条 · 活跃 {active} 条 · 归档 {archived} 条 · 全局 {global} 条 · 项目 {project} 条 · 置顶 {pinned} 条 · {projects} 个项目',
      'status.lastUpdated': '最近更新 {time}', 'status.never': '从未', 'paused.badge': '已暂停',
      'paused.hint': '记忆已暂停：自动判定、召回和记忆工具都会停用，恢复后重新生效。', 'action.pause': '暂停记忆', 'action.resume': '恢复记忆',
      'notice.paused': '已暂停记忆。', 'notice.resumed': '已恢复记忆。', 'toolbar.search': '搜索记忆',
      'toolbar.searchPlaceholder': '搜索标题、摘要、标签、类型、范围…', 'toolbar.scope': '范围', 'toolbar.kind': '类型',
      'toolbar.status': '状态', 'toolbar.project': '项目', 'toolbar.projectAll': '全部项目',
      'toolbar.clearFilters': '清除筛选', 'kind.user': '用户', 'kind.preference': '偏好',
      'kind.project': '项目事实', 'kind.decision': '决策', 'kind.reference': '参考',
      'kind.todo': '待办', 'scope.global': '全局', 'scope.project': '项目',
      'scope.projectWith': '项目 · {project}', 'origin.auto': '自动', 'origin.tool': '工具',
      'origin.manual': '手动', 'origin.import': '导入', 'memory.title': '记忆条目',
      'memory.count': '显示 {shown} / 共 {total} 条', 'memory.untitled': '（未命名记忆）', 'memory.noSummary': '没有摘要',
      'memory.updated': '更新于 {time}', 'memory.importance': '重要性 {importance}', 'memory.pin': '置顶记忆',
      'memory.unpin': '取消置顶', 'memory.status.active': '活跃', 'memory.status.archived': '已归档',
      'memory.new': '新建记忆', 'memory.emptyTitle': '还没有记忆', 'memory.emptyBody': '记忆会持续工作：随着对话进行，助手会判断哪些信息值得保留并自动保存主题；之后在其他会话中会自动召回，无需额外操作。',
      'memory.emptyBodyAdd': '你可以在此“设置 → 记忆”页面下方手动添加一条记忆，或随时暂停记忆、导出备份。', 'memory.emptyAdd': '添加一条记忆', 'memory.noMatchesTitle': '没有符合筛选条件的记忆',
      'memory.noMatchesBody': '清除筛选以查看全部记忆。', 'editor.title': '编辑记忆', 'editor.loading': '正在加载记忆…',
      'editor.loadError': '无法加载这条记忆：{message}', 'editor.required': '标题和正文为必填项。', 'editor.projectRequired': '项目级记忆需要选择一个项目。',
      'editor.field.title': '标题', 'editor.field.summary': '摘要', 'editor.field.content': '正文',
      'editor.field.kind': '类型', 'editor.field.scope': '范围', 'editor.field.project': '项目',
      'editor.field.importance': '重要性', 'editor.field.tags': '标签', 'editor.field.status': '状态',
      'editor.pinned': '置顶', 'editor.tagsHint': '以逗号分隔，最多 8 个标签。', 'editor.projectNone': '没有可用项目',
      'editor.save': '保存修改', 'editor.saving': '正在保存…', 'editor.delete': '删除',
      'editor.confirmDelete': '确认删除', 'editor.id': '记录 ID', 'editor.revision': '版本',
      'editor.source': '来源', 'editor.session': '来源会话', 'editor.model': '模型',
      'editor.created': '创建时间', 'editor.updated': '更新时间', 'editor.sourceUnknown': '未记录',
      'editor.actionError': '修改失败：{message}', 'add.title': '新建记忆', 'add.desc': '手动写入一个主题。保存后会立即存储，并可在后续会话中召回。',
      'add.submit': '创建记忆', 'add.busy': '正在创建…', 'session.title': '会话工具',
      'session.desc': '立即从活跃会话中提取记忆，或让该会话完全退出记忆功能。', 'session.select': '活跃会话', 'session.noneShort': '没有活跃会话', 'session.none': '当前没有活跃会话。打开一个会话后即可立即提取记忆或调整退出设置。',
      'session.untitled': '会话 {id}', 'session.optedOut': '已退出', 'session.extract': '立即提取',
      'session.extracting': '正在提取…', 'session.optOut': '本会话退出记忆', 'session.optIn': '重新启用',
      'session.lastResult': '最近一次提取', 'session.resultLine': '新建 {created} 条 · 更新 {updated} 条 · 跳过 {skipped} 条', 'session.reason': '原因：{reason}',
      'session.model': '模型：{model}', 'session.noReason': '未提供原因。', 'session.status.idle': '空闲',
      'session.status.running': '运行中', 'session.status.error': '出错', 'notice.updated': '已保存“{title}”。',
      'notice.deleted': '已删除“{title}”。', 'notice.pinned': '已置顶“{title}”。', 'notice.unpinned': '已取消置顶“{title}”。',
      'notice.created': '已创建“{title}”。', 'notice.extracted': '提取完成：新建 {created} 条，更新 {updated} 条，跳过 {skipped} 条。', 'notice.extractSkipped': '已跳过提取：{reason}',
      'notice.extractFailed': '提取失败：{reason}', 'notice.optedOut': '本会话将不再使用记忆。', 'notice.optedIn': '本会话将重新使用记忆。',
      'notice.settingsSaved': '设置已保存。', 'notice.exported': '记忆导出已下载。', 'notice.cleared': '已删除 {count} 条记忆。',
      'activity.title': '最近活动', 'activity.desc': '最近的提取运行及其结果。', 'activity.empty': '还没有提取活动。随着对话进行，自动运行会显示在这里。',
      'activity.counts': '新建 {created} 条 · 更新 {updated} 条', 'activity.countsSkipped': '新建 {created} 条 · 更新 {updated} 条 · 跳过 {skipped} 条', 'activity.reason': '原因：{reason}',
      'activity.session': '会话：{title}', 'activity.duration': '{ms} 毫秒', 'activity.trigger.quiet': '静默',
      'activity.trigger.boundary': '会话边界', 'activity.trigger.dispose': '会话关闭', 'activity.trigger.manual': '手动',
      'activity.trigger.tool-extract': '工具提取', 'activity.status.ok': '成功', 'activity.status.skipped': '跳过',
      'activity.status.error': '失败', 'advanced.title': '高级设置', 'advanced.desc': '自动提取、召回和记忆工具的运行时限制。',
      'advanced.save': '保存设置', 'advanced.saving': '正在保存…', 'advanced.noChanges': '没有修改任何高级设置。',
      'advanced.invalid': '请先修正标红的字段。', 'advanced.rangeError': '请输入 {min} 到 {max} 之间的整数。', 'advanced.autoExtract': '自动提取',
      'advanced.autoExtract.hint': '允许助手判定已结束的对话片段并保存主题。', 'advanced.projectsEnabled': '召回项目级记忆', 'advanced.projectsEnabled.hint': '在全局记忆之外，同时注入当前项目的记忆。',
      'advanced.toolEnabled': '向模型开放记忆工具', 'advanced.toolEnabled.hint': '允许模型通过工具搜索、读取和保存记忆。', 'advanced.allowModelDelete': '允许模型请求删除',
      'advanced.allowModelDelete.hint': '仅当用户明确要求时，模型才可忘记某条记忆。', 'advanced.redactSecrets': '保存前脱敏密钥', 'advanced.redactSecrets.hint': '从标题、摘要和正文中移除凭据形态的字符串。',
      'advanced.quietSeconds': '判定前静默时长（秒，3–600）', 'advanced.quietSeconds.hint': '一轮对话结束后需静默多久才触发判定。', 'advanced.minNewChars': '最少新增字符数（0–100000）',
      'advanced.minNewChars.hint': '自上次运行以来需要新增的人类文本长度。', 'advanced.minIntervalSeconds': '同一会话最小间隔（秒，0–86400）', 'advanced.minIntervalSeconds.hint': '同一会话内两次自动运行的最近间隔。',
      'advanced.maxRunsPerHour': '每小时最多自动运行次数（1–1000）', 'advanced.maxRunsPerHour.hint': '每个会话的自动提取次数上限。', 'advanced.maxTopicsInPrompt': '注入索引的最大条数（1–500）',
      'advanced.maxTopicsInPrompt.hint': '提示词中最多放入多少条记忆。', 'advanced.maxIndexChars': '索引字符预算（字符，500–200000）', 'advanced.maxIndexChars.hint': '注入的全局记忆索引允许占用的最大字符数。',
      'advanced.projectMaxTopicsInPrompt': '项目索引注入条数（1–500）',
      'advanced.projectMaxTopicsInPrompt.hint': '提示词中最多放入多少条项目记忆。',
      'advanced.projectMaxIndexChars': '项目索引字符预算（字符，500–200000）',
      'advanced.projectMaxIndexChars.hint': '注入的项目记忆索引允许占用的最大字符数。',
      'editor.memoryDir': '记忆目录', 'editor.file': '主题文件',
      'advanced.judgeProvider': '判定服务商', 'advanced.judgeProvider.hint': '留空则沿用当前会话的路由。', 'advanced.judgeModel': '判定模型',
      'advanced.judgeModel.hint': '留空则沿用当前会话的路由；两个字段同时填写才会覆盖。', 'data.title': '备份与清理', 'data.desc': '导出快照，或清空整个记忆库。',
      'export.title': '导出 JSON', 'export.desc': '将全部记忆（含正文）和设置下载为一个 JSON 文件。', 'export.button': '导出 JSON',
      'export.working': '正在导出…', 'clear.title': '清空所有记忆', 'clear.desc': '永久删除全局记忆以及所有已知项目中的全部记忆主题。设置、活动和会话退出标记会保留。',
      'clear.label': '输入 DELETE 以确认', 'clear.placeholder': 'DELETE', 'clear.button': '清空所有记忆',
      'clear.busy': '正在清空…', 'error.load': '无法加载记忆：{message}', 'error.action': '操作失败：{message}',
      'error.export': '无法导出记忆：{message}', 'error.payload': '服务器返回了意外的响应。', 'error.withCode': '{kind} — {message}',
      'error.code.invalid-request': '请求被拒绝', 'error.code.not-found': '记忆不存在', 'error.code.io-error': '存储错误',
      'error.code.disabled': '记忆已暂停', 'error.code.judge-failed': '判定失败', 'error.code.session-not-live': '会话不在运行中',
      'error.code.internal': '服务内部错误', 'error.code.network': '网络错误', 'error.code.request-failed': '请求失败',
      'error.code.generic': '未知错误',
    }
    /* ------------------------- Runtime + translation ------------------------- */

    const runtime = { translate: null }

    function interpolate(template, params) {
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
    }

    function fallbackTranslate(key, params) {
      return interpolate(typeof en[key] === 'string' ? en[key] : key, params)
    }

    function translate(key, params) {
      if (runtime.translate !== null) {
        try {
          const text = runtime.translate(key, params)
          if (typeof text === 'string' && text !== '' && text !== key) return text
        } catch {
          // Fall through to the inline English dictionary.
        }
      }
      return fallbackTranslate(key, params)
    }

    function translateOf(props) {
      return props !== undefined && props !== null && typeof props.t === 'function' ? props.t : translate
    }

    /* Small pure helpers */

    const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
    const asString = value => typeof value === 'string' ? value : ''
    const asNumber = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
    const clampInteger = (value, fallback, min, max) => Math.min(max, Math.max(min, Math.round(asNumber(value, fallback))))
    const codeOf = cause => isObject(cause) && typeof cause.code === 'string' ? cause.code : ''
    const pad2 = value => value < 10 ? '0' + String(value) : String(value)
    const detailElementId = id => 'dshmemory-detail-' + encodeURIComponent(id)
    const enumLabel = (prefix, value, known, t) => (known.indexOf(value) === -1 ? t('common.unknown') : t(prefix + value))

    function asStringArray(value) {
      return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item !== '') : []
    }

    function messageOf(cause) {
      if (cause instanceof Error && typeof cause.message === 'string' && cause.message !== '') return cause.message
      if (typeof cause === 'string' && cause !== '') return cause
      return String(cause)
    }

    function failureText(cause, t) {
      const code = codeOf(cause)
      const kind = ERROR_CODES.indexOf(code) === -1 ? t('error.code.generic') : t('error.code.' + code)
      return t('error.withCode', { kind, message: messageOf(cause) })
    }

    function formatDateTime(value) {
      if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return ''
      const date = value instanceof Date ? value : new Date(value)
      if (!Number.isFinite(date.getTime())) return ''
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    const formatDateStamp = date => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    const shortId = value => {
      const text = asString(value)
      return text.length > 12 ? text.slice(0, 8) + '…' : text
    }

    function truncate(value, max) {
      return typeof value === 'string' && value.length > max
        ? value.slice(0, Math.max(0, max - 1)) + '…'
        : value
    }

    function scopeText(item, t) {
      if (item.scope !== 'project') return t('scope.global')
      const project = isObject(item.project) ? asString(item.project.name) || asString(item.project.key) : ''
      return project === '' ? t('scope.project') : t('scope.projectWith', { project })
    }

    function sessionTitleOf(session, t) {
      const title = asString(session.title).trim()
      return title !== '' ? title : t('session.untitled', { id: shortId(session.sessionId) || '—' })
    }

    function sessionStatusOf(session, t) {
      const status = asString(session.status)
      return status === 'idle' || status === 'running' || status === 'error'
        ? t('session.status.' + status)
        : (status === '' ? t('common.unknown') : status)
    }

    function mergeProjects(base, ...extras) {
      const seen = new Set()
      const merged = []
      for (const candidate of base.concat(extras)) {
        if (!isObject(candidate)) continue
        const key = asString(candidate.key)
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        merged.push({ key, name: asString(candidate.name) || key, count: Math.max(0, Math.round(asNumber(candidate.count, 0))) })
      }
      merged.sort((left, right) => left.name.localeCompare(right.name))
      return merged
    }

    function downloadJson(filename, value) {
      const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      try {
        anchor.click()
      } finally {
        anchor.remove()
        window.setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
      }
    }
    /* ------------------------- HTTP layer (authenticated same-origin JSON routes) ------------------------- */

    function requestError(code, message, status) {
      const error = new Error(message)
      error.code = code
      error.status = status
      return error
    }

    function withSession(url, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return url
      return url + (url.indexOf('?') === -1 ? '?' : '&') + 'sessionId=' + encodeURIComponent(sessionId)
    }

    async function requestJson(url, init) {
      let response
      try {
        const headers = Object.assign({ accept: 'application/json' }, init === undefined ? undefined : init.headers)
        response = await fetch(url, Object.assign(
          { credentials: 'same-origin', cache: 'no-store' },
          init,
          { headers },
        ))
      } catch (cause) {
        throw requestError('network', messageOf(cause), 0)
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (response.ok && isObject(payload) && payload.ok === true) return payload.value
      const error = isObject(payload) && isObject(payload.error) ? payload.error : undefined
      const code = error !== undefined && typeof error.code === 'string' ? error.code : 'request-failed'
      const message = error !== undefined && typeof error.message === 'string' && error.message !== ''
        ? error.message
        : 'HTTP ' + response.status
      throw requestError(code, message, response.status)
    }

    function fetchState(sessionId) {
      return requestJson(withSession(API_STATE, sessionId))
    }

    function fetchMemory(id, projectKey) {
      let url = API_MEMORY + '?id=' + encodeURIComponent(id)
      if (typeof projectKey === 'string' && projectKey !== '') {
        url += '&projectKey=' + encodeURIComponent(projectKey)
      }
      return requestJson(url)
    }

    function postAction(action, payload) {
      return requestJson(API_ACTION, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({}, payload, { action })),
      })
    }
    /* ------------------------- Wire normalization (never throws on unexpected payloads) ------------------------- */

    function normalizeSettings(raw) {
      const source = isObject(raw) ? raw : {}
      const settings = {}
      for (const key of ['enabled', ...ADVANCED_BOOLEANS]) {
        settings[key] = typeof source[key] === 'boolean' ? source[key] : SETTINGS_DEFAULTS[key] === true
      }
      for (const field of ADVANCED_NUMBERS) settings[field.key] = clampInteger(source[field.key], field.fallback, field.min, field.max)
      settings.judgeProvider = asString(source.judgeProvider)
      settings.judgeModel = asString(source.judgeModel)
      return settings
    }

    function normalizeStats(raw) {
      const source = isObject(raw) ? raw : {}
      const count = value => Math.max(0, Math.round(asNumber(value, 0)))
      return {
        total: count(source.total), active: count(source.active), archived: count(source.archived),
        global: count(source.global), project: count(source.project), pinned: count(source.pinned),
        projectCount: count(source.projectCount), lastUpdatedAt: asString(source.lastUpdatedAt),
        paused: source.paused === true,
      }
    }

    function normalizeProject(raw) {
      if (!isObject(raw)) return null
      const key = asString(raw.key).trim()
      if (key === '') return null
      const counts = isObject(raw.counts) ? raw.counts : {}
      return {
        key,
        name: asString(raw.name).trim() || key,
        memoryDir: asString(raw.memoryDir),
        loaded: raw.loaded === true,
        watching: raw.watching === true,
        error: asString(raw.error),
        count: Math.max(0, Math.round(asNumber(counts.active ?? raw.count, 0))),
      }
    }

    function normalizeSource(raw) {
      const source = isObject(raw) ? raw : {}
      return {
        origin: MEMORY_ORIGINS.indexOf(source.origin) === -1 ? 'auto' : source.origin,
        sessionId: asString(source.sessionId), sessionTitle: asString(source.sessionTitle),
        model: asString(source.model),
      }
    }

    function normalizeMemory(raw) {
      if (!isObject(raw)) return null
      const id = asString(raw.id)
      if (id === '') return null
      const scope = MEMORY_SCOPES.indexOf(raw.scope) === -1 ? 'global' : raw.scope
      const kind = MEMORY_KINDS.indexOf(raw.kind) === -1 ? 'reference' : raw.kind
      const status = MEMORY_STATUSES.indexOf(raw.status) === -1 ? 'active' : raw.status
      const project = scope === 'project' ? normalizeProject(raw.project) : null
      return {
        id, title: asString(raw.title), summary: asString(raw.summary), content: asString(raw.content),
        kind, scope, project,
        projectKey: asString(raw.projectKey) || (project === null ? '' : project.key),
        memoryDir: asString(raw.memoryDir) || (project === null ? '' : project.memoryDir),
        file: asString(raw.file),
        tags: asStringArray(raw.tags),
        importance: clampInteger(raw.importance, 3, 1, 5), pinned: raw.pinned === true, status,
        createdAt: asString(raw.createdAt), updatedAt: asString(raw.updatedAt),
        revision: Math.max(1, Math.round(asNumber(raw.revision, 1))),
        source: normalizeSource(raw.source),
        projectLabel: asString(raw.projectLabel) || (project === null ? '' : project.name),
      }
    }

    function normalizeActivity(raw) {
      if (!isObject(raw)) return null
      const at = asString(raw.at)
      if (at === '') return null
      return {
        at,
        trigger: ACTIVITY_TRIGGERS.indexOf(raw.trigger) === -1 ? 'manual' : raw.trigger,
        status: ACTIVITY_STATUSES.indexOf(raw.status) === -1 ? 'ok' : raw.status,
        created: Math.max(0, Math.round(asNumber(raw.created, 0))),
        updated: Math.max(0, Math.round(asNumber(raw.updated, 0))),
        skipped: Math.max(0, Math.round(asNumber(raw.skipped, 0))),
        sessionId: asString(raw.sessionId), sessionTitle: asString(raw.sessionTitle),
        reason: asString(raw.reason),
        durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
          ? Math.max(0, Math.round(raw.durationMs)) : null,
      }
    }

    function normalizeLiveSession(raw) {
      if (!isObject(raw)) return null
      const sessionId = asString(raw.sessionId)
      if (sessionId === '') return null
      return {
        sessionId, title: asString(raw.title), status: asString(raw.status) || 'idle',
        optedOut: raw.optedOut === true, cwd: asString(raw.cwd),
      }
    }

    function normalizeExtractResult(raw) {
      const source = isObject(raw) ? raw : {}
      return {
        status: ACTIVITY_STATUSES.indexOf(source.status) === -1 ? 'error' : source.status,
        created: Math.max(0, Math.round(asNumber(source.created, 0))),
        updated: Math.max(0, Math.round(asNumber(source.updated, 0))),
        skipped: Math.max(0, Math.round(asNumber(source.skipped, 0))),
        reason: asString(source.reason), model: asString(source.model),
      }
    }

    function normalizeSession(raw) {
      const source = isObject(raw) ? raw : {}
      return { id: asString(source.id), optedOut: source.optedOut === true, project: normalizeProject(source.project) }
    }

    function normalizeState(value) {
      if (!isObject(value)) return null
      const memories = []
      const seenMemories = new Set()
      if (Array.isArray(value.memories)) {
        for (const candidate of value.memories) {
          const memory = normalizeMemory(candidate)
          if (memory === null || seenMemories.has(memory.id)) continue
          seenMemories.add(memory.id)
          memories.push(memory)
        }
      }
      const projects = []
      const seenProjects = new Set()
      if (Array.isArray(value.projects)) {
        for (const candidate of value.projects) {
          const project = normalizeProject(candidate)
          if (project === null || seenProjects.has(project.key)) continue
          seenProjects.add(project.key)
          projects.push(project)
        }
      }
      projects.sort((left, right) => left.name.localeCompare(right.name))
      const activity = []
      if (Array.isArray(value.activity)) {
        for (const candidate of value.activity) {
          const entry = normalizeActivity(candidate)
          if (entry !== null) activity.push(entry)
        }
      }
      const liveSessions = []
      const seenSessions = new Set()
      if (Array.isArray(value.liveSessions)) {
        for (const candidate of value.liveSessions) {
          const session = normalizeLiveSession(candidate)
          if (session === null || seenSessions.has(session.sessionId)) continue
          seenSessions.add(session.sessionId)
          liveSessions.push(session)
        }
      }
      return {
        memoryRoot: asString(value.memoryRoot),
        settings: normalizeSettings(value.settings), stats: normalizeStats(value.stats),
        memories, projects, activity, liveSessions, session: normalizeSession(value.session),
      }
    }

    function settingsSignature(settings) {
      const booleans = ADVANCED_BOOLEANS.map(key => (settings[key] === true ? '1' : '0')).join('')
      const numbers = ADVANCED_NUMBERS.map(field => String(asNumber(settings[field.key], field.fallback))).join(',')
      const strings = ADVANCED_STRINGS.map(key => asString(settings[key])).join('\u0000')
      return booleans + '|' + numbers + '|' + strings
    }
    /* ------------------------- Icons (14px stroke glyphs) ------------------------- */

    /** Saved-topic bookmark with a recall sparkle; matches the settings-nav glyph. */
    function MemoryGlyph({ size = 16, className } = {}) {
      return h('svg', {
        width: size,
        height: size,
        className: className,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        strokeWidth: 1.3,
      },
        h('path', {
          d: 'M4.6 2.25h6.8c.4142 0 .75.3358.75.75v10.04c0 .4072-.4655.6411-.7887.4084L8 11.09l-3.3613 2.3594c-.3232.2327-.7887-.0012-.7887-.4084V3c0-.4142.3358-.75.75-.75Z',
          stroke: 'currentColor',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M13.35 9.16c.16.94.55 1.33 1.49 1.49-.94.16-1.33.55-1.49 1.49-.16-.94-.55-1.33-1.49-1.49.94-.16 1.33-.55 1.49-1.49Z',
          fill: 'currentColor',
        }),
      )
    }

    function iconProps(className) {
      return {
        className,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }
    }



    function IconChevron({ open, className }) {
      return h('svg', Object.assign(iconProps(className || 'dshmemory-icon'), { 'data-open': open === true ? 'true' : 'false' }),
        h('path', { d: 'M6 3.2l4.8 4.8L6 12.8' }),
      )
    }

    function IconStar({ filled, className }) {
      return h('svg', Object.assign(iconProps(className || 'dshmemory-icon'), {
        fill: filled === true ? 'currentColor' : 'none',
      }),
        h('path', { d: 'M8 1.9l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.3l-3.6 1.9.7-4.1-3-2.9 4.1-.6z' }),
      )
    }

    function IconAlert({ className }) {
      return h('svg', iconProps(className || 'dshmemory-icon'),
        h('circle', { cx: 8, cy: 8, r: 6 }),
        h('path', { d: 'M8 4.8v3.9M8 11.2h.01' }),
      )
    }


    /* ------------------------- Scoped stylesheet (one <style> element per rendered root) ------------------------- */

    const STYLE_TEXT = `
.dshmemory-section { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 820px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; } .dshmemory-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dshmemory-headText { display: flex; flex-direction: column; gap: 2px; min-width: 0; } .dshmemory-path { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); } .dshmemory-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; }
.dshmemory-intro { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; } .dshmemory-stats { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }
.dshmemory-headActions { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; } .dshmemory-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 30px; padding: 0 12px; border: none; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; cursor: pointer; }
.dshmemory-btn:disabled { opacity: 0.45; cursor: default; } .dshmemory-btnPrimary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dshmemory-btnPrimary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); } .dshmemory-btnOutline { border: 0.5px solid var(--dsw-alias-border-l3); }
.dshmemory-btnOutline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } .dshmemory-btnGhost { color: var(--dsw-alias-label-secondary); }
.dshmemory-btnGhost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } .dshmemory-btnDanger { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-foreground); }
.dshmemory-btnDanger:hover:not(:disabled) { opacity: 0.9; } .dshmemory-btnDangerText { color: var(--dsw-alias-state-error-primary); }
.dshmemory-btnDangerText:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); } .dshmemory-btnSm { height: 24px; padding: 0 8px; font-size: 11px; line-height: 16px; }
.dshmemory-icon { flex: none; width: 13px; height: 13px; }
.dshmemory-glyph { font-size: 14px; line-height: 1; } .dshmemory-iconBtn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--dsw-radius-xs); background: transparent; color: inherit; cursor: pointer; }
.dshmemory-iconBtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshmemory-btn:focus-visible,
.dshmemory-iconBtn:focus-visible,
.dshmemory-rowMain:focus-visible,
.dshmemory-pinBtn:focus-visible,
.dshmemory-details > summary:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dshmemory-banner, .dshmemory-notice { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: var(--dsw-radius-md); font-size: 12px; line-height: 18px; }
.dshmemory-banner[data-kind='warning'] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-warn-label); }
.dshmemory-banner[data-kind='error'], .dshmemory-notice[data-kind='error'] { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.dshmemory-notice[data-kind='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
.dshmemory-bannerText, .dshmemory-noticeText { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dshmemory-bannerIcon { flex: none; width: 14px; height: 14px; margin-top: 1px; }
.dshmemory-banner .dshmemory-btn { flex: none; }
.dshmemory-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 12px; border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill); } .dshmemory-cardHead { display: flex; flex-direction: column; gap: 2px; }
.dshmemory-cardTitle { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; } .dshmemory-cardDesc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dshmemory-toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; padding: 12px; border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill); } .dshmemory-search { flex: 1 1 240px; min-width: 180px; }
.dshmemory-filter { display: flex; flex-direction: column; gap: 3px; min-width: 106px; } .dshmemory-filterLabel { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dshmemory-toolbarActions { display: flex; align-items: center; gap: 6px; margin-left: auto; } .dshmemory-toolbar .dshmemory-input, .dshmemory-toolbar .dshmemory-select { height: 30px; }
.dshmemory-block { display: flex; flex-direction: column; gap: 8px; } .dshmemory-blockHead { display: flex; align-items: baseline; gap: 8px; min-height: 22px; }
.dshmemory-blockTitle { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; } .dshmemory-blockCount { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dshmemory-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; } .dshmemory-item { overflow: hidden; border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill); }
.dshmemory-row { display: flex; align-items: stretch; } .dshmemory-rowMain { flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 10px 12px; border: none; border-radius: var(--dsw-radius-lg); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dshmemory-rowMain:hover { background: var(--dsw-alias-interactive-bg-hover); } .dshmemory-rowTop { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dshmemory-chevron { flex: none; width: 12px; height: 12px; color: var(--dsw-alias-label-tertiary); transition: transform 120ms ease; } .dshmemory-chevron[data-open='true'] { transform: rotate(90deg); }
.dshmemory-rowTitle { min-width: 0; overflow: hidden; font-size: 13px; line-height: 19px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; } .dshmemory-rowSummary { overflow: hidden; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; }
.dshmemory-rowBadges { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 1px; } .dshmemory-rowMeta { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); }
.dshmemory-pinBtn { flex: none; align-self: flex-start; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; margin: 6px 6px 0 0; padding: 0; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-dimmed); cursor: pointer; } .dshmemory-pinBtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dshmemory-pinBtn[data-pinned='true'] { color: var(--dsw-alias-state-warn-primary); } .dshmemory-pinBtn:disabled { opacity: 0.45; cursor: default; }
.dshmemory-pinBtn .dshmemory-icon { width: 15px; height: 15px; }
.dshmemory-badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 0 7px; font-size: 10px; line-height: 16px; font-weight: 500; white-space: nowrap; }
.dshmemory-badge[data-tone='neutral'] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dshmemory-badge[data-tone='outline'] { border: 0.5px solid var(--dsw-alias-border-l4); color: var(--dsw-alias-label-tertiary); }
.dshmemory-badge[data-tone='info'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); }
.dshmemory-badge[data-tone='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
.dshmemory-badge[data-tone='warning'] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); }
.dshmemory-badge[data-tone='error'] { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.dshmemory-detail { display: flex; flex-direction: column; gap: 12px; padding: 14px 12px; border-top: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); } .dshmemory-detailHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dshmemory-detailTitle { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; } .dshmemory-detailStatus { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dshmemory-formGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; } .dshmemory-fieldWide { grid-column: 1 / -1; }
.dshmemory-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; } .dshmemory-fieldLabel { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dshmemory-fieldHint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); } .dshmemory-fieldError { font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-error-primary); }
.dshmemory-input, .dshmemory-select { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); outline: none; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; } .dshmemory-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dshmemory-input:focus-visible, .dshmemory-select:focus-visible { border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 18%, transparent); } .dshmemory-input:disabled, .dshmemory-select:disabled { opacity: 0.6; }
.dshmemory-textarea { height: auto; min-height: 64px; padding: 7px 10px; line-height: 19px; resize: vertical; } .dshmemory-textareaBody { min-height: 160px; font-size: 13px; line-height: 20px; }
.dshmemory-checkRow { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-primary); } .dshmemory-checkRow input { flex: none; margin: 2px 0 0; accent-color: var(--dsw-alias-state-business-primary); }
.dshmemory-checkCopy { display: flex; flex-direction: column; gap: 1px; min-width: 0; } .dshmemory-checkHint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.dshmemory-detailActions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; } .dshmemory-actionsEnd { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.dshmemory-errorText { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; } .dshmemory-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 5px 12px; padding: 9px 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); font-size: 11px; line-height: 16px; }
.dshmemory-metaRow { display: flex; gap: 4px; min-width: 0; } .dshmemory-metaKey { flex: none; color: var(--dsw-alias-label-tertiary); }
.dshmemory-metaValue { min-width: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; } .dshmemory-mono { font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
.dshmemory-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 24px; border: 0.5px dashed var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill); } .dshmemory-emptyTitle { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
.dshmemory-emptyText { margin: 0; max-width: 620px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); } .dshmemory-emptyActions { margin-top: 6px; }
.dshmemory-addPanel { display: flex; flex-direction: column; gap: 10px; padding: 14px 12px; border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill); } .dshmemory-sessionControls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.dshmemory-sessionSelect { flex: 1 1 280px; min-width: 200px; } .dshmemory-result { display: flex; flex-direction: column; gap: 4px; padding: 10px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); font-size: 12px; line-height: 18px; }
.dshmemory-resultHead { display: flex; align-items: center; gap: 8px; } .dshmemory-resultTitle { font-weight: 600; }
.dshmemory-resultLine { margin: 0; color: var(--dsw-alias-label-secondary); } .dshmemory-resultDetail { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dshmemory-dataRow { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; } .dshmemory-dataRow + .dshmemory-dataRow { padding-top: 10px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dshmemory-dataCopy { flex: 1 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 1px; } .dshmemory-dataTitle { font-size: 13px; line-height: 19px; font-weight: 500; }
.dshmemory-dataDesc { margin: 0; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); } .dshmemory-confirmPanel { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-interactive-bg-hover-danger); }
.dshmemory-confirmControls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; } .dshmemory-confirmControls .dshmemory-field { flex: 1 1 200px; }
.dshmemory-details { border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill); } .dshmemory-details > summary { display: flex; align-items: center; gap: 8px; padding: 12px; cursor: pointer; list-style: none; }
.dshmemory-details > summary::-webkit-details-marker { display: none; } .dshmemory-details[open] > summary .dshmemory-chevron[data-open='false'] { transform: rotate(90deg); }
.dshmemory-summaryText { display: flex; flex-direction: column; gap: 1px; min-width: 0; } .dshmemory-detailsBody { display: flex; flex-direction: column; gap: 12px; padding: 12px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dshmemory-toggleGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 14px; } .dshmemory-settingsActions { display: flex; justify-content: flex-end; gap: 8px; }
.dshmemory-activity { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; } .dshmemory-activityItem { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; }
.dshmemory-activityItem + .dshmemory-activityItem { border-top: 0.5px solid var(--dsw-alias-border-l1); } .dshmemory-activityTop { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dshmemory-activityTime { font-variant-numeric: tabular-nums; } .dshmemory-activityCounts { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.dshmemory-activityReason { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; } .dshmemory-activitySession { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }
.dshmemory-status { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); } .dshmemory-skeleton { display: flex; flex-direction: column; gap: 8px; }
.dshmemory-skeletonRow { height: 44px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-skeleton); animation: dshmemory-pulse 1.4s ease-in-out infinite; }
@keyframes dshmemory-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.dshmemory-spinner { display: inline-block; flex: none; width: 12px; height: 12px; border: 1.5px solid var(--dsw-alias-border-l3); border-top-color: var(--dsw-alias-state-business-primary); border-radius: 50%; animation: dshmemory-spin 0.8s linear infinite; }
@keyframes dshmemory-spin { to { transform: rotate(360deg); } }
@media (max-width: 620px) {
.dshmemory-head { flex-direction: column; } .dshmemory-headActions { width: 100%; }
.dshmemory-formGrid { grid-template-columns: minmax(0, 1fr); } .dshmemory-fieldWide { grid-column: auto; }
.dshmemory-toolbarActions { width: 100%; margin-left: 0; justify-content: flex-end; } .dshmemory-actionsEnd { width: 100%; margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
.dshmemory-chevron, .dshmemory-skeletonRow, .dshmemory-spinner { transition: none; animation: none; }
}
`

    function StyleElement() {
      return h('style', { 'data-dshmemory-styles': true }, STYLE_TEXT)
    }
    /* ------------------------- Shared controls ------------------------- */

    function CheckboxRow({ checked, onChange, label, hint, disabled }) {
      return h('label', { className: 'dshmemory-checkRow' },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: event => { onChange(event.target.checked) },
        }),
        h('span', { className: 'dshmemory-checkCopy' },
          h('span', null, label),
          hint === undefined || hint === '' ? null : h('span', { className: 'dshmemory-checkHint' }, hint),
        ),
      )
    }

    function Badge({ tone, children }) {
      return h('span', { className: 'dshmemory-badge', 'data-tone': tone === undefined ? 'neutral' : tone }, children)
    }

    function Button({ variant, disabled, onClick, children, title, ariaLabel, size }) {
      const variants = {
        primary: 'dshmemory-btnPrimary',
        outline: 'dshmemory-btnOutline',
        ghost: 'dshmemory-btnGhost',
        danger: 'dshmemory-btnDanger',
        dangerText: 'dshmemory-btnDangerText',
      }
      const variantClass = variants[variant] === undefined ? variants.ghost : variants[variant]
      return h('button', {
        type: 'button',
        className: 'dshmemory-btn ' + variantClass + (size === 'sm' ? ' dshmemory-btnSm' : ''),
        disabled: disabled === true,
        onClick: onClick,
        title: title,
        'aria-label': ariaLabel,
      }, children)
    }

    function Field({ id, label, hint, error, children }) {
      return h('div', { className: 'dshmemory-field' },
        h('label', { className: 'dshmemory-fieldLabel', htmlFor: id }, label),
        children,
        error !== undefined && error !== ''
          ? h('span', { className: 'dshmemory-fieldError' }, error)
          : (hint === undefined || hint === '' ? null : h('span', { className: 'dshmemory-fieldHint' }, hint)),
      )
    }

    function TextField({ id, label, value, onChange, wide, hint, error, rows, maxLength, type, min, max, step, disabled, placeholder, textareaClassName }) {
      const control = rows === undefined
        ? h(TextInput, { id, value, onChange, maxLength, type, min, max, step, disabled, placeholder })
        : h(TextArea, { id, value, onChange, rows, maxLength, disabled, placeholder, className: textareaClassName })
      return h('div', { className: 'dshmemory-field' + (wide ? ' dshmemory-fieldWide' : '') },
        h(Field, { id, label, hint, error }, control))
    }

    function SelectField({ id, label, value, onChange, options, disabled, wide, hint, error }) {
      return h('div', { className: 'dshmemory-field' + (wide ? ' dshmemory-fieldWide' : '') },
        h(Field, { id, label, hint, error }, h(SelectInput, { id, value, onChange, options, disabled })))
    }

    function TextInput({ id, value, onChange, type, placeholder, maxLength, min, max, step, disabled, ariaLabel }) {
      return h('input', {
        id,
        className: 'dshmemory-input',
        type: type === undefined ? 'text' : type,
        value,
        placeholder,
        maxLength,
        min,
        max,
        step,
        disabled: disabled === true,
        'aria-label': ariaLabel,
        autoComplete: 'off',
        onChange: event => { onChange(event.target.value) },
      })
    }

    function TextArea({ id, value, onChange, rows, maxLength, placeholder, disabled, className }) {
      return h('textarea', {
        id,
        className: 'dshmemory-input dshmemory-textarea' + (className === undefined ? '' : ' ' + className),
        value,
        rows: rows === undefined ? 6 : rows,
        maxLength,
        placeholder,
        disabled: disabled === true,
        onChange: event => { onChange(event.target.value) },
      })
    }

    function SelectInput({ id, value, onChange, options, disabled, ariaLabel }) {
      return h('select', {
        id,
        className: 'dshmemory-select',
        value,
        disabled: disabled === true,
        'aria-label': ariaLabel,
        onChange: event => { onChange(event.target.value) },
      }, options.map(option => h('option', {
        key: option.value,
        value: option.value,
        disabled: option.disabled === true,
      }, option.label)))
    }

    function Spinner() {
      return h('span', { className: 'dshmemory-spinner', 'aria-hidden': 'true' })
    }

    function Card({ title, desc, children }) {
      return h('section', { className: 'dshmemory-card' },
        h('div', { className: 'dshmemory-cardHead' },
          h('h3', { className: 'dshmemory-cardTitle' }, title),
          desc === undefined || desc === '' ? null : h('p', { className: 'dshmemory-cardDesc' }, desc)),
        children)
    }

    function ErrorBanner({ t, message, onRetry, retrying }) {
      return h('div', { className: 'dshmemory-banner', 'data-kind': 'error', role: 'alert' },
        h(IconAlert, { className: 'dshmemory-bannerIcon' }),
        h('span', { className: 'dshmemory-bannerText' }, message),
        h(Button, {
          variant: 'outline',
          size: 'sm',
          disabled: retrying,
          onClick: onRetry,
        }, retrying ? t('common.loading') : t('common.retry')),
      )
    }

    function Notice({ t, notice, onDismiss }) {
      return h('div', {
        className: 'dshmemory-notice',
        'data-kind': notice.kind,
        role: notice.kind === 'error' ? 'alert' : 'status',
      },
        notice.kind === 'error' ? h(IconAlert, { className: 'dshmemory-bannerIcon' }) : null,
        h('span', { className: 'dshmemory-noticeText' }, notice.text),
        h('button', {
          type: 'button',
          className: 'dshmemory-iconBtn',
          'aria-label': t('common.dismiss'),
          onClick: onDismiss,
        }, h('span', { className: 'dshmemory-glyph', 'aria-hidden': 'true' }, '×')),
      )
    }

    function LoadingState({ t }) {
      return h(Fragment, null,
        h('div', { className: 'dshmemory-skeleton', 'aria-hidden': 'true' },
          h('div', { className: 'dshmemory-skeletonRow' }),
          h('div', { className: 'dshmemory-skeletonRow' }),
          h('div', { className: 'dshmemory-skeletonRow' }),
        ),
        h('p', { className: 'dshmemory-status', role: 'status' }, h(Spinner), t('common.loading')),
      )
    }
    /* ------------------------- Toolbar ------------------------- */

    function MemoryToolbar({ t, filters, projects, busy, refreshing, onFilter, onClearFilters, onRefresh, onCreate }) {
      const all = { value: 'all', label: t('common.all') }
      const kindOptions = [all].concat(MEMORY_KINDS.map(kind => ({ value: kind, label: t('kind.' + kind) })))
      const scopeOptions = [
        all, { value: 'global', label: t('scope.global') }, { value: 'project', label: t('scope.project') },
      ]
      const statusOptions = [
        all, { value: 'active', label: t('memory.status.active') }, { value: 'archived', label: t('memory.status.archived') },
      ]
      const projectOptions = [{ value: '', label: t('toolbar.projectAll') }]
        .concat(projects.map(project => ({ value: project.key, label: project.count > 0 ? `${project.name} (${project.count})` : project.name })))
      const filter = (key, label, options) => h('div', { className: 'dshmemory-filter' },
        h('label', { className: 'dshmemory-filterLabel', htmlFor: 'dshmemory-filter-' + key }, label),
        h(SelectInput, {
          id: 'dshmemory-filter-' + key, value: filters[key], options,
          onChange: value => { onFilter(key, value) },
        }))
      return h('div', { className: 'dshmemory-toolbar' },
        h('div', { className: 'dshmemory-search' },
          h(TextInput, {
            id: 'dshmemory-search', value: filters.query, placeholder: t('toolbar.searchPlaceholder'),
            ariaLabel: t('toolbar.search'), onChange: value => { onFilter('query', value) },
          })),
        filter('scope', t('toolbar.scope'), scopeOptions),
        filter('kind', t('toolbar.kind'), kindOptions),
        filter('status', t('toolbar.status'), statusOptions),
        projects.length === 0 ? null : filter('project', t('toolbar.project'), projectOptions),
        h('div', { className: 'dshmemory-toolbarActions' },
          h(Button, { variant: 'ghost', onClick: onClearFilters }, t('toolbar.clearFilters')),
          h(Button, { variant: 'ghost', disabled: busy || refreshing, onClick: onRefresh },
            refreshing ? h(Spinner) : h('span', { className: 'dshmemory-glyph', 'aria-hidden': 'true' }, '↻'),
            h('span', null, t('common.refresh'))),
          h(Button, { variant: 'primary', disabled: busy || refreshing, onClick: onCreate },
            h('span', { className: 'dshmemory-glyph', 'aria-hidden': 'true' }, '+'), t('memory.new'))),
      )
    }
    /* ------------------------- Memory row + detail editor ------------------------- */

    function MemoryRow({ item, t, expanded, busy, onToggle, onTogglePin }) {
      const timestamp = formatDateTime(item.updatedAt) || '—'
      const origin = enumLabel('origin.', item.source.origin, MEMORY_ORIGINS, t)
      return h('div', { className: 'dshmemory-row' },
        h('button', {
          type: 'button',
          className: 'dshmemory-rowMain',
          'aria-expanded': expanded === true,
          'aria-controls': expanded ? detailElementId(item.id) : undefined,
          onClick: () => { onToggle(item.id) },
        },
          h('span', { className: 'dshmemory-rowTop' },
            h(IconChevron, { open: expanded, className: 'dshmemory-chevron' }),
            h('span', { className: 'dshmemory-rowTitle' }, item.title || t('memory.untitled')),
            item.status === 'archived' ? h(Badge, { tone: 'outline' }, t('memory.status.archived')) : null,
          ),
          h('span', { className: 'dshmemory-rowSummary' }, item.summary || t('memory.noSummary')),
          h('span', { className: 'dshmemory-rowBadges' },
            h(Badge, { tone: KIND_TONES[item.kind] || 'neutral' }, enumLabel('kind.', item.kind, MEMORY_KINDS, t)),
            h(Badge, { tone: item.scope === 'project' ? 'info' : 'neutral' }, scopeText(item, t)),
            h(Badge, { tone: 'outline' }, t('memory.importance', { importance: item.importance })),
          ),
          h('span', { className: 'dshmemory-rowMeta' },
            t('memory.updated', { time: timestamp }),
            ' · ',
            origin,
          ),
        ),
        h('button', {
          type: 'button',
          className: 'dshmemory-pinBtn',
          'data-pinned': item.pinned === true ? 'true' : 'false',
          'aria-label': item.pinned ? t('memory.unpin') : t('memory.pin'),
          title: item.pinned ? t('memory.unpin') : t('memory.pin'),
          disabled: busy,
          onClick: () => { onTogglePin(item) },
        }, h(IconStar, { filled: item.pinned })),
      )
    }

    function formFromRecord(record) {
      return {
        title: record.title,
        summary: record.summary,
        content: record.content,
        kind: record.kind,
        scope: record.scope,
        projectKey: record.project === null ? '' : record.project.key,
        importance: String(record.importance),
        pinned: record.pinned === true,
        tags: record.tags.join(', '),
        status: record.status,
      }
    }

    function parseTags(text) {
      return String(text).split(/[,，]/u).map(tag => tag.trim()).filter(tag => tag !== '')
    }

    function MemoryDetail({ item, projects, t, pending, onClose, onSave, onDelete }) {
      const [record, setRecord] = useState(null)
      const [loadState, setLoadState] = useState('loading')
      const [loadError, setLoadError] = useState('')
      const [form, setForm] = useState(null)
      const [formError, setFormError] = useState('')
      const [deleteArmed, setDeleteArmed] = useState(false)
      const seqRef = useRef(0)
      const tRef = useRef(t)
      tRef.current = t
      const fieldBase = useId()
      const busy = pending !== null
      const saving = pending === 'update:' + item.id
      const deleting = pending === 'delete:' + item.id

      const load = useCallback(async () => {
        const ticket = ++seqRef.current
        setLoadState('loading')
        setLoadError('')
        try {
          const value = await fetchMemory(item.id, item.projectKey)
          if (ticket !== seqRef.current) return
          const next = normalizeMemory(value)
          if (next === null) throw requestError('request-failed', tRef.current('error.payload'))
          setRecord(next)
          setForm(formFromRecord(next))
          setLoadState('ready')
        } catch (cause) {
          if (ticket !== seqRef.current) return
          setLoadError(tRef.current('editor.loadError', { message: failureText(cause, tRef.current) }))
          setLoadState('error')
        }
      }, [item.id, item.projectKey])

      useEffect(() => {
        void load()
        return () => { seqRef.current += 1 }
      }, [load])
      useEffect(() => {
        if (!deleteArmed) return undefined
        const timer = window.setTimeout(() => { setDeleteArmed(false) }, 6000)
        return () => { window.clearTimeout(timer) }
      }, [deleteArmed])

      const projectOptions = useMemo(
        () => mergeProjects(projects, item.project, record === null ? null : record.project),
        [projects, item.project, record])
      const updateField = (key, value) => {
        setForm(current => (current === null ? current : Object.assign({}, current, { [key]: value })))
        setFormError('')
      }
      const submit = async () => {
        if (form === null) return
        const title = form.title.trim()
        const content = form.content.trim()
        if (title === '' || content === '') return setFormError(t('editor.required'))
        const project = form.scope === 'project' ? projectOptions.find(option => option.key === form.projectKey) : undefined
        if (form.scope === 'project' && project === undefined) return setFormError(t('editor.projectRequired'))
        const payload = {
          id: item.id, title, summary: form.summary.trim(), content, kind: form.kind, scope: form.scope,
          importance: Number(form.importance), tags: parseTags(form.tags), pinned: form.pinned === true, status: form.status,
          projectKey: item.projectKey || (item.project === null ? '' : item.project.key),
        }
        if (project !== undefined) payload.project = { key: project.key, name: project.name }
        setFormError('')
        const result = await onSave(payload)
        if (!result.ok) setFormError(t('editor.actionError', { message: result.message }))
      }
      const remove = async () => {
        if (!deleteArmed) {
          setDeleteArmed(true)
          return
        }
        setDeleteArmed(false)
        const result = await onDelete(item)
        if (!result.ok) setFormError(t('editor.actionError', { message: result.message }))
      }

      const fieldId = suffix => fieldBase + '-' + suffix
      const kindOptions = MEMORY_KINDS.map(kind => ({ value: kind, label: t('kind.' + kind) }))
      const scopeOptions = MEMORY_SCOPES.map(scope => ({ value: scope, label: t('scope.' + scope) }))
      const statusOptions = MEMORY_STATUSES.map(status => ({ value: status, label: t('memory.status.' + status) }))
      const importanceOptions = [1, 2, 3, 4, 5].map(value => ({ value: String(value), label: String(value) }))
      const projectSelectOptions = projectOptions.map(project => ({ value: project.key, label: project.name }))
      if (form !== null && !projectSelectOptions.some(option => option.value === form.projectKey)) {
        projectSelectOptions.unshift({ value: '', label: t('editor.projectNone') })
      }
      const control = (suffix, label, value, extra) => h(TextField, Object.assign({
        id: fieldId(suffix), label: t(label), value, disabled: busy,
        onChange: next => { updateField(suffix, next) },
      }, extra))
      const pick = (suffix, label, value, options) => h(SelectField, {
        id: fieldId(suffix), label: t(label), value, options, disabled: busy,
        onChange: next => { updateField(suffix, next) },
      })

      const source = item.source
      const sessionText = source.sessionTitle !== ''
        ? source.sessionTitle
        : (source.sessionId !== '' ? shortId(source.sessionId) : t('editor.sourceUnknown'))
      const metaRows = [
        { key: 'id', label: t('editor.id'), value: item.id, mono: true },
        { key: 'memoryDir', label: t('editor.memoryDir'), value: item.memoryDir || '—', mono: true },
        ...(item.file === '' ? [] : [{ key: 'file', label: t('editor.file'), value: item.file, mono: true }]),
        { key: 'revision', label: t('editor.revision'), value: String(item.revision) },
        { key: 'source', label: t('editor.source'), value: enumLabel('origin.', source.origin, MEMORY_ORIGINS, t) },
        { key: 'session', label: t('editor.session'), value: sessionText },
        { key: 'model', label: t('editor.model'), value: source.model || t('editor.sourceUnknown') },
        { key: 'created', label: t('editor.created'), value: formatDateTime(item.createdAt) || '—' },
        { key: 'updated', label: t('editor.updated'), value: formatDateTime(item.updatedAt) || '—' },
      ]
      const retryBanner = () => h('div', { className: 'dshmemory-banner', 'data-kind': 'error', role: 'alert' },
        h(IconAlert, { className: 'dshmemory-bannerIcon' }),
        h('span', { className: 'dshmemory-bannerText' }, loadError),
        h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => { void load() } }, t('common.retry')))
      const body = form === null
        ? (loadState === 'loading'
          ? h('p', { className: 'dshmemory-status', role: 'status' }, h(Spinner), t('editor.loading'))
          : retryBanner())
        : h(Fragment, null,
          loadState === 'error' && loadError !== '' ? retryBanner() : null,
          h('div', { className: 'dshmemory-formGrid' },
            control('title', 'editor.field.title', form.title, { maxLength: 120, wide: true }),
            control('summary', 'editor.field.summary', form.summary, { maxLength: 240, wide: true }),
            control('content', 'editor.field.content', form.content, {
              rows: 9, maxLength: 8000, wide: true, textareaClassName: 'dshmemory-textareaBody',
            }),
            pick('kind', 'editor.field.kind', form.kind, kindOptions),
            h(SelectField, {
              id: fieldId('scope'), label: t('editor.field.scope'), value: form.scope,
              options: scopeOptions, disabled: busy,
              onChange: value => {
                setForm(current => {
                  if (current === null) return current
                  const nextProject = value === 'project' && current.projectKey === '' && projectOptions.length > 0
                    ? projectOptions[0].key : current.projectKey
                  return Object.assign({}, current, { scope: value, projectKey: nextProject })
                })
                setFormError('')
              },
            }),
            form.scope === 'project' ? pick('project', 'editor.field.project', form.projectKey, projectSelectOptions) : null,
            pick('importance', 'editor.field.importance', form.importance, importanceOptions),
            pick('status', 'editor.field.status', form.status, statusOptions),
            control('tags', 'editor.field.tags', form.tags, { hint: t('editor.tagsHint') }),
            h('div', { className: 'dshmemory-field' },
              h(CheckboxRow, {
                checked: form.pinned === true, disabled: busy, label: t('editor.pinned'),
                onChange: value => { updateField('pinned', value) },
              }))),
          h('div', { className: 'dshmemory-meta' },
            metaRows.map(row => h('div', { key: row.key, className: 'dshmemory-metaRow' },
              h('span', { className: 'dshmemory-metaKey' }, row.label + ':'),
              h('span', { className: 'dshmemory-metaValue' + (row.mono ? ' dshmemory-mono' : '') }, row.value)))),
          formError === '' ? null : h('p', { className: 'dshmemory-errorText', role: 'alert' }, formError),
          h('div', { className: 'dshmemory-detailActions' },
            h(Button, { variant: 'primary', disabled: busy, onClick: () => { void submit() } },
              saving ? h(Spinner) : null, saving ? t('editor.saving') : t('editor.save')),
            h(Button, { variant: 'outline', disabled: busy, onClick: onClose }, t('common.cancel')),
            h('div', { className: 'dshmemory-actionsEnd' },
              h(Button, {
                variant: deleteArmed ? 'danger' : 'dangerText', disabled: busy || loadState !== 'ready',
                onClick: () => { void remove() },
              }, deleting ? h(Spinner) : null,
                deleteArmed ? t('editor.confirmDelete') : (deleting ? t('common.working') : t('editor.delete'))))))

      return h('div', { className: 'dshmemory-detail' },
        h('div', { className: 'dshmemory-detailHead' },
          h('h4', { className: 'dshmemory-detailTitle' }, t('editor.title')),
          h('div', { className: 'dshmemory-detailStatus' },
            h(Badge, { tone: item.status === 'archived' ? 'outline' : 'success' }, t('memory.status.' + item.status)),
            h('button', {
              type: 'button', className: 'dshmemory-iconBtn', 'aria-label': t('common.cancel'),
              disabled: busy, onClick: onClose,
            }, h('span', { className: 'dshmemory-glyph', 'aria-hidden': 'true' }, '×')))),
        body)
    }
    /* ------------------------- Add memory form ------------------------- */

    function AddMemoryForm({ projects, t, pending, onCancel, onCreate }) {
      const fieldBase = useId()
      const [form, setForm] = useState({
        title: '', content: '', kind: 'reference', scope: 'global',
        projectKey: projects.length > 0 ? projects[0].key : '',
        importance: '3', tags: '', pinned: false,
      })
      const [formError, setFormError] = useState('')
      const busy = pending !== null
      const creating = pending === 'create'
      const fieldId = suffix => fieldBase + '-' + suffix
      const updateField = (key, value) => {
        setForm(current => Object.assign({}, current, { [key]: value }))
        setFormError('')
      }
      const control = (suffix, label, value, extra) => h(TextField, Object.assign({
        id: fieldId(suffix), label: t(label), value, disabled: busy,
        onChange: next => { updateField(suffix, next) },
      }, extra))
      const pick = (suffix, label, value, options) => h(SelectField, {
        id: fieldId(suffix), label: t(label), value, options, disabled: busy,
        onChange: next => { updateField(suffix, next) },
      })
      const kindOptions = MEMORY_KINDS.map(kind => ({ value: kind, label: t('kind.' + kind) }))
      const kindSelect = MEMORY_SCOPES.map(scope => ({ value: scope, label: t('scope.' + scope) }))
      const importanceOptions = [1, 2, 3, 4, 5].map(value => ({ value: String(value), label: String(value) }))
      const projectOptions = projects.map(project => ({ value: project.key, label: project.name }))
      if (form.scope === 'project' && !projectOptions.some(option => option.value === form.projectKey)) {
        projectOptions.unshift({ value: '', label: t('editor.projectNone') })
      }
      const submit = async () => {
        const title = form.title.trim()
        const content = form.content.trim()
        if (title === '' || content === '') return setFormError(t('editor.required'))
        const project = form.scope === 'project' ? projects.find(option => option.key === form.projectKey) : undefined
        if (form.scope === 'project' && project === undefined) return setFormError(t('editor.projectRequired'))
        const payload = {
          title, content, kind: form.kind, scope: form.scope, importance: Number(form.importance),
          tags: parseTags(form.tags), pinned: form.pinned === true,
        }
        if (project !== undefined) payload.project = { key: project.key, name: project.name }
        setFormError('')
        const result = await onCreate(payload)
        if (!result.ok) setFormError(t('editor.actionError', { message: result.message }))
      }
      return h('div', { className: 'dshmemory-addPanel' },
        h('div', { className: 'dshmemory-cardHead' },
          h('h3', { className: 'dshmemory-cardTitle' }, t('add.title')),
          h('p', { className: 'dshmemory-cardDesc' }, t('add.desc'))),
        h('div', { className: 'dshmemory-formGrid' },
          control('title', 'editor.field.title', form.title, { maxLength: 120, wide: true }),
          control('content', 'editor.field.content', form.content, { rows: 6, maxLength: 8000, wide: true }),
          pick('kind', 'editor.field.kind', form.kind, kindOptions),
          h(SelectField, {
            id: fieldId('scope'), label: t('editor.field.scope'), value: form.scope,
            options: kindSelect, disabled: busy,
            onChange: value => {
              setForm(current => Object.assign({}, current, {
                scope: value,
                projectKey: value === 'project' && current.projectKey === '' && projects.length > 0
                  ? projects[0].key : current.projectKey,
              }))
              setFormError('')
            },
          }),
          form.scope === 'project' ? pick('project', 'editor.field.project', form.projectKey, projectOptions) : null,
          pick('importance', 'editor.field.importance', form.importance, importanceOptions),
          control('tags', 'editor.field.tags', form.tags, { hint: t('editor.tagsHint') }),
          h('div', { className: 'dshmemory-field' },
            h(CheckboxRow, {
              checked: form.pinned === true, disabled: busy, label: t('editor.pinned'),
              onChange: value => { updateField('pinned', value) },
            }))),
        formError === '' ? null : h('p', { className: 'dshmemory-errorText', role: 'alert' }, formError),
        h('div', { className: 'dshmemory-detailActions' },
          h(Button, { variant: 'primary', disabled: busy, onClick: () => { void submit() } },
            creating ? h(Spinner) : null, creating ? t('add.busy') : t('add.submit')),
          h(Button, { variant: 'outline', disabled: busy, onClick: onCancel }, t('common.cancel'))))
    }
    /* ------------------------- Session tools ------------------------- */

    function SessionTools({ sessions, selectedId, onSelect, result, t, pending, onExtract, onToggleOptOut }) {
      const selectId = useId()
      const busy = pending !== null
      const empty = sessions.length === 0
      const selected = sessions.find(session => session.sessionId === selectedId) || null
      const optionLabel = session => {
        const tags = [sessionStatusOf(session, t)]
        if (session.optedOut) tags.push(t('session.optedOut'))
        return sessionTitleOf(session, t) + ' · ' + tags.join(' · ')
      }
      return h(Card, { title: t('session.title'), desc: t('session.desc') },
        h('div', { className: 'dshmemory-sessionControls' },
          h('div', { className: 'dshmemory-field dshmemory-sessionSelect' },
            h('label', { className: 'dshmemory-fieldLabel', htmlFor: selectId }, t('session.select')),
            h(SelectInput, {
              id: selectId, value: selectedId, disabled: busy || empty, onChange: onSelect,
              options: empty
                ? [{ value: '', label: t('session.noneShort') }]
                : sessions.map(item => ({ value: item.sessionId, label: optionLabel(item) })),
            })),
          h(Button, { variant: 'primary', disabled: busy || selected === null, onClick: () => { void onExtract() } },
            pending === 'extract' ? h(Spinner) : null,
            pending === 'extract' ? t('session.extracting') : t('session.extract')),
          h(Button, { variant: 'outline', disabled: busy || selected === null, onClick: () => { void onToggleOptOut() } },
            selected !== null && selected.optedOut ? t('session.optIn') : t('session.optOut'))),
        empty ? h('p', { className: 'dshmemory-emptyText' }, t('session.none')) : null,
        selected !== null && selected.optedOut ? h(Badge, { tone: 'outline' }, t('session.optedOut')) : null,
        result === null ? null : h('div', { className: 'dshmemory-result', 'data-status': result.status },
          h('div', { className: 'dshmemory-resultHead' },
            h('span', { className: 'dshmemory-resultTitle' }, t('session.lastResult')),
            h(Badge, { tone: STATUS_TONES[result.status] || 'neutral' }, t('activity.status.' + result.status))),
          h('p', { className: 'dshmemory-resultLine' },
            t('session.resultLine', { created: result.created, updated: result.updated, skipped: result.skipped })),
          result.reason === '' ? null : h('p', { className: 'dshmemory-resultDetail' }, t('session.reason', { reason: result.reason })),
          result.model === '' ? null : h('p', { className: 'dshmemory-resultDetail' }, t('session.model', { model: result.model }))),
      )
    }
    /* ------------------------- Advanced settings disclosure ------------------------- */

    function draftFromSettings(settings) {
      const draft = {}
      for (const key of ADVANCED_BOOLEANS) draft[key] = settings[key] === true
      for (const field of ADVANCED_NUMBERS) {
        draft[field.key] = String(asNumber(settings[field.key], field.fallback))
      }
      for (const key of ADVANCED_STRINGS) draft[key] = asString(settings[key])
      return draft
    }

    function buildSettingsPatch(draft, settings, t) {
      const patch = {}
      const errors = {}
      let invalid = false
      for (const key of ADVANCED_BOOLEANS) {
        const value = draft[key] === true
        if (value !== (settings[key] === true)) patch[key] = value
      }
      for (const field of ADVANCED_NUMBERS) {
        const raw = asString(draft[field.key]).trim()
        const value = Number(raw)
        if (raw === '' || !Number.isSafeInteger(value) || value < field.min || value > field.max) {
          errors[field.key] = t('advanced.rangeError', { min: field.min, max: field.max })
          invalid = true
          continue
        }
        if (value !== asNumber(settings[field.key], field.fallback)) patch[field.key] = value
      }
      for (const key of ADVANCED_STRINGS) {
        const value = asString(draft[key]).trim()
        if (value !== asString(settings[key])) patch[key] = value
      }
      return { patch, errors, invalid }
    }

    function AdvancedSettings({ settings, t, pending, onSave }) {
      const signature = settingsSignature(settings)
      const [draft, setDraft] = useState(() => draftFromSettings(settings))
      const [errors, setErrors] = useState({})
      const [localError, setLocalError] = useState('')
      const busy = pending !== null
      const saving = pending === 'settings'
      useEffect(() => {
        setDraft(draftFromSettings(settings))
        setErrors({})
        setLocalError('')
      }, [signature]) // signature covers every server-backed advanced value
      const updateField = (key, value) => {
        setDraft(current => Object.assign({}, current, { [key]: value }))
        setErrors(current => {
          if (!Object.prototype.hasOwnProperty.call(current, key)) return current
          const next = Object.assign({}, current)
          delete next[key]
          return next
        })
        setLocalError('')
      }
      const submit = async () => {
        const result = buildSettingsPatch(draft, settings, t)
        setErrors(result.errors)
        if (result.invalid) return setLocalError(t('advanced.invalid'))
        if (Object.keys(result.patch).length === 0) return setLocalError(t('advanced.noChanges'))
        setLocalError('')
        const response = await onSave(result.patch)
        if (!response.ok) setLocalError(t('editor.actionError', { message: response.message }))
      }
      return h('details', { className: 'dshmemory-details' },
        h('summary', null,
          h(IconChevron, { open: false, className: 'dshmemory-chevron' }),
          h('span', { className: 'dshmemory-summaryText' },
            h('span', { className: 'dshmemory-cardTitle' }, t('advanced.title')),
            h('span', { className: 'dshmemory-cardDesc' }, t('advanced.desc')))),
        h('div', { className: 'dshmemory-detailsBody' },
          h('div', { className: 'dshmemory-toggleGrid' },
            ADVANCED_BOOLEANS.map(key => h(CheckboxRow, {
              key, checked: draft[key] === true, disabled: busy,
              label: t('advanced.' + key), hint: t('advanced.' + key + '.hint'),
              onChange: value => { updateField(key, value) },
            }))),
          h('div', { className: 'dshmemory-formGrid' },
            ADVANCED_NUMBERS.map(field => h(TextField, {
              key: field.key, id: 'dshmemory-advanced-' + field.key, type: 'number',
              label: t('advanced.' + field.key), hint: t('advanced.' + field.key + '.hint'),
              error: errors[field.key], value: draft[field.key],
              min: field.min, max: field.max, step: 1, disabled: busy,
              onChange: value => { updateField(field.key, value) },
            }))),
          h('div', { className: 'dshmemory-formGrid' },
            ADVANCED_STRINGS.map(key => h(TextField, {
              key, id: 'dshmemory-advanced-' + key, label: t('advanced.' + key),
              hint: t('advanced.' + key + '.hint'), value: draft[key],
              maxLength: 120, disabled: busy,
              onChange: value => { updateField(key, value) },
            }))),
          localError === '' ? null : h('p', { className: 'dshmemory-errorText', role: 'alert' }, localError),
          h('div', { className: 'dshmemory-settingsActions' },
            h(Button, { variant: 'primary', disabled: busy, onClick: () => { void submit() } },
              saving ? h(Spinner) : null, saving ? t('advanced.saving') : t('advanced.save')))),
      )
    }
    /* ------------------------- Backup & cleanup ------------------------- */

    function DataTools({ t, pending, total, onExport, onClear }) {
      const [clearOpen, setClearOpen] = useState(false)
      const [confirmation, setConfirmation] = useState('')
      const busy = pending !== null
      const exporting = pending === 'export'
      const clearing = pending === 'clear'
      const confirmReady = confirmation.trim() === 'DELETE'
      const clear = async () => {
        if (!confirmReady) return
        const result = await onClear()
        if (result.ok) {
          setClearOpen(false)
          setConfirmation('')
        }
      }
      return h(Card, { title: t('data.title'), desc: t('data.desc') },
        h('div', { className: 'dshmemory-dataRow' },
          h('div', { className: 'dshmemory-dataCopy' },
            h('span', { className: 'dshmemory-dataTitle' }, t('export.title')),
            h('p', { className: 'dshmemory-dataDesc' }, t('export.desc'))),
          h(Button, { variant: 'outline', disabled: busy, onClick: () => { void onExport() } },
            exporting ? h(Spinner) : h('span', { className: 'dshmemory-glyph', 'aria-hidden': 'true' }, '↓'),
            exporting ? t('export.working') : t('export.button'))),
        h('div', { className: 'dshmemory-dataRow' },
          h('div', { className: 'dshmemory-dataCopy' },
            h('span', { className: 'dshmemory-dataTitle' }, t('clear.title')),
            h('p', { className: 'dshmemory-dataDesc' }, t('clear.desc'))),
          h(Button, {
            variant: 'dangerText', disabled: busy || total === 0,
            ariaLabel: clearOpen ? t('common.cancel') : t('clear.button'),
            onClick: () => { setClearOpen(current => !current); setConfirmation('') },
          }, clearOpen ? t('common.cancel') : t('clear.button'))),
        clearOpen === false ? null : h('div', { className: 'dshmemory-confirmPanel' },
          h('div', { className: 'dshmemory-confirmControls' },
            h(TextField, {
              id: 'dshmemory-clear-confirm', label: t('clear.label'), value: confirmation,
              placeholder: t('clear.placeholder'), disabled: clearing, onChange: setConfirmation,
            }),
            h(Button, { variant: 'danger', disabled: busy || !confirmReady, onClick: () => { void clear() } },
              clearing ? h(Spinner) : null, clearing ? t('clear.busy') : t('clear.button')))),
      )
    }
    /* ------------------------- Recent activity ------------------------- */

    function ActivityList({ entries, t }) {
      const visible = entries.slice(0, 20)
      return h(Card, { title: t('activity.title'), desc: t('activity.desc') },
        visible.length === 0
          ? h('p', { className: 'dshmemory-emptyText' }, t('activity.empty'))
          : h('ul', { className: 'dshmemory-activity' },
            visible.map((entry, index) => {
              const counts = entry.skipped > 0
                ? t('activity.countsSkipped', { created: entry.created, updated: entry.updated, skipped: entry.skipped })
                : t('activity.counts', { created: entry.created, updated: entry.updated })
              const sessionText = entry.sessionTitle !== '' ? entry.sessionTitle : shortId(entry.sessionId)
              return h('li', { key: entry.at + ':' + index, className: 'dshmemory-activityItem' },
                h('div', { className: 'dshmemory-activityTop' },
                  h('span', { className: 'dshmemory-activityTime' }, formatDateTime(entry.at) || entry.at),
                  h(Badge, { tone: STATUS_TONES[entry.status] || 'neutral' }, t('activity.status.' + entry.status)),
                  h('span', null, enumLabel('activity.trigger.', entry.trigger, ACTIVITY_TRIGGERS, t)),
                  entry.durationMs === null ? null : h('span', null, t('activity.duration', { ms: entry.durationMs }))),
                h('div', { className: 'dshmemory-activityCounts' }, counts),
                entry.reason === '' ? null : h('div', {
                  className: 'dshmemory-activityReason', title: entry.reason,
                }, t('activity.reason', { reason: truncate(entry.reason, 160) })),
                sessionText === '' ? null : h('div', { className: 'dshmemory-activitySession' },
                  t('activity.session', { title: sessionText })))
            })),
      )
    }
    /* ------------------------- Empty states ------------------------- */

    function MemoryEmptyState({ t, onCreate }) {
      return h('div', { className: 'dshmemory-empty' },
        h('h3', { className: 'dshmemory-emptyTitle' }, t('memory.emptyTitle')),
        h('p', { className: 'dshmemory-emptyText' }, t('memory.emptyBody')),
        h('p', { className: 'dshmemory-emptyText' }, t('memory.emptyBodyAdd')),
        h('div', { className: 'dshmemory-emptyActions' },
          h(Button, { variant: 'primary', onClick: onCreate }, t('memory.emptyAdd'))))
    }

    function NoMatchesState({ t, onClearFilters }) {
      return h('div', { className: 'dshmemory-empty' },
        h('h3', { className: 'dshmemory-emptyTitle' }, t('memory.noMatchesTitle')),
        h('p', { className: 'dshmemory-emptyText' }, t('memory.noMatchesBody')),
        h('div', { className: 'dshmemory-emptyActions' },
          h(Button, { variant: 'outline', onClick: onClearFilters }, t('toolbar.clearFilters'))))
    }
    /* ------------------------- Settings section ------------------------- */

    function MemorySettingsSection(props) {
      const t = translateOf(props)
      const tRef = useRef(t)
      tRef.current = t
      const [data, setData] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [loadError, setLoadError] = useState('')
      const [refreshing, setRefreshing] = useState(false)
      const [notice, setNotice] = useState(null)
      const [pending, setPending] = useState(null)
      const [filters, setFilters] = useState(Object.assign({}, DEFAULT_FILTERS))
      const [expandedId, setExpandedId] = useState('')
      const [addOpen, setAddOpen] = useState(false)
      const [selectedSessionId, setSelectedSessionId] = useState('')
      const [extractResult, setExtractResult] = useState(null)
      const pendingRef = useRef(null)
      const seqRef = useRef(0)
      const selectedSessionRef = useRef('')
      selectedSessionRef.current = selectedSessionId
      const busy = pending !== null

      const load = useCallback(async () => {
        const ticket = ++seqRef.current
        setRefreshing(true)
        setPhase(previous => (previous === 'ready' ? 'ready' : 'loading'))
        try {
          const value = await fetchState(selectedSessionRef.current || undefined)
          if (ticket !== seqRef.current) return null
          const next = normalizeState(value)
          if (next === null) throw requestError('request-failed', tRef.current('error.payload'))
          setData(next)
          setPhase('ready')
          setLoadError('')
          return next
        } catch (cause) {
          if (ticket !== seqRef.current) return null
          setLoadError(tRef.current('error.load', { message: failureText(cause, tRef.current) }))
          setPhase(previous => (previous === 'ready' ? 'ready' : 'error'))
          return null
        } finally {
          if (ticket === seqRef.current) setRefreshing(false)
        }
      }, [])

      useEffect(() => {
        void load()
        return () => { seqRef.current += 1 }
      }, [load])
      useEffect(() => {
        if (notice === null) return undefined
        const timer = window.setTimeout(() => { setNotice(null) }, notice.kind === 'error' ? 9000 : 4500)
        return () => { window.clearTimeout(timer) }
      }, [notice])
      useEffect(() => {
        if (data === null) return
        setSelectedSessionId(current => {
          if (current !== '' && data.liveSessions.some(session => session.sessionId === current)) return current
          return data.liveSessions.length > 0 ? data.liveSessions[0].sessionId : ''
        })
      }, [data])
      useEffect(() => {
        if (data === null || expandedId === '') return
        if (!data.memories.some(memory => memory.id === expandedId)) setExpandedId('')
      }, [data, expandedId])
      useEffect(() => { setExtractResult(null) }, [selectedSessionId])

      const notify = useCallback((kind, text) => { setNotice({ kind, text }) }, [])
      const runMutation = useCallback(async (key, action, payload, options) => {
        if (pendingRef.current !== null) return { ok: false, message: tRef.current('common.working') }
        pendingRef.current = key
        setPending(key)
        const settings = options === undefined ? {} : options
        const sessionId = settings.sessionId === undefined ? selectedSessionRef.current : settings.sessionId
        const body = Object.assign({}, payload)
        if (typeof sessionId === 'string' && sessionId !== '') body.sessionId = sessionId
        try {
          const value = await postAction(action, body)
          if (settings.refetch !== false) await load()
          return { ok: true, value }
        } catch (cause) {
          const message = failureText(cause, tRef.current)
          setNotice({ kind: 'error', text: tRef.current('error.action', { message }) })
          return { ok: false, message }
        } finally {
          pendingRef.current = null
          setPending(null)
        }
      }, [load])

      const setFilter = useCallback((key, value) => {
        setFilters(current => {
          const next = Object.assign({}, current, { [key]: value })
          if (key === 'scope' && value === 'global') next.projectKey = ''
          if (key === 'projectKey' && value !== '') next.scope = 'project'
          return next
        })
      }, [])
      const clearFilters = useCallback(() => { setFilters(Object.assign({}, DEFAULT_FILTERS)) }, [])

      const toggleEnabled = async () => {
        if (data === null) return
        const pausedNow = data.stats.paused === true || data.settings.enabled === false
        const result = await runMutation('enabled', pausedNow ? 'resume' : 'pause', {})
        if (result.ok) notify('success', pausedNow ? t('notice.resumed') : t('notice.paused'))
      }
      const togglePin = async item => {
        const next = item.pinned !== true
        const title = item.title || t('memory.untitled')
        const result = await runMutation('pin:' + item.id, next ? 'pin' : 'unpin', { id: item.id, projectKey: item.projectKey || (item.project === null ? '' : item.project.key) })
        if (result.ok) notify('success', t(next ? 'notice.pinned' : 'notice.unpinned', { title }))
      }
      const saveMemory = async payload => {
        const result = await runMutation('update:' + payload.id, 'update', payload)
        if (result.ok) notify('success', t('notice.updated', { title: payload.title || t('memory.untitled') }))
        return result
      }
      const deleteMemory = async item => {
        const result = await runMutation('delete:' + item.id, 'delete', { id: item.id, projectKey: item.projectKey || (item.project === null ? '' : item.project.key) })
        if (result.ok) {
          setExpandedId(current => (current === item.id ? '' : current))
          notify('success', t('notice.deleted', { title: item.title || t('memory.untitled') }))
        }
        return result
      }
      const createMemory = async payload => {
        const result = await runMutation('create', 'create', payload)
        if (result.ok) {
          setFilters(Object.assign({}, DEFAULT_FILTERS))
          setAddOpen(false)
          const record = isObject(result.value) && isObject(result.value.record) ? result.value.record : null
          setExpandedId(record !== null && typeof record.id === 'string' ? record.id : '')
          notify('success', t('notice.created', { title: payload.title || t('memory.untitled') }))
        }
        return result
      }
      const extractNow = async () => {
        if (data === null || selectedSessionId === '') return
        const session = data.liveSessions.find(item => item.sessionId === selectedSessionId)
        if (session === undefined) return
        const result = await runMutation('extract', 'extractNow', {}, { sessionId: session.sessionId })
        if (!result.ok) return
        const value = normalizeExtractResult(isObject(result.value) ? result.value.result : null)
        setExtractResult(value)
        const reason = value.reason || t('session.noReason')
        if (value.status === 'ok') {
          notify('success', t('notice.extracted', { created: value.created, updated: value.updated, skipped: value.skipped }))
        } else {
          notify(value.status === 'skipped' ? 'success' : 'error',
            t(value.status === 'skipped' ? 'notice.extractSkipped' : 'notice.extractFailed', { reason }))
        }
      }
      const toggleOptOut = async () => {
        if (data === null || selectedSessionId === '') return
        const session = data.liveSessions.find(item => item.sessionId === selectedSessionId)
        if (session === undefined) return
        const value = session.optedOut !== true
        const result = await runMutation('optout', 'setSessionOptOut',
          { sessionId: session.sessionId, value }, { sessionId: session.sessionId })
        if (result.ok) notify('success', value ? t('notice.optedOut') : t('notice.optedIn'))
      }
      const exportMemories = async () => {
        const result = await runMutation('export', 'export', {}, { refetch: false })
        if (!result.ok) return
        try {
          if (!isObject(result.value)) throw new Error(t('error.payload'))
          downloadJson(`dsh-memory-export-${formatDateStamp(new Date())}.json`, result.value)
          notify('success', t('notice.exported'))
        } catch (cause) {
          setNotice({ kind: 'error', text: t('error.export', { message: messageOf(cause) }) })
        }
      }
      const clearMemories = async () => {
        const result = await runMutation('clear', 'clear', { confirm: true })
        if (result.ok) {
          const count = isObject(result.value) ? Math.max(0, Math.round(asNumber(result.value.count, 0))) : 0
          setExpandedId('')
          setAddOpen(false)
          setExtractResult(null)
          notify('success', t('notice.cleared', { count }))
        }
        return result
      }
      const saveSettings = async patch => {
        const result = await runMutation('settings', 'setSettings', { settings: patch })
        if (result.ok) notify('success', t('notice.settingsSaved'))
        return result
      }
      const toggleExpanded = id => { setExpandedId(current => (current === id ? '' : id)) }
      const retry = () => {
        if (data === null) setPhase('loading')
        void load()
      }

      const filteredMemories = useMemo(() => {
        if (data === null) return []
        const needle = filters.query.trim().toLowerCase()
        return data.memories.filter(item => {
          if (filters.scope !== 'all' && item.scope !== filters.scope) return false
          if (filters.projectKey !== '' && (item.project === null || item.project.key !== filters.projectKey)) return false
          if (filters.kind !== 'all' && item.kind !== filters.kind) return false
          if (filters.status !== 'all' && item.status !== filters.status) return false
          if (needle === '') return true
          return [item.title, item.summary, item.tags.join(' '), item.kind, item.scope, item.status,
            enumLabel('kind.', item.kind, MEMORY_KINDS, t), scopeText(item, t),
            enumLabel('memory.status.', item.status, MEMORY_STATUSES, t), item.projectLabel]
            .join(' ').toLowerCase().indexOf(needle) !== -1
        })
      }, [data, filters, t])

      const paused = data !== null && (data.stats.paused === true || data.settings.enabled === false)
      const showSkeleton = data === null && phase === 'loading'
      const failedWithoutData = data === null && phase === 'error'
      const statsText = data === null
        ? (phase === 'error' ? '' : t('common.loading'))
        : t('status.line', {
          total: data.stats.total, active: data.stats.active, archived: data.stats.archived,
          global: data.stats.global, project: data.stats.project, pinned: data.stats.pinned,
          projects: data.stats.projectCount,
        })
      const lastUpdated = data === null || data.stats.lastUpdatedAt === ''
        ? (data === null ? '' : t('status.never'))
        : (formatDateTime(data.stats.lastUpdatedAt) || '—')
      const list = data === null ? null : h(Fragment, null,
        h(MemoryToolbar, {
          t, filters, projects: data.projects, busy, refreshing,
          onFilter: setFilter, onClearFilters: clearFilters,
          onRefresh: () => { void load() }, onCreate: () => { setAddOpen(true) },
        }),
        addOpen ? h(AddMemoryForm, {
          projects: data.projects, t, pending,
          onCancel: () => { setAddOpen(false) }, onCreate: createMemory,
        }) : null,
        h('section', { className: 'dshmemory-block' },
          h('div', { className: 'dshmemory-blockHead' },
            h('h3', { className: 'dshmemory-blockTitle' }, t('memory.title')),
            h('span', { className: 'dshmemory-blockCount' },
              t('memory.count', { shown: filteredMemories.length, total: data.stats.total }))),
          data.memories.length === 0
            ? h(MemoryEmptyState, { t, onCreate: () => { setAddOpen(true) } })
            : (filteredMemories.length === 0
              ? h(NoMatchesState, { t, onClearFilters: clearFilters })
              : h('ul', { className: 'dshmemory-list' },
                filteredMemories.map(item => {
                  const expanded = expandedId === item.id
                  return h('li', {
                    key: item.id, className: 'dshmemory-item', 'data-expanded': expanded ? 'true' : 'false',
                  },
                    h(MemoryRow, {
                      item, t, expanded, busy, onToggle: toggleExpanded,
                      onTogglePin: row => { void togglePin(row) },
                    }),
                    expanded ? h('div', { id: detailElementId(item.id) },
                      h(MemoryDetail, {
                        item, projects: data.projects, t, pending,
                        onClose: () => { setExpandedId('') }, onSave: saveMemory, onDelete: deleteMemory,
                      })) : null)
                })))),
        h(SessionTools, {
          sessions: data.liveSessions, selectedId: selectedSessionId, onSelect: setSelectedSessionId,
          result: extractResult, t, pending, onExtract: extractNow, onToggleOptOut: toggleOptOut,
        }),
        h(DataTools, {
          t, pending, total: data.stats.total, onExport: exportMemories, onClear: clearMemories,
        }),
        h(AdvancedSettings, { settings: data.settings, t, pending, onSave: saveSettings }),
        h(ActivityList, { entries: data.activity, t }))

      return h('section', {
        className: 'dshmemory-section',
        'aria-busy': busy || refreshing || showSkeleton ? 'true' : undefined,
      },
        h(StyleElement, { key: 'style' }),
        h('div', { className: 'dshmemory-head' },
          h('div', { className: 'dshmemory-headText' },
            h('h2', { className: 'dshmemory-title' }, t('page.title')),
            h('p', { className: 'dshmemory-intro' }, t('page.intro')),
            data === null || data.memoryRoot === '' ? null : h('p', { className: 'dshmemory-path' },
              t('page.storage', {
                global: data.memoryRoot,
                project: data.session.project === null ? '—' : (data.session.project.memoryDir || data.session.project.key),
              })),
            statsText === '' ? null : h('p', { className: 'dshmemory-stats' },
              statsText, lastUpdated === '' ? '' : ' · ' + t('status.lastUpdated', { time: lastUpdated }))),
          h('div', { className: 'dshmemory-headActions' },
            data === null ? null : h(Button, {
              variant: paused ? 'primary' : 'outline', disabled: busy || refreshing,
              onClick: () => { void toggleEnabled() },
            }, pending === 'enabled' ? h(Spinner) : null,
              pending === 'enabled' ? t('common.working') : (paused ? t('action.resume') : t('action.pause'))))),
        paused ? h('div', { className: 'dshmemory-banner', 'data-kind': 'warning', role: 'status' },
          h('span', { className: 'dshmemory-bannerText' }, t('paused.badge') + ' — ' + t('paused.hint'))) : null,
        notice === null ? null : h(Notice, { t, notice, onDismiss: () => { setNotice(null) } }),
        loadError === '' ? null : h(ErrorBanner, { t, message: loadError, onRetry: retry, retrying: refreshing }),
        showSkeleton
          ? h(LoadingState, { t })
          : (failedWithoutData || data === null ? null : list))
    }
    /* ------------------------- Plugin registration ------------------------- */

    function apply(ctx) {
      try {
        if (ctx.locale === undefined || ctx.locale === null || typeof ctx.locale.bind !== 'function') {
          throw new Error('locale service is unavailable')
        }
        runtime.translate = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: dictionaries')
      } catch (cause) {
        runtime.translate = null
        try {
          if (typeof ctx.logger?.warn === 'function') {
            ctx.logger.warn('dsh-memory: locale registration failed: ' + messageOf(cause))
          }
        } catch {
          // Logging is best-effort.
        }
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'memory',
        order: SETTINGS_ORDER,
        label: () => translate('nav'),
        locale: NS,
      }, MemorySettingsSection))

      registerCommandFace(ctx)
    }

    /**
     * Give the host `/memory` composer-menu row the same native face as the
     * built-in commands (icon + localized title and description) through the
     * command surface's row-face decoration API. Optional: older harnesses
     * without that API keep the plain catalog row.
     * @param {Record<string, any>} ctx - client root context.
     */
    function registerCommandFace(ctx) {
      const face = () => ({
        name: 'memory',
        label: () => translate('command.label'),
        description: () => translate('command.description'),
        icon: MemoryGlyph,
      })
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['commandUi'], (scoped) => {
            scoped.effect(() => scoped.commandUi.decorateFace(face()), 'dsh-memory: command menu face')
          })
          return
        }
        const commandUi = typeof ctx.get === 'function' ? ctx.get('commandUi') : undefined
        if (commandUi !== undefined && commandUi !== null && typeof commandUi.decorateFace === 'function') {
          ctx.effect(() => commandUi.decorateFace(face()), 'dsh-memory: command menu face')
        }
      } catch (cause) {
        try {
          if (typeof ctx.logger?.warn === 'function') {
            ctx.logger.warn('dsh-memory: command menu face unavailable: ' + messageOf(cause))
          }
        } catch {
          // Logging is best-effort.
        }
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
