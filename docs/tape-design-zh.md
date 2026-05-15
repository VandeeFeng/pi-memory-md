# Tape 设计文档

Tape 模式是一个**基于锚点的会话历史管理系统**，它使用 pi 会话作为数据源，仅在本地维护锚点索引。它提供按需检索的上下文获取能力，配合智能内存文件选择。

## 设计理念
**"按需记忆，智能检索"**

每一次新对话对 agent 来说都缺少连续记忆，而更大的 context window 并不自动等于更有效的上下文。pi-memory-md 因此更重视输入质量、索引和有意识的检索，而不是把更多历史直接塞进 prompt。

这个记忆模型有意接近计算机系统：
- **Context window 像 RAM**：快速、临时、有限，而且不总是可靠。
- **Markdown memory files 像磁盘**：持久、可 grep、可人工编辑，也更容易组织。
- **Anchors 和 metadata 像索引**：作为紧凑入口，帮助人和 agent 只在需要时定位具体细节。

这套设计首先也是面向人的，而不仅是面向 agent。即使不用 agent，这些文件也应该有价值：用户可以手动 grep tags、anchors、descriptions 和 paths，维护自己的 mental model，然后把选中的上下文交给 agent。Agent 的检索应该辅助这个流程，而不是替代它。

Tape 模式的灵感来源于：
- **LSTM 记忆** - 带检查点门的顺序上下文
- **Git 工作流** - 锚点作为提交，会话作为分支
- **Letta 记忆** - 明确的记忆操作和工具

Tape 模式将锚点存储为 pi 会话条目中的点，以此作为数据源。上下文传递根据配置的策略选择相关的内存文件和最近活动的项目文件，可选择包含简洁的 `recent focus` 提示。生命周期锚点（`session/*`）自动创建，而 handoff 锚点可通过 `/memory-anchor` 手动创建。当设置 `mode: "manual"` 时，直接的 `tape_handoff` 调用被阻止，这意味着 agent 不会自动创建锚点，但关键词匹配的隐藏指令和 `/memory-anchor` 仍然有效。关键词检测可以发送隐藏消息来引导 agent 创建关键词锚点，但 agent 可以在不需要时拒绝。这种锚点与关键词的组合平衡了 agent 的自主性和用户的控制权。

现在的设计把记忆分成三个时间尺度：
- **即时投递**：在 `session_start` 预热 memory/tape 上下文，然后通过 `message-append` 或 `system-prompt` 投递。
- **短桥接**：可选的 `sessionBridge` hook 会对上一个 session 的消息和最近 handoff anchors 建立小型 BM25 索引，只把与当前 prompt 相关的连续性带到 `new` / `resume` / `fork` 后的下一轮。
- **长期记忆**：`memory-digest` skill 会把最近 tape anchors 和选中的 session context 转换成经用户确认的长期 Markdown memory 更新。

为兼容 pi TUI，锚点名称会在 `/tree` 中镜像为附加到的会话节点的内联标签。在重新同步时，tape 会先清除现有的锚点前缀标签，然后再重建它们，以避免旧节点上残留陈旧的锚点标签。`/memory-review` 提供了一个面向人的独立 overlay，用来浏览、搜索、删除锚点，并跳转到对应会话位置，不必每次都让 agent 代为搜索 handoff。

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

