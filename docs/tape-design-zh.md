# Tape 设计文档

Tape 模式是一个**基于锚点的会话历史管理系统**，它使用 pi 会话作为数据源，仅在本地维护锚点索引。它提供按需检索的上下文获取能力，配合智能内存文件选择。

## 设计理念
**"按需记忆，智能检索"**

Tape 模式的灵感来源于：
- **LSTM 记忆** - 带检查点门的顺序上下文
- **Git 工作流** - 锚点作为提交，会话作为分支
- **Letta 记忆** - 明确的记忆操作和工具

Tape 模式记录来自 pi 会话的所有交互，并提供基于锚点的按需上下文检索。锚点作为命名检查点，对会话历史进行分段，从而实现高效的选择性检索，而不会在过时上下文中消耗 token。

为兼容 pi TUI，锚点也会在 `/tree` 中镜像为内联标签，附加到具体的会话节点上。在重新同步时，tape 会先清除当前会话树中现有的锚点前缀标签，然后再重建它们，以避免陈旧的锚点标签残留在旧节点上。

### 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                     LLM Agent 层                          │
│  - 使用 tape 工具查询会话历史                             │
│  - 为阶段转换创建锚点                                     │
│  - 决定检索哪些上下文                                     │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                   Tape 服务层                            │
│  - 从 pi 会话文件读取（JSONL）                           │
│  - 维护锚点存储（本地 JSONL）                             │
│  - 提供查询、搜索和上下文选择                             │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                    存储层                                │
│  - 会话条目：pi 会话文件（只读）                          │
│  - 锚点存储：{localPath}/TAPE/                           │
└─────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. 会话读取器（`tape/tape-session-reader.ts`）

直接从 pi 会话文件读取条目：

```typescript
// 会话目录：~/.pi/agent/sessions/--{cwd}--/
// getSessionFilePath() 扫描该目录中的 JSONL 文件并匹配头部 id
getSessionFilePaths(cwd: string): string[]
getSessionFilePath(cwd: string, sessionId: string): string | null
parseSessionFile(filePath: string): { header: SessionHeader; entries: SessionEntry[] } | null
getEntriesAfterTimestamp(entries: SessionEntry[], timestamp: string): SessionEntry[]
```

**条目类型**（来自 pi 会话）：
- `message` - 用户/助手消息
- `custom` - 自定义事件
- `thinking_level_change` - 思考级别变更
- `model_change` - 模型切换
- `compaction` - 会话压缩
- 加上 pi 暴露的任何其他 `SessionEntry` 变体

### 2. 锚点存储（`tape/tape-anchor.ts`）

锚点检查点的本地存储：

```typescript
// 存储位置：{tapePath ?? `${localPath}/TAPE`}/{projectName}__anchors.jsonl
interface TapeAnchor {
  id: string;             // 稳定的锚点 ID
  timestamp: string;      // ISO 时间戳
  name: string;           // 锚点名称（如 "session/new", "session/resume", "task/begin"）
  kind: "session" | "handoff";
  meta?: {
    trigger?: "direct" | "keyword" | "manual";
    keywords?: string[];
    summary?: string;
  };
  sessionId: string;      // 会话 ID
  sessionEntryId: string; // 关联的会话条目 ID
}
```

当前 JSONL 写入顺序为：`id`、`timestamp`、`name`、`kind`、`meta`、`sessionId`、`sessionEntryId`。

**关键方法：**
- `append(entry)` - 添加新锚点到存储
- `findByName(name)` - 按名称查找锚点
- `findBySession(sessionId)` - 获取会话的锚点
- `findBySessionEntryId(sessionEntryId, sessionId?)` - 获取附加到特定会话节点的锚点
- `getLastAnchor(sessionId)` - 获取最近的锚点
- `search({ query, since, until })` - 搜索锚点

### 3. Tape 服务（`tape/tape-service.ts`）

结合会话读取和锚点管理的主服务：

```typescript
class TapeService {
  // 锚点操作
  createAnchor(name: string, kind: "session" | "handoff", meta?: TapeAnchor["meta"], syncTreeLabel?: boolean): TapeAnchor
  recordSessionStart(reason?: "startup" | "reload" | "new" | "resume" | "fork"): TapeAnchor
  deleteAnchor(id: string): TapeAnchor | null
  findAnchorByName(name: string, anchorScope?: "current-session" | "project"): TapeAnchor | null
  getLastAnchor(anchorScope?: "current-session" | "project"): TapeAnchor | null

  // 查询操作（从 pi 会话读取）
  query(options: TapeQueryOptions & { since?: string }): SessionEntry[]
  getInfo(): {
    totalEntries: number;
    anchorCount: number;
    lastAnchor: TapeAnchor | null;
    entriesSinceLastAnchor: number;
  }
}
```

### 4. Tape 选择器（`tape/tape-selector.ts`）

**ConversationSelector**：用于格式化/精简会话条目的辅助工具
- Token 预算过滤（默认：1000 tokens，40 条目）
- 可将选定的会话条目格式化为紧凑的上下文文本
- 作为内部辅助工具存在；当前运行时注入由 `MemoryFileSelector` 驱动

**MemoryFileSelector**：智能选择内存和项目文件
- **智能策略**：在可配置的时间窗口内（`memoryScan`）扫描最近的项目历史，当样本太小时扩展到最大窗口，并使用 handoff 优先加权对文件进行排名
- **recent focus 提取**：在 smart 选中文件之后，从同一个实际生效的 smart 扫描窗口内提取最近的 `read` / `memory_read` / `edit` 行范围；每个文件最多显示 5 段简洁的 `recent focus`
- **关键词 handoff 辅助**：规范化配置的关键词，当用户提示在 `[10, 300]` 字符范围内匹配关键词时，构建隐藏的 handoff 指令
- **仅最近策略**：扫描内存文件并返回最近修改的文件

### 5. Tape 工具（`tape/tape-tools.ts`）

七个向 pi 扩展 API 注册的工具：

## Tape 工具参考

### tape_handoff - 创建锚点检查点

```typescript
tape_handoff(
  name: string,                    // 锚点名称（如 "task/begin", "handoff"）
  summary?: string,                // 可选的摘要
  meta?: Record<string, unknown>   // 可选的元数据（如 trigger 或 keywords）
)
```

**使用时机：**
- 开始新任务或阶段
- 完成里程碑
- 在主要上下文切换之前
- 在重要决策之后

**示例：**
```typescript
// 阶段转换
tape_handoff(name="task/begin", summary="Starting database migration")

// 由隐藏指令授权的关键词 handoff
// 模型只需要提供 name / summary / purpose
tape_handoff(
  name="handoff/keyword-migration",
  summary="Continue the database migration work",
  purpose="migration"
)
```

---

### tape_list - 列出所有锚点

```typescript
tape_list(
  limit?: number,          // 最大锚点数（默认：20，最大：100）
  contextLines?: number    // 前后上下文行数（默认：1）
)
```

**返回：** 带时间戳、种类、元数据和条目上下文的锚点列表

---

### tape_delete - 删除锚点检查点

```typescript
tape_delete(
  id: string   // 来自 tape_list 的锚点 ID
)
```

**适用于：**
- 通过删除底层 tape 锚点来移除镜像的 `/tree` 锚点标签
- 清理过时的 handoff 锚点

---

### tape_info - 获取 Tape 统计信息

```typescript
tape_info()
```

**返回：**
```
📊 Tape 信息：
  总条目数：42
  锚点数：3
  最近锚点：task/begin
  距上次锚点后的条目数：8
```

---

### tape_read - 读取会话历史