### 1. 会话读取器（`tape/tape-reader.ts`）

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
  type: "session" | "handoff";
  meta?: {
    trigger?: "direct" | "keyword" | "manual";
    keywords?: string[];
    summary?: string;
    purpose?: string; // 简短标签（如 "feature"、"review"、"deploy"）
  };
  sessionId: string;      // 会话 ID
  sessionEntryId: string; // 关联的会话条目 ID
}
```

当前 JSONL 写入顺序为：`id`、`timestamp`、`name`、`type`、`meta`、`sessionId`、`sessionEntryId`。

**关键方法：**
- `append(entry)` - 添加新锚点到存储
- `removeById(id)` - 删除锚点并重建 JSONL 索引
- `getAllAnchors()` - 返回内存中的锚点列表
- `scan(options)` - 统一按 id/name/session/sessionEntry/type/time/meta 等字段过滤锚点，支持 `mode: "latest" | "all"`
- `search(options)` - 面向工具的搜索封装，包含 limit 处理
- `clear()` - 删除锚点索引并重置内存 map

### 3. Tape 服务（`tape/tape-service.ts`）

结合会话读取和锚点管理的主服务：

```typescript
class TapeService {
  // 锚点操作
  createAnchor(name: string, type: "session" | "handoff", meta?: TapeAnchor["meta"], syncTreeLabel?: boolean): TapeAnchor
  recordSessionStart(reason?: "startup" | "reload" | "new" | "resume" | "fork"): TapeAnchor
  deleteAnchor(id: string): TapeAnchor | null
  findAnchorByName(name: string, anchorScope?: "session" | "project"): TapeAnchor | null
  getLastAnchor(anchorScope?: "session" | "project"): TapeAnchor | null