```typescript
tape_read({
  afterAnchor?: string,              // 在此锚点之后读取
  lastAnchor?: boolean,              // 在上次锚点之后读取
  betweenAnchors?: { start, end },   // 在两个锚点之间
  betweenDates?: { start, end },     // ISO 日期范围
  query?: string,                    // 文本搜索
  types?: SessionEntry["type"][],    // 按类型过滤
  limit?: number                     // 最大条目数（默认：20）
})
```

**常用模式：**
```typescript
// 上次锚点以来的所有内容
tape_read({ lastAnchor: true })

// 任务开始以来的上下文
tape_read({ afterAnchor: "task/begin" })

// 搜索消息
tape_read({ query: "database schema", limit: 10 })

// 日期范围
tape_read({ betweenDates: { start: "2026-04-01", end: "2026-04-16" } })
```

---

### tape_search - 搜索条目和锚点

```typescript
tape_search({
  kinds?: ("entry" | "anchor" | "all")[],  // 搜索什么
  types?: SessionEntry["type"][],          // 按类型过滤条目
  limit?: number,                           // 最大结果数（默认：20）
  sinceAnchor?: string,                     // 从锚点开始搜索
  lastAnchor?: boolean,                     // 从上次锚点开始搜索
  betweenAnchors?: { start, end },
  betweenDates?: { start, end },
  query?: string                            // 文本搜索
})
```

**示例：**
```typescript
// 查找匹配的锚点
tape_search({ kinds: ["anchor"], query: "bug" })

// 查找内存工具调用
tape_search({ kinds: ["entry"], types: ["custom"], query: "memory" })
```

---

### tape_reset - 重置锚点存储

```typescript
tape_reset(archive?: boolean)  // 归档标志被接受但未实现
```

**行为：** 清除锚点存储，然后立即通过 `recordSessionStart()` 创建一个新的会话生命周期锚点。

---

## 运行时流程

Tape 模式有两个不同的阶段：会话设置和每轮上下文注入。

```
session_start 事件
       ↓
┌──────────────────────────────────────┐
│ 创建/刷新活动的 tape 运行时          │
│ - 初始化 TapeService                  │
│ - 配置会话树标签                      │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ 注册 Tape 工具（一次）                │
│ - tape_handoff, tape_list 等         │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ 创建会话生命周期锚点                   │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ 锚点模型保持活动                       │
│ - session/* 生命周期锚点              │
│ - 通过 tape_handoff 的 handoff 锚点   │
└──────────────────────────────────────┘
```

```
before_agent_start 事件
       ↓
┌──────────────────────────────────────────────┐
│ 为本轮构建注入负载                            │
│ - 选择内存文件（智能/仅最近）                  │
│ - 构建内存索引 + tape 提示                    │
│ - 可选添加隐藏的关键词 handoff 指令            │
│ - 通过 system-prompt 或 message-append 投递   │
└──────────────────────────────────────────────┘
```

**重要提示：** `before_agent_start` 在每个 Agent 轮次运行，而不仅仅在会话启动时运行。
- `message-append`：tape 选择的内存在第一个 Agent 轮次作为隐藏的自定义消息（`pi-memory-md-tape`）注入一次
- `system-prompt`：tape 选择的内存在每个 Agent 轮次重新构建并附加到当前 system prompt
- 关键词触发的 handoff 指令可以作为单独隐藏的自定义消息（`pi-memory-md-tape-keyword`）在后续轮次注入
- 在 pi 中，附加意味着返回 `systemPrompt: event.systemPrompt + "..."`；返回纯字符串将替换该轮次的 prompt

## 内存上下文注入

Tape 模式改变的是**选择哪些内存文件**，而不是投递机制本身。
注入的内容是内存索引/摘要加上 tape 提示。

```typescript
// settings.tape.context
{
  strategy: "smart",           // "smart" 或 "recent-only"
  fileLimit: 10,                // 最大内存文件数
  memoryScan: [72, 168],        // 智能扫描范围：[起始小时数, 最大小时数]
  whitelist: [],                // 始终包含这些文件或目录
  blacklist: [],                // 始终排除这些文件或目录；其他路径仍会先走 rg 忽略规则，再走默认忽略名单
}

// 注入添加：
- 带有描述/标签的内存文件列表
- 内存目录下的文件即使通过绝对路径选择也会获得描述/标签
- 智能模式下检测到 read/edit/write 活动时，会显示最近活跃的项目文件路径
- 为选中的 memory 文件和项目文件附加 `recent focus` 摘要，例如 `recent focus: read 340-420, edit 390-399`
- `recent focus` 在文件选中之后才计算，并且严格限制在产生这些选中文件的同一个实际 smart 扫描窗口内
- 智能模式过滤跳过不再存在于磁盘上的过时 tape 路径的文件
- 当配置的关键词匹配用户提示时，添加隐藏的关键词触发 handoff 指令
- 可选的 `anchor.mode: "manual"` 守卫，阻止直接调用 `tape_handoff`，但关键词命中的隐藏指令和 `/memory-anchor` 仍然可用
- 带有工具使用说明的 tape 提示
```

### 投递行为

| 注入模式 | Tape 行为 |
|----------------|---------------|
| `message-append` | 在第一个 Agent 轮次将 tape 选择的内存作为隐藏的自定义消息（`pi-memory-md-tape`）注入一次 |
| `system-prompt` | 在每个 Agent 轮次重新构建 tape 选择的内存并附加到当前 system prompt |

关键词触发的 handoff 指令与主要内存负载独立，可以在配置关键词匹配时作为 `pi-memory-md-tape-keyword` 在后续投递。

如果 `settings.tape.anchor.mode === "manual"`，主要 tape 提示会告诉 LLM 不要主动创建 `tape_handoff` 锚点，工具层会拒绝直接调用 `tape_handoff`。但关键词触发的隐藏指令和 `/memory-anchor` 仍然可以通过 runtime 绑定授权创建 handoff。

这意味着 tape 影响的是**选择**，而注入模式控制的是**投递频率和位置**。

### Tape 启用规则

只有在以下检查全部通过时，tape runtime 才会启用：
- `settings.tape.enabled !== false`
- 当前 `cwd` 不命中 `settings.tape.excludeDirs` 中的任何绝对路径
- 当前 `cwd` 不命中内建的系统安全排除目录
- 当 `settings.tape.onlyGit !== false` 时，从 `cwd` 向上查找时必须能找到父级 `.git`

如果任一检查失败，则该轮/该次会话启动会完全跳过 tape：不做 tape 注入、不发送 tape 关键词 handoff 消息，也不记录 anchor。

**Tape 提示：**
```
💡 Tape 上下文管理：
您的对话历史记录在带有锚点（检查点）的 tape 中。
- 使用 tape_info 检查当前 tape 状态
- 使用 tape_search 按种类或内容查询历史条目
- 使用 tape_list 列出所有锚点检查点
- 在开始新任务时使用 tape_handoff 创建新锚点/检查点
```

## 配置

```json
{
  "pi-memory-md": {
    "tape": {
      "onlyGit": true,
      "excludeDirs": [
        "/absolute/path/to/sandbox"
      ],
      "context": {
        "strategy": "smart",
        "fileLimit": 10,
        "memoryScan": [72, 168],
        "whitelist": [],
        "blacklist": []
      },
      "anchor": {
        "labelPrefix": "⚓ ",
        "mode": "auto",
        "keywords": {
          "global": [],
          "project": []
        }
      }
    }
  }
}
```

- `onlyGit` 默认是 `true`。启用后，tape 只会在 Git 仓库内运行；否则会跳过 tape 注入和 anchor 记录。
- `excludeDirs` 是一组绝对目录路径。如果当前 `cwd` 等于或位于任一排除目录之下，tape 会被跳过。
- 内建的系统安全排除目录也会默认生效，并与用户自定义的 `excludeDirs` 合并。