  // 查询操作（从 pi 会话读取）
  scan(options: TapeSessionScanOptions & { since?: string }): SessionEntry[]
  scanEntriesWithFallback(options: TapeSessionScanOptions): SessionEntry[]
  searchAnchorsWithFallback(options: TapeAnchorScanOptions): TapeAnchor[]
  getAnchorStore(): AnchorStore
  getInfo(): {
    totalEntries: number;
    anchorCount: number;
    lastAnchor: TapeAnchor | null;
    entriesSinceLastAnchor: number;
  }
}
```

### 4. Tape 上下文（`tape/tape-context.ts`）

**ConversationSelector**：用于格式化/精简会话条目的辅助工具
- Token 预算过滤（默认：1000 tokens，40 条目）
- 可将选定的会话条目格式化为紧凑的上下文文本
- 作为内部辅助工具存在；当前运行时投递由 `MemoryFileSelector` 驱动

**MemoryFileSelector**：智能选择内存和项目文件
- **智能策略**：在可配置的时间窗口内（`memoryScan`）扫描最近的项目历史，当样本太小时扩展到最大窗口，先用 handoff 优先加权排名文件，再用 BM25 按当前意图重排候选文件
- **recent focus 提取**：在 smart 选中文件之后，从同一个实际生效的 smart 扫描窗口内提取最近的 `read` / `edit` 行范围；每个文件最多显示 5 段简洁的 `recent focus`
- **关键词 handoff 辅助**：规范化配置的关键词，当用户提示在 `[10, 300]` 字符范围内匹配关键词时，构建隐藏的 handoff 指令
- **仅最近策略**：扫描内存文件并返回最近修改的文件

### 5. Tape 工具（`tape/tape-tools.ts`）

七个向 pi 扩展 API 注册的工具：

## Tape 工具参考

### tape_handoff - 创建锚点检查点

```typescript
tape_handoff(
  name: string,        // 锚点名称（如 "task/begin", "task/complete", "handoff"）
  summary?: string,    // 简短意图摘要，少于 18 个词
  purpose?: string     // 1-2 个词的用途标签
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

### tape_search - 搜索锚点和条目

```typescript
tape_search({
  kinds?: ["anchor" | "entry" | "all"],
  limit?: number,          // 最大结果数（默认：20，最大：100）
  contextLines?: number    // 锚点附近上下文行数（默认：0，最大：5）
})
```

**返回：** 匹配的条目或锚点，包含 id、时间戳、类型、元数据、过滤条件和可选的附近对话上下文。

---

### tape_delete - 删除锚点检查点

```typescript
tape_delete(
  id?: string,    // 来自 tape_search 的单个锚点 ID
  ids?: string[]  // 来自 tape_search 的多个精确锚点 ID
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
  scan?: string,                     // 对格式化 entry JSON 做文本扫描
  types?: SessionEntry["type"][],    // 按类型过滤
  entryScope?: "session" | "project", // 默认：project
  anchorScope?: "session" | "project", // 默认：session
  limit?: number,                    // 最大条目数（默认：20，最大：100）
  maxContentChars?: number | null    // 默认：300，null 返回完整格式化内容
})
```

**常用模式：**
```typescript
// 上次锚点以来的所有内容
tape_read({ lastAnchor: true })

// 任务开始以来的上下文
tape_read({ afterAnchor: "task/begin" })

// 搜索消息
tape_read({ scan: "database schema", limit: 10 })

// 日期范围
tape_read({ betweenDates: { start: "2026-04-01", end: "2026-04-16" } })
```

---

### tape_search - 搜索条目和锚点

```typescript
tape_search({
  kinds?: ("entry" | "anchor" | "all")[],  // 搜索什么
  types?: SessionEntry["type"][],          // 按类型过滤条目
  limit?: number,                           // 最大结果数（默认：20，最大：100）
  sinceAnchor?: string,
  lastAnchor?: boolean,
  betweenAnchors?: { start, end },
  betweenDates?: { start, end },
  entryScope?: "session" | "project",
  anchorScope?: "session" | "project",
  scan?: string,                            // 搜索 entry/anchor 内容
  anchorName?: string,                      // 锚点名称子串
  anchorType?: "session" | "handoff",
  anchorSummary?: string,
  anchorPurpose?: string,
  anchorKeywords?: string[]                 // 必须全部存在
})
```

**示例：**
```typescript
// 查找匹配的锚点
tape_search({ kinds: ["anchor"], scan: "bug" })

// 按元数据查找 handoff 锚点
tape_search({ kinds: ["anchor"], anchorType: "handoff", anchorPurpose: "migration" })

// 查找内存相关工具调用
tape_search({ kinds: ["entry"], types: ["message"], scan: "memory" })
```

---

### tape_reset - 重置锚点存储

```typescript
tape_reset(archive?: boolean)  // 归档标志被接受但未实现
```

**行为：** 清除锚点存储，然后立即通过 `recordSessionStart()` 创建一个新的会话生命周期锚点。

---

## 运行时流程

Tape 模式有两个不同的阶段：会话设置和每轮上下文投递。

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
│ - tape_handoff, tape_search 等       │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ 创建会话生命周期锚点                   │
└──────────────────────────────────────┘
       ↓
┌──────────────────────────────────────┐
│ 预热投递上下文                         │
│ - 按需运行 sessionStart hooks          │
│ - 异步扫描 memory 文件                 │
│ - 预选 smart tape 文件                 │
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
│ 投递或复用已准备的上下文                       │
│ - 必要时等待 session-start warmup             │
│ - 检测关键词 handoff 指令                      │
│ - 可选渲染 sessionBridge 上下文                │
│ - 通过 system-prompt 或 message-append 投递   │
└──────────────────────────────────────────────┘
```

**重要提示：** 重型扫描会在 `session_start` 预热并缓存。`before_agent_start` 仍然在每个 Agent 轮次运行，但通常只是等待 warmup、处理关键词/session-bridge 逻辑，并投递缓存负载。
- `message-append`：tape 选择的内存在第一个 Agent 轮次作为隐藏的自定义消息（`pi-memory-md-tape`）投递一次
- `system-prompt`：缓存的 tape 选择内存在每个 Agent 轮次附加到当前 system prompt
- 关键词触发的 handoff 指令可以作为单独隐藏的自定义消息（`pi-memory-md-tape-keyword`）在后续轮次投递
- 这个隐藏关键词消息仍属于同一个 agent turn，不会额外产生第二次 LLM 请求；只会增加当前请求的 token。
- 在 pi 中，附加意味着返回 `systemPrompt: event.systemPrompt + "..."`；返回纯字符串将替换该轮次的 prompt

## Session Bridge

`hooks.beforeAgentStart: ["sessionBridge"]` 是一个可选的短桥接机制，用于非常接近的 session 切换。它不是长期记忆。

当 session 通过 `new`、`resume` 或 `fork` 启动时，pi 会提供 `previousSessionFile`。如果上一个 session 的最后条目仍在 bridge window 内（默认 60 秒），pi-memory-md 会从近期 user/assistant 消息中准备一个小型 BM25 索引。如果 tape 启用，也会把最近 handoff anchors 的 name、summary、purpose、keywords 建进索引。

在下一次 `before_agent_start`，当前 prompt 会查询这个准备好的索引。只有超过分数阈值的匹配会被渲染成紧凑的 `<session_bridge>` 块，anchor 匹配会放在 `<tape_anchors>` 下。在 `message-append` 模式下，bridge 会追加到启动 memory 消息；在 `system-prompt` 模式下，它会作为单独隐藏消息发送。

这个 bridge 是为了减少紧邻 session 切换时的“失忆感”，但不会把上一段对话整段塞进上下文。真正需要长期保存的内容仍应通过 `memory-digest` / `memory-write` 写入。

## 内存上下文投递

Tape 模式改变的是**选择哪些内存文件**，而不是投递机制本身。
投递的内容是内存索引/摘要加上 tape 提示。

```typescript
// settings.tape.context
{
  strategy: "smart",           // "smart" 或 "recent-only"
  fileLimit: 10,                // 最大内存文件数
  memoryScan: [72, 168],        // 智能扫描范围：[起始小时数, 最大小时数]
  whitelist: [],                // 始终包含这些文件或目录
  blacklist: [],                // 始终排除这些文件或目录；其他路径仍会先走 rg 忽略规则，再走默认忽略名单
}

// 投递内容包括：
- 带有描述/标签的内存文件列表
- 对候选 memory/project 文件做 BM25 意图重排，查询来自最近用户 prompt 和近期 anchor 的 summary/purpose/keywords；中文和中英混合文本会先分词再排名
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

| 投递模式 | Tape 行为 |
|----------------|---------------|
| `message-append` | 在第一个 Agent 轮次将 tape 选择的内存作为隐藏的自定义消息（`pi-memory-md-tape`）投递一次 |
| `system-prompt` | 在每个 Agent 轮次将已准备的 tape 选择内存附加到当前 system prompt |

关键词触发的 handoff 指令与主要内存负载独立，可以在配置关键词匹配时作为 `pi-memory-md-tape-keyword` 在后续投递。它仍然属于同一个 agent turn，因此不会触发额外的 LLM 请求；只会增加当前轮次的 token 开销。

如果 `settings.tape.anchor.mode === "manual"`，主要 tape 提示会告诉 LLM 不要主动创建 `tape_handoff` 锚点，工具层会拒绝直接调用 `tape_handoff`。但关键词触发的隐藏指令和 `/memory-anchor` 仍然可以通过 runtime 绑定授权创建 handoff。

这意味着 tape 影响的是**选择**，而投递模式控制的是**投递频率和位置**。

### Tape 启用规则

只有在以下检查全部通过时，tape runtime 才会启用：
- `settings.tape.enabled !== false`
- 当前 `cwd` 不命中 `settings.tape.excludeDirs` 中的任何绝对路径
- 当前 `cwd` 不命中内建的系统安全排除目录
- 当 `settings.tape.onlyGit !== false` 时，会从 `cwd` 执行 `git rev-parse --show-toplevel` 来解析 Git 根目录

如果任一检查失败，则该轮/该次会话启动会完全跳过 tape：不做 tape 投递、不发送 tape 关键词 handoff 消息，也不记录 anchor。

**Tape 提示：**
```
💡 Tape 上下文管理：
您的对话历史记录在带有锚点（检查点）的 tape 中。
- 使用 tape_info 检查当前 tape 状态
- 使用 tape_search 按类型或内容查询历史条目
- 使用 tape_search({ kinds: ["anchor"] }) 列出所有锚点检查点
- 在开始新任务时使用 tape_handoff 创建新锚点/检查点
```

## 配置

```json
{
  "pi-memory-md": {
    "hooks": {
      "beforeAgentStart": ["sessionBridge"]
    },
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

- `hooks.beforeAgentStart: ["sessionBridge"]` 是可选配置。只有当你需要在紧邻的 `new` / `resume` / `fork` 切换中保留短期连续性时才启用。
- `onlyGit` 默认是 `true`。启用后，tape 只会在 Git 仓库内运行；否则会跳过 tape 投递和 anchor 记录。
- `excludeDirs` 是一组绝对目录路径。如果当前 `cwd` 等于或位于任一排除目录之下，tape 会被跳过。
- 内建的系统安全排除目录也会默认生效，并与用户自定义的 `excludeDirs` 合并。

### 上下文策略

**智能模式**（默认）：
- 仅统计记录在 tape 历史中的助手端工具调用
- 忽略引用文件不再存在于磁盘上的过时 tape 路径
- 跟踪加权文件活动：
  - `memory_write` => 基础分数 `16`
  - `read` => 基础分数 `20`
  - `edit` => 基础分数 `28`
  - `write` => 基础分数 `30`
- 重复访问使用 BM25 启发式饱和：每次重复访问仍贡献信号，但系数变为 `1 / sqrt(previousAccessCount + 1)`
- **提升规则**（两个独立提升，如果适用都应用）：
  - 最新的 handoff 锚点（任何触发器）：最高 `+30`
  - 最新的关键词触发的 handoff 锚点：最高 `+40`
- 锚点提升仅在最新匹配锚点后的前 `15` 个 tape 条目内有资格
- 访问分数按 24 小时指数时间衰减平滑降低
- 锚点提升在有效窗口内按 12 小时指数衰减平滑降低
- 同一个文件被多种工具类型触达时，会添加小额 diversity bonus
- 初始扫描窗口为 `memoryScan[0]` 小时
- 如果该窗口内的助手工具调用总访问量少于 `MIN_SMART_ACCESS_SAMPLES`（硬编码为 `5`），则按 24 小时步进继续扩展，直到达到足够样本或到达 `memoryScan[1]`
- 一旦文件选择停止，`recent focus` 只会从这个同样的实际扫描窗口中提取；不会比文件选择结果看得更久远
- 最终排序：
  1. 最终分数（加权分数 + diversity bonus）
  2. 原始累计分数
  3. 最后访问时间
- 行为排序后的候选文件会再经过 BM25 意图匹配重排，然后得到最终投递列表
- 如果没有历史记录则回退到目录扫描；但 worktree 会跳过这个 fallback，因为它的 tape 历史本来就是隔离的

**recent focus 格式化规则：**
- `read` 范围来自 `offset + limit`
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
| `tape_info` | ~50-100 | 调用时 |
| `tape_read` | ~100-2000 | 调用时 |
| `tape_search` | ~50-500 | 调用时 |
| `tape_reset` | ~20 | 调用时 |

**关键洞察：** 只有查询工具消耗 token，而且仅在显式调用时消耗。

## 故障排除

### 问题：没有返回条目

**检查：**
1. 会话文件存在：`~/.pi/agent/sessions/`
2. 锚点名称存在：`tape_search({ kinds: ["anchor"] })`
3. 尝试不带过滤器：`tape_read({ limit: 10 })`

### 问题：关键词触发的 handoff 没有出现

**检查：**
1. `settings.tape.enabled === true`
2. `settings.tape.anchor.keywords.global` 或 `project` 包含预期的关键词
3. 用户提示长度在 10 到 300 个字符之间
4. 关键词实际出现在提交的用户消息中

### 问题：内存文件没有投递

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

${PI_CODING_AGENT_SESSION_DIR:-~/.pi/agent/sessions}/  # pi 会话存储（只读）
└── --{cwd-path}--/
    └── *.jsonl                 # 会话读取器扫描此处的文件并按会话头部 id 匹配
```

## 相关技能和命令

- `memory-init` - 通过 skill 工作流初始化仓库
- `memory-write` - 通过 Markdown 文件和 frontmatter 校验创建/更新长期记忆
- `memory-import` - 从 URL、文件夹或文件导入长期知识
- `memory-digest` - 将近期 tape/session context 转换为经确认的长期记忆
- `/memory-review` - 面向人的 anchor 时间线、搜索、删除和跳转 overlay
- 原生工具：`memory_check`、`memory_search`、`memory_sync`

## 参考

- 会话条目类型：`@earendil-works/pi-coding-agent`（SessionEntry）
- Tape 系统：https://tape.systems
- https://bub.build/
- https://github.com/bubbuild/bub/tree/main/src/bub