### 上下文策略

**智能模式**（默认）：
- 仅统计记录在 tape 历史中的助手端工具调用
- 忽略引用文件不再存在于磁盘上的过时 tape 路径
- 跟踪加权文件活动：
  - `memory_read` => 基础分数 `10`
  - `memory_write` => 基础分数 `16`
  - `read` => 基础分数 `20`
  - `edit` => 基础分数 `28`
  - `write` => 基础分数 `30`
- 重复访问每个文件使用递减收益：
  - 第 1 次访问：`1.0x`
  - 第 2 次访问：`0.6x`
  - 第 3 次访问：`0.35x`
  - 第 4+ 次访问：`0.15x`
- **提升规则**（两个独立提升，如果适用都应用）：
  - 最新的 handoff 锚点（任何触发器）：最高 `+30`
  - 最新的关键词触发的 handoff 锚点：最高 `+40`
- 锚点提升仅在最新匹配锚点后的前 `15` 个 tape 条目内有资格
- 有资格的锚点提升也会按锚点年龄衰减：
  - 6 小时内：`100%`
  - 24 小时内：`60%`
  - 72 小时内：`30%`
  - 72 小时后：`0%`
- 最近奖励从最后访问时间应用：
  - 6 小时内：`+12`
  - 24 小时内：`+8`
  - 72 小时内：`+4`
- 当总访问量大大超过不同工具种类时，重复单文件活动也会受到小额的重复惩罚
- 初始扫描窗口为 `memoryScan[0]` 小时
- 如果该窗口内的助手工具调用总访问量少于 `MIN_SMART_ACCESS_SAMPLES`（硬编码为 `5`），则按 24 小时步进继续扩展，直到达到足够样本或到达 `memoryScan[1]`
- 一旦文件选择停止，`recent focus` 只会从这个同样的实际扫描窗口中提取；不会比文件选择结果看得更久远
- 最终排序：
  1. 最终分数（加权分数 + 最近奖励 - 重复惩罚）
  2. 原始累计分数
  3. 最后访问时间
- 如果没有历史记录则回退到目录扫描

**recent focus 格式化规则：**
- `read` / `memory_read` 范围来自 `offset + limit`
- `edit` 范围来自关联的 edit tool result（`diff` / `firstChangedLine`）
- 同类型且相邻或重叠的范围会合并
- 每个选中文件最多显示 5 段 recent focus，按最近到更早排序

**仅最近模式**：
- 直接扫描内存目录
- 按修改时间排序（最新的在前）
- 返回前 N 个内存文件
- 不包括来自 tape 历史的项目文件路径
- 更快但上下文感知较少

### 锚点类型

| 类型 | 行为 |
|------|------|
| `session` | 由 tape 创建的生命周期锚点（`session/new`、`session/resume`） |
| `handoff` | 通过 `tape_handoff` 和 `/memory-anchor` 创建的阶段转换锚点 |

`settings.tape.anchor.labelPrefix` 自定义镜像锚点标签在 pi `/tree` 中的显示方式（默认：`⚓ `）。

## 使用模式

### 模式 1：任务阶段

```typescript
// 开始新任务
tape_handoff(name="task/auth-api", summary="Implement authentication API")

// ... 进行任务 ...

// 保存检查点
tape_handoff(
  name="auth/api-endpoint",
  summary="Auth API endpoint checkpoint"
)

// 稍后：检索上下文
tape_read({ afterAnchor: "task/auth-api" })
```

### 模式 2：调试会话

```typescript
// 更改前检查点
tape_handoff(name="debug/before-fix", summary="Investigating timeout error")

// ... 尝试修复 ...

// 成功或失败锚点
tape_handoff(name="debug/after-fix", summary="Fixed by increasing timeout")

// 回顾发生了什么
tape_read({ betweenAnchors: { start: "debug/before-fix", end: "debug/after-fix" } })
```

### 模式 3：上下文切换

```typescript
// 保存当前状态
tape_handoff(name="context/save", summary="Saving migration context")

// 切换任务
tape_handoff(name="task/urgent-fix", summary="Hotfix for production")

// ... 修复 bug ...

// 返回上一个任务
tape_read({ afterAnchor: "context/save" })
```

## 最佳实践

### 应该做

✅ **在有意义的转换点创建锚点**
```typescript
tape_handoff(name="phase/design", summary="Moving to implementation")
```

✅ **使用描述性的、分层级的名称**
```typescript
// 好
tape_handoff(name="bug/auth/timeout-fix")
tape_handoff(name="task/api/phase2")

// 不太有用
tape_handoff(name="checkpoint")
```

✅ **在锚点中存储相关的元数据以帮助检索**
```typescript
tape_handoff(
  name="migration/checkpoint",
  summary="Users table migration checkpoint",
  purpose="migration"
)
```

✅ **使用有针对性的查询**
```typescript
// 具体且高效
tape_read({ afterAnchor: "task/api", types: ["message"], limit: 10 })

// 而不是所有内容
tape_read({})
```

### 不应该做

❌ **过于频繁地创建锚点**
❌ **使用模糊的锚点名称**
❌ **在大型会话中不带过滤器查询**
❌ **忽略 tape_info 警告**（entriesSinceLastAnchor > 20）

## Token 成本

| 工具 | Token 成本 | 时机 |
|------|------------|------|
| `tape_handoff` | ~5-10 | 调用时 |
| `tape_list` | ~50-200 | 调用时 |
| `tape_info` | ~50-100 | 调用时 |
| `tape_read` | ~100-2000 | 调用时 |
| `tape_search` | ~50-500 | 调用时 |
| `tape_reset` | ~20 | 调用时 |

**关键洞察：** 只有查询工具消耗 token，而且仅在显式调用时消耗。

## 故障排除

### 问题：没有返回条目

**检查：**
1. 会话文件存在：`~/.pi/agent/sessions/`
2. 锚点名称存在：`tape_list()`
3. 尝试不带过滤器：`tape_read({ limit: 10 })`

### 问题：关键词触发的 handoff 没有出现

**检查：**
1. `settings.tape.enabled === true`
2. `settings.tape.anchor.keywords.global` 或 `project` 包含预期的关键词
3. 用户提示长度在 10 到 300 个字符之间
4. 关键词实际出现在提交的用户消息中

### 问题：内存文件没有注入

**检查：**
1. `settings.tape.enabled === true`
2. 内存仓库已初始化：`memory_check`
3. `core/` 目录存在
4. 投递模式行为符合预期：
   - `message-append` 在第一个 Agent 轮次发送主要内存负载一次
   - `system-prompt` 在每个 Agent 轮次附加主要内存负载
   - 关键词 handoff 指令可以作为单独的隐藏自定义消息在后续出现

## 文件结构

```
{localPath}/                    # 来自设置（"localPath"），默认：~/.pi/memory-md/
└── TAPE/                       # 或自定义 settings.tape.tapePath
    └── {projectName}__anchors.jsonl

~/.pi/agent/sessions/           # pi 会话存储（只读）
└── --{cwd-path}--/
    └── *.jsonl                 # 会话读取器扫描此处的文件并按会话头部 id 匹配
```

## 相关技能

- `memory-management` - 内存文件 CRUD 操作
- `memory-sync` - Git 同步
- `memory-init` - 仓库初始化
- `memory-search` - 搜索内存文件

## 参考

- 会话条目类型：`@mariozechner/pi-coding-agent`（SessionEntry）
- Tape 系统：https://tape.systems
- https://bub.build/
- https://github.com/bubbuild/bub/tree/main/src/bub
