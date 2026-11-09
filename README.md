# dsh-session-bridge

让**外部工具**（Qoder、CI、脚本）在**正在运行的 DSH 桌面端 GUI** 里管会话生命周期：新建会话、查某个工作区已有哪些会话（包括侧栏还没画出来的空会话）、往指定会话投第一条消息、把孤儿会话补挂回名册，并把「任务号 → 会话」这条指针记下来、一次调用读出所有在册任务的状态。

一句话口径：**建会话只把它写进工作区名册；要它在侧栏显形，得投进第一条消息**（原因见下面「记了账还不算完」）。

## 为什么需要它

DSH 桌面端 GUI 的 Web 端口不是公开 API：

- `/` 与 `/api` 前面的每个请求都要 `dsh-auth-<authority>` 签名 cookie；
- cookie 只能用启动令牌换（`/connect?token=…`），而该令牌是**进程启动时随机生成、只存在内存里**，从不落盘、不进环境变量，只通过 IPC 交给 Electron 自己的窗口。

所以外部进程直接 `curl http://127.0.0.1:<端口>/…` 只能拿到 401。本插件跑在**宿主进程内部**，因此可以：

1. 在 Web 服务器上注册一条**在 cookie 门之前**被匹配的路由（未注册路径返回 404 而不是 401，说明路由表在门之前）；
2. 直接调用宿主自己的服务。

## 光会建会话还不够：要**记账**

DSH 0.2.x 有两本账：

- 会话本体：`$DSH_HOME/sessions/<cwd 桶>/<id>/session.v4.jsonl.zstd`（磁盘上有 ≠ 侧栏可见）；
- 工作区名册：`$DSH_HOME/storages/workspace.json` 里每个工作区的 `sessionIds`。**GUI 侧栏按名册列会话。**

GUI「新建会话」按钮走的是 `sessionController.create({ workspaceId })`：

```
workspace = workspaceRegistry.get(workspaceId)
cwd       = workspace.path
created   = agents.createSession({ cwd })
await workspace.attachSession(created.id)   ← 这一步才是记账
```

而 `create({ cwd })` **只写第一本账**：会话落盘、进程里也有了，但没人把它挂到工作区上，侧栏永远不列它 —— 现象就是「会话建出来了，但看不见」。（本插件 0.1.0 正是这个毛病，0.2.0 修掉。）

现在的实现与 GUI 按钮**同一条路径**：

1. `workspaceRegistry.resolveByPath(cwd)` 找现有工作区；找不到则 `workspaceRegistry.create(cwd)` 注册一个（可关）；
2. `sessionController.create({ workspaceId })` —— 由宿主控制器把 cwd 取成 `workspace.path` 并调用 `attachSession`；
3. 收尾再**幂等复查**一次名册：若 `sessionIds` 里没有它，直接调 `workspace.attachSession(sessionId)` 补上，并把结果回给调用方（`attached`）。

## 记了账还不算完：空会话在侧栏不画

DSH 客户端的侧栏过滤是（`packages/client/ui-workspace/src/client/tree.ts`）：

```ts
session.origin !== 'subagent' && !archived.has(session.id) && (!session.blank || session.id === current)
```

`blank` 只在收到 `turn/start` 时清零。桥只建会话、没人发消息，于是这个会话**在册、在磁盘、但侧栏不画**——不是记账失败，是它还没跑过一轮。GUI 自己那个「新建会话」按钮看得见，是因为它随后调用 `connectWorkspace` → `replaceMain`，把这个空会话设成了当前会话。

所以插件补了两条把决定权交回调用方的路由：

- `POST /x-session-bridge/sessions`：读宿主全量会话（可选按 `cwd`/`workspaceId` 收窄到某个工作区名册），带回 `blank` 标记。**复用还是新建由调用方自己判**，别再攒一串看不见的空会话。
- `POST /x-session-bridge/prompt`：往指定会话投一条消息。宿主按 `requestId` 幂等收单（同一个 id 再投不会跑第二轮），投成功后 `turn/start` 清掉 `blank`，这一行就永久可见了。

## 安全边界

- 只接受 **loopback** Host（`127.0.0.1` / `localhost` / `[::1]`），挡 DNS rebinding；
- 需要 **Bearer 令牌**（32 字节随机），存放在
  `$DSH_HOME/plugin-data/dsh-session-bridge/bridge.json`，权限 0600；
- 没有 CORS 头、不处理 OPTIONS ⇒ 浏览器页面无法静默调用；
- 能读到这个文件的人本来就能驱动你的宿主，所以没有引入新的信任边界。

## 安装

一个仓库两样东西：DSH 宿主插件（`lib/` 加 `cordis.patch.yml`）和 Qoder 插件（`.qoder-plugin/` 加 `skills/`）。命令行只有 `bin/` 这一份，两侧共用。两侧都要装才能从 Qoder 驱动 DSH。

### DSH 宿主侧

1. 编辑 profile 的 `package.json`，位置是 `$DSH_HOME/profiles/<profile>/package.json`（桌面版是 `desktop`）。在 `dependencies` 里加本仓库，在 `dsh.profile.bundles` 数组里加 `dsh-session-bridge`（数组里已有的条目保留）：

   ```json
   {
     "dependencies": { "dsh-session-bridge": "file:../../../dsh-session-bridge" },
     "dsh": { "profile": { "bundles": ["dsh-session-bridge"] } }
   }
   ```

   `file:` 后面是相对 profile 目录的路径，按克隆位置改。不想克隆就从公开仓库装，把 `dependencies` 里那一行换成：

   ```json
   { "dependencies": { "dsh-session-bridge": "github:fisherchann/dsh-session-bridge#v0.5.0" } }
   ```

   `#` 后面锁 tag 或 commit，别用会漂的分支名。
2. 在 profile 目录跑 `pnpm install` 让依赖落地（`file:` 依赖会在 profile 的 `node_modules` 里建成指向克隆目录的链接）。
3. 重启 DeepSeek Harness。插件在宿主启动时挂载，由 DSH 的 plugin manager 把包里的 `cordis.patch.yml` 合进 profile 配置。

### Qoder 侧

把仓库根目录打成一个 ZIP（要含 `.qoder-plugin/plugin.json`、`skills/`、`bin/`），在 Qoder 的 扩展 → 插件 → 添加插件 → 上传 Plugin 交上去，一次一个包，不要直接交文件夹；上架后也可以从公开市场按名字装。装完 skill 按自己的基目录找到 `bin/dsh-session.mjs`，不需要配路径。

### 运行环境

- Node 22.15 以上（或 23.8 以上）：读会话正文要用 `zlib` 的 zstd 解压接口，这两个版本才加进来，且仍是 experimental。缺了它桥不崩，但汇报读数会报 `this Node has no zlib.zstdDecompressSync`。
- 零第三方依赖，只用 Node 自带模块。
- 只对同代 DSH 有效：桥读的是 DSH 的投影缓存、会话正文与名册落盘格式，这些是宿主内部约定，宿主大版本变更后读数可能退化成 `unknown`。
- 命令行跨平台（`node bin/dsh-session.mjs`）；`bin/dsh-session.cmd` 只是 Windows 便捷入口。

> **改代码后必须重启 DSH 才生效。** 插件在宿主启动时挂载、不热加载：宿主没重启时，旧进程里跑的还是旧实现——`--access` 必填、409/400/503、新的在等人判据、`/health` 真实探针全都不会出现。

## CLI

```bat
node bin/dsh-session.mjs --cwd "D:\work\demo" --preset code-review
```

| 参数 | 说明 |
| --- | --- |
| `--cwd <dir>` | 会话工作目录（缺省 = 当前目录；接受 Git Bash 的 `/d/...`） |
| `--preset <id>` | agent preset（`code-review` = 代码审查模式；缺省用默认预设） |
| `--workspace <id>` | 指定工作区（缺省按 `--cwd` 自动解析/注册） |
| `--no-create-workspace` | 该目录还没注册成工作区时**报 409**，不自动注册 |
| `--attach <sessionId>` | 把**已存在**的会话补挂到工作区（修复孤儿会话） |
| `--create-workspace` | 配合 `--attach`：允许为孤儿会话的目录新建工作区 |
| `--sessions` | 列会话（带 `blank` 标记）；配 `--cwd`/`--workspace` 就只列该工作区名册里的 |
| `--send <sessionId>` | 往该会话投一条消息；配 `--text` 与 `--access` 使用 |
| `--text "<msg>"` | 消息正文（`--send` 必填） |
| `--mode queue\|steer` | 投递模式，缺省 `queue`；`steer` 是往正在跑的一轮里插话。**它只是投递通道，不是读写声明** |
| `--request-id <uuid>` | 显式指定幂等 id；同一个 id 重复投不会跑第二轮（缺省每次新生成） |
| `--task <id>` | 任务号（取自任务书首行，如 `task-6`）；配 `--pointer`/`--accept`/`--void`/`--send` 使用 |
| `--access read\|write` | **本次派单的读写性质；`--send` 必填，`--pointer` 新建/刷新时必填**。缺了 CLI 直接退出 2，桥也不会猜 |
| `--stage <stage>` | 把票挪到七站之一：`delivered`、`reported_ready/blocked/failed/dropped`、`accepted`、`voided`。`reported_*` 还要 `--seq`；`accepted`/`voided` 用 `--accept`/`--void` 更顺手 |
| `--seq <n>` | 汇报在会话正文里的记录 seq；`--stage reported_*` 必填，桥会回正文复核这个 seq 的状态词 |
| `--session <sessionId>` | 指针指向的会话（`--pointer`/`--accept`/`--void` 用；`--send` 可省） |
| `--pointer` | 写/刷新一条任务指针（配 `--task` `--session`；新建用 `--access`，挪站用 `--stage`+`--seq`） |
| `--accept` | 人工终局：把票标成 `accepted`（配 `--task` `--session`，**必须带 `--note`**） |
| `--void` | 人工终局：把票标成 `voided`（配 `--task` `--session`，**必须带 `--note`**） |
| `--note "<text>"` | 人工终局结论/备注（≤500 字）；`--accept`/`--void` 必填 |
| `--status` | 一次读出所有在册任务的现场状态、票的阶段、汇报与成本；配 `--task`/`--session`/`--cwd` 收窄 |
| `--dry-run` | 只打印 url/cwd/preset，不发请求、**不打印 token** |

先看有什么再决定复用还是新建：

```bat
node bin/dsh-session.mjs --sessions --cwd "D:\work\demo"
```

把第一条消息投进去（投完这一行才会在侧栏显形）：

```bat
node bin/dsh-session.mjs --send "session-<uuid>" --text "先读 README，再列风险" --access read
```

带任务号投递，投完顺手记指针（两步一次完成）：

```bat
node bin/dsh-session.mjs --send "session-<uuid>" --text "只读检查：列风险" --task task-6 --access read
```

单独记指针 / 标验收 / 查状态：

```bat
node bin/dsh-session.mjs --pointer --task task-6 --session "session-<uuid>" --access read --request-id <uuid>
node bin/dsh-session.mjs --pointer --task task-6 --session "session-<uuid>" --stage reported_ready --seq 1234
node bin/dsh-session.mjs --accept --task task-6 --session "session-<uuid>" --note "复核通过"
node bin/dsh-session.mjs --void --task task-6 --session "session-<uuid>" --note "需求已撤"
node bin/dsh-session.mjs --status --cwd "D:\work\demo"
```

成功时输出（关键字段）：

```json
{
  "status": 200, "ok": true,
  "sessionId": "session-…",
  "cwd": "D:\\work\\demo",
  "agentPreset": "code-review",
  "workspaceId": "37776011-…",
  "workspaceTitle": "platform",
  "workspaceCreated": false,
  "attached": true,
  "guiUrl": "http://127.0.0.1:<端口>"
}
```

修复一个 0.1.0 时代建出来的孤儿会话：

```bat
node bin/dsh-session.mjs --attach "session-<uuid>" --cwd "D:\work\demo"
```

`attachSession` 会校验会话头的 cwd 与工作区路径**逐字节一致**（realpath 规范化后），不一致会明确报错，不会乱挂。

## HTTP API

```
POST <url>/x-session-bridge/new
POST <url>/x-session-bridge/attach
POST <url>/x-session-bridge/sessions
POST <url>/x-session-bridge/prompt
POST <url>/x-session-bridge/pointer
POST <url>/x-session-bridge/status
Authorization: Bearer <bridge.json 里的 token>
Content-Type: application/json
```

`new` 的 body：`{ "cwd": "D:\\path", "preset": "code-review", "workspaceId": "…", "createWorkspace": true }`
（`cwd` 与 `workspaceId` 二选一；`preset` / `workspaceId` / `createWorkspace` 可选。）

`attach` 的 body：`{ "sessionId": "session-…", "cwd": "D:\\path", "workspaceId": "…", "createWorkspace": false }`

`sessions` 的 body：`{ "cwd": "D:\\path" }` 或 `{ "workspaceId": "…" }`，都不传就列全宿主会话。回 `{ ok, workspaceId, count, blankCount, sessions:[{ sessionId, blank, running, title, cwd, updatedAt, origin }] }`。宿主 0.2.x 的会话摘要字段名是 `sessionId`、0.1.x 是 `id`，桥两者都认（只认 `id` 的旧写法会把每一行都过滤掉，症状是 `count:0` 但名册里明明有会话）。

`prompt` 的 body：`{ "sessionId": "session-…", "text": "…", "access": "read"|"write", "taskId": "task-6", "mode": "queue"|"steer", "requestId": "<uuid>" }`，成功回 `{ ok:true, sessionId, requestId, access }`。

- **`access` 必填**（或 `mode` 取 `read`/`write`）：声明这次派单是只读还是写。缺失回 **400** `reason:"mode-required"`，宿主**收不到**这条消息；桥不猜、也不静默按某一种处理。
- `mode` 是投递通道（`queue`/`steer`），和读写性质不是一个字段。
- `taskId` 可选；带上时先查任务绑定（需求 4），指向别的会话回 **409** `code:"task-bound"` 并给 `boundSessionId`，不投递。
- **写派单的并发拦截**：目标会话自己或同工作目录下别的会话处于**在跑、在等人、或状态判不出来（`unknown`）**，回 **409** 且不投递。目标会话自己在等人是 `code:"session-waiting"`；目标会话自己状态未知是 `code:"session-unknown"`；同目录别的会话占用是 `code:"directory-busy"`。都给 `occupant.sessionId` / `occupant.state`，状态未知另有 `occupant.stateReason`；只有**确定**在等人时才有 `needsHuman:true` 与答卡 `hint`（桥不代答）。`unknown` 的 `hint` 说明「正文不可读、判不定状态」，让你确认该会话状态或修好正文路径。
- 只读派单不受并发限制；向处于**在跑**的同一会话追加消息（追问、纠偏）也不受限。
- 单写者检查本身跑不了时（投影目录列不出来、该会话投影读不了）回 **503** `code:"projection-store-unavailable"` 并带 `reason`，**不投递**。「该会话还没有投影」是另一回事，仍放行。
- **`unknown` 不是空闲（缺陷 F）**：`pendingCalls` 非空本身就是「有一口气没回来」的证据，正文读不到只说明**证不出空闲**。把它当空闲放行，消息只会排进 `inbox.next-turn`、卡片照挂，而调用方拿到 200——正是需求 3 要堵的失败。所以状态未知计入占用；只有「还没有投影」的新会话（`ENOENT`）例外，仍放行。
- `requestId` 可省（服务端生成 uuid）；同一个 `requestId` 重复投只算一轮。

`pointer` 的 body：`{ "taskId": "task-6", "sessionId": "session-…", "mode": "read"|"write", "requestId": "<uuid>", "stage": "reported_ready", "seq": 1234, "note": "…" }`。
`taskId` / `sessionId` 必填。**新建**记录时 `mode` 必填，`stage` 只能是 `delivered` 或缺省（缺省即 `delivered`），`history` 为空；**刷新**已有记录可省 `mode`（省略即保留原值）。带新 `requestId` = 同任务重投，票回 `delivered` 并追加一条 `redeliver` 历史。`acceptance` / `acceptedAt` 已收编进 `stage`，**不再是可写字段**（再传回 400）；响应里的 `acceptance` 由 `stage === 'accepted'` 派生。回 `{ ok, pointer, pruned, count }`，`pointer` 带 `stage`、`history`、派生的 `acceptance` / `acceptedAt`。
**`taskId` 是唯一键**：同一个任务号落到**另一个**会话时回 **409** `code:"task-bound"`，响应体给出 `boundSessionId`，**不静默改写**调用方指定的目标；同一任务号 + 同一会话再写一次是**刷新**，不是新增。若新 `requestId` 与记录里的不同（= 同一任务的新一次派单），票回到 `delivered` 并追加一条 `redeliver` 证据，旧 `history` 保留。
**指针不记 `cwd`**：目录是投影里的事实（`record.rows.workingDirectory.val`），由桥现算；请求里带 `cwd` 会被忽略。旧记录里的 `cwd` 不迁移，随 30 天清理消失。

`status` 的 body：`{}`，或 `{ "taskId": "…" }` / `{ "sessionId": "…" }` / `{ "cwd": "D:\\path" }` / `{ "acceptance": "pending"|"accepted" }` 收窄。**`cwd` 过滤比的是投影里的 `workingDirectory`，不是指针里存过的目录**；无投影的会话仍留在册（`sessionCwd:null`），不会因为过滤被丢掉。
回 `{ ok, checkedAt, derivedFrom:"session-projection-cache", staleness:"…", count, summary:{ running, waiting, idle, unknown }, pointers:[{ taskId, sessionId, mode, requestId, acceptance, acceptedAt, stage, history, createdAt, note, liveState, state, running, waiting, idle, openStep, pendingCalls, pendingCallIds, waitingKind, stateReason, openTurnStartSeq, lastStepBoundary, blank, lastPromptAt, agentPreset, permissions, sessionCwd, projection, report, cost }] }`。
**这是投影/正文视图，不是实时**：投影在步边界落盘、步内不刷新，所以 `liveState` 与 `cost` 是最后一次落盘时的读数、滞后一个步；`report` 是**这张票自己**那条汇报（按块里的 `任务:` 认领，不是会话里最近一条）；`staleness` 字段把这句话带回给调用方。`state` 是上一轮的兼容别名，值恒等于 `liveState`；票的阶段用 `stage`，**不要把两者混用**。

### 汇报协议（第二轮 `report`；第三轮缺陷 I/J 收紧）

派单任务书末尾要求对方在最后一回合只回这个五行块，**每行从行首写起**：

```text
汇报状态: ready | blocked | failed | dropped
任务: <本单任务号>
结论: 一句话说清这单做成了什么
凭据: 改了哪些文件、跑了什么命令、结果数字
前置: 仅 blocked 填写，写明卡在哪个前置条件、需要谁做什么
```

**汇报认领到票，不认领到会话**（缺陷 I）：一个会话常同时挂着几张票（同一 `sessionId` 下 `task-rw`、`task-stage`、`task-stagefix` …），会话里最近一条汇报属于谁，只能由块里的 `任务:` 说了算。`/status` 对**每一张票**从正文末尾向前扫，取第一个 `任务:` 与本票任务号**逐字相等**的块；别的票的块一律跳过。没有属于自己任务号的块就是 `unreported`——不拿会话里最近那条顶替。缺 `任务:` 行的块判 `invalid` 并点名 `任务`，不退化成 `unreported`，也不按「整会话通用」处理；**最新一个块没有任务行时同样判 `invalid`**，不会回退到更老的块。缓存按（会话 + 任务号）分开，一张票的读数不会被另一张票复用。历史四行汇报（seq 2963 / 3640）不回改正文，它们已落的站留在 `history` 里；新协议只对以后的汇报生效。

**锚点与标签都必须行首**（缺陷 J）：一行只有在去掉行首空白、`>`、围栏/强调符之后**以 `汇报状态` 开头、紧跟冒号**才算锚点；冒号之后除空白与强调符外还有别的文字，判 `invalid`（`the anchor line carries text after the status word`），不会把整段引用当状态词。`任务` / `结论` / `凭据` / `前置` 同样必须行首，行中夹带的同名字样只是正文。于是 `凭据:` 行里整段引用一条旧汇报（含 `汇报状态: …`）不会抢走真锚点。

`/status` 每条票返回 `report`：

- `state`：四个状态词之一，或 `unreported`（**整份正文读完**、没有本票的块）、`invalid`（有锚点但缺必填行 / 状态词不在四个之内 / 锚点行冒号后还有别的话）、`unknown`（正文取不到，见下）；
- `taskId`：这条读数来自哪个块（块里 `任务:` 的值；`unreported`/`unknown` 为 `null`）；
- `seq`：锚点所在正文记录的 seq（非命中时为 `null`）；
- `missing`：`invalid` 时缺的中文行名（`任务` / `结论` / `凭据` / `前置`）；
- `reason`：`invalid` 的原因；`lines`：解析出的结论/凭据/前置原文（只回给调用方，**不进指针文件**）；
- `stateReason`：`unknown` 时取不到的是哪一环（定位 / 解压 / 没读满整份），其余状态为 `null`；
- `scannedFrames` / `scannedBytes`：**本次调用**实际解压的帧数与字节数（命中缓存时为 0）；
- `bodyFrames` / `bodyBytes`：该正文的总帧数与总字节数（定位不到时为 `null`）；
- `fromCache`：本次是否命中解析缓存。

**取法是逐级放大，不是固定窗口**（缺陷 H）：从正文末尾先按 8 帧扫，取不到就把窗口放大到 64 帧、512 帧，最后读整份正文，**命中即停**。因此「汇报之后又写了几十条记录 / 又压缩了一次」不会把锚点挤出窗口——旧实现固定 8 帧，倒数第 15 帧的锚点会被漏掉并报成 `unreported`。

只有**整份正文读完且确实没有本票的块**才叫 `unreported`；其余取不到的情形一律 `unknown` + `stateReason`，三者字节级不同：

| 取不到的一环 | `state` | `stateReason` 说的事 |
| --- | --- | --- |
| 正文定位不到 / stat 或读失败 | `unknown` | 桶里找不到、或读不动该文件 |
| 某一帧解压失败（更新的帧读不出来） | `unknown` | 更新的帧解不了，**更新的汇报不能被排除**，所以不把更老的当最新答案 |
| 正文大于 `REPORT_SCAN_BYTE_LIMIT`（16 MiB）读不满 | `unknown` | 只扫了尾部多少字节 / 多少帧，**没有读完整份** |

缓存只存**确定结论**（命中的块，或整份读完没有本票的块）：`unknown` 不进缓存，正文修好后下一次 `/status` 就给出正确读数，不需要重启宿主，也不会把一次读取失败固化成「没汇报」。同一票在正文文件的字节数与修改时间未变时复用上次结论；命中缓存的那次 `scannedFrames`/`scannedBytes` 为 0。

### 票的阶段（第二轮 `stage` / `history`）

七站：`delivered`、`reported_ready`、`reported_blocked`、`reported_failed`、`reported_dropped`、`accepted`、`voided`。`liveState`（在跑/在等人/空闲/unknown）与 `cost` **不是**站：它们每次现读、滞后一个步，落盘会形成两份真相。

`history` 只追加不改写，每条 `{ stage, at, evidence }`；`evidence` 为 `{kind:"report", seq}`、`{kind:"human", note}` 或 `{kind:"redeliver", requestId}`；当前站等于最后一条的 `stage`（初始 `delivered` 的 `history` 为空）。迁移表定死，表外一律拒写：

| 当前站 | 允许写入的下一站 |
| --- | --- |
| 无记录 | `delivered` |
| `delivered` | `reported_ready`、`reported_blocked`、`reported_failed`、`reported_dropped`、`accepted`、`voided` |
| `reported_blocked` / `reported_failed` / `reported_dropped` | `delivered`（同任务重投）、`voided` |
| `reported_ready` | `accepted`、`delivered`（同任务重投）、`voided` |
| `accepted` / `voided` | 同任务号带新 requestId 重投时回到 `delivered`，其余拒写 |

写站的证据规则：

- 写 `reported_*` 必须带 `seq`，桥回正文复核该 seq 上确实解析出**同一个**状态词；对不上回 **400** `code:"report-unverified"`，不写。复核同时比对 `任务:`：块里写的是别的票回 **400** `code:"report-task-mismatch"`（报错写明「这条汇报不是这张票的」），块里没有任务行回 **400** `code:"report-missing-task"`——都不写指针。
- 同一 `requestId` 内允许改口，但后一次的 `seq` 必须**严格大于**前一次，两站都留在 `history`；不增回 **409** `code:"report-seq-not-increasing"`。
- 对方自报 `ready` 而投影此刻 `openStep` 有值或 `pendingCalls` 未闭合，桥拒绝挪站，回 **409** `code:"conflict"` 并给 `stage`（当前/目标）与 `live`（`liveState` / `openStep` / `pendingCalls` / `pendingCallIds`）两侧读数，指针文件字节不变。
- `accepted` / `voided` 是人工终局，必须带 `note`，不接受对方自报；`accepted` 可从 `reported_ready` 或 `delivered` 进（后者用于协议改五行前派出、正文里没有自己任务号汇报的票，人带 note 直接结单；`openStep` / `pendingCalls` 的 409 `conflict` 只否决自报 `ready`，不否决人结单）。
- 表外迁移回 **409** `code:"invalid-stage-transition"`；`acceptance` 作为可写字段回 **400**。

`acceptance` 与 `acceptedAt` 由 `stage` 派生：`acceptance` 恒等于 `stage === 'accepted' ? 'accepted' : 'pending'`，`acceptedAt` 取 `history` 中 `accepted` 那站的 `at`。既有记录读不到 `stage` 时按 `acceptance` 派生初始站（`accepted` → `accepted`，其余 → `delivered`），**不补写 `history`**。一条记录只要发生站点写入，这两个键就随那次落盘从文件里删掉，`stage` 与 `history` 是唯一的真相；只有从没被写过的既有记录还留着 `acceptance`，因为它是那条记录派生站的唯一来源。读路由不改文件，不会因为读了就顺手清键。30 天清理的判据是站在 `accepted` 或 `voided` 且终局时间超过 30 天。

### 成本读数（第二轮 `cost`）

每条在册票的 `cost` 把投影的 `tokenUsage.totals` 与 `contextPressure` 七个值**原样**透出：`uncachedInputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`surfaceTokens`、`contextWindow`、`pressureTokens`。不做单位换算、不做跨票聚合。这两行读不到或值为空时 `cost` 为 **`null`**，不返回 `0`，也不由别的字段推算——零消耗与读不到是两件事。`cost` 与 `liveState` 同一语义：投影在步边界落盘，读数滞后一拍，都不进指针文件。

`GET /x-session-bridge/health` 是免令牌的存活探测，返回
`{"ok":true,"controller":true,"list":"function","prompt":"function","sessions":"function","pointer":"function","status":"function","workspaceRegistry":"object","workspaceCount":4}` 这类诊断（不含 token、不列路径）。

`pointer` / `status` / `sessions` 三项是**对真实实现的探测**，不是字面量：

- `pointer`：指针文件可解析，且状态目录可写；
- `status`：投影缓存目录可列举（目录不存在算可用）；
- `sessions`：**每次调用都会真调一次 `controller.list`** 并校验返回的 `items` 是数组。

可用报 `"function"`；路由挂上了但实现坏了报 `"degraded: <原因>"`（宿主根本没有 `list` 时 `sessions` 仍是 `"undefined"`）。任何一项不是 `"function"`，先怀疑旧插件或存储坏了，再重启 DSH。`list` / `prompt` 不是 `"function"` 则说明宿主挂的是旧插件。

## 任务指针与状态端点（需求 1、2）

**指针文件**：`$DSH_HOME/plugin-data/dsh-session-bridge/pointers.json`（与 `bridge.json` 同级，0600）。由**调用方**写入，DSH 会话不写——语义记录仍以 `LEDGER.md` 为准，这里只存"谁在执行哪个任务"。

每条记录只有这些字段：`taskId`、`sessionId`、`mode`（read/write）、`requestId`、`note`、`createdAt`、`stage`、`history`。**没有 `cwd`**——目录由投影现算（缺陷 A）。`acceptance` / `acceptedAt` 是派生字段，不落盘；旧记录里可能残留，读取时以 `stage` 为准。

**刻意不落盘**：`liveState`（在跑 / 在等人 / 未知 / 空闲）、`cost`、`report`、`blank`、最后投递时间、权限档——这些每次现算（在等人还要回会话正文核实工具名，report 还要按 8 → 64 → 512 → 整份逐级放大、只认本票任务号的块）。可通过投影/正文算出的读数**一个都不写进文件**。

**保留期**：站在 `accepted` 或 `voided` 且终局时间超过 30 天的指针清理（在插件启动与写指针时扫一遍），不立即删除，便于回溯。

**状态判据**（只读 `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` 的 `record.rows`）：

| 状态 | 判据 |
| --- | --- |
| 在跑 | `sessionStats.openStep` 有值；或 `turnBoundary.openTurnStartSeq` 有值且 `lastStepBoundary.kind !== "end"`；或 `pendingCalls` 非空但对应的是普通工具 |
| 在等人 | `pendingCalls` 非空，且这些 callId 在**会话正文**里对应的 `tool/call.name` 是 `ask_user_question`（等你回答提问），或其 `approval/asked` 没有对应的 `approval/decided`（等你批准操作）。响应里的 `waitingKind` 取 `question` / `approval` |
| 未知 | `pendingCalls` 非空但正文找不到/读不了，或正文里没有这些 callId 的 `tool/call`；状态不猜，报 `unknown` 并在 `stateReason` 说明原因。**写派单同样不放行**——它不是空闲（见下） |
| 空闲 | 以上都不满足 |

`liveState` 在 `waiting` 与 `running` 同时成立时**判为 `waiting`**：被卡住的是人，调用方必须看到。`openStep`、`pendingCalls`、`pendingCallIds`（含 callId 与正文里的工具名）、`waitingKind`、`stateReason` 与边界字段都原样返回，不藏任何东西。

**`unknown` 计入占用（缺陷 F）**：`pendingCalls` 非空本身就说明有一口气没回来，正文读不到只是「证不出空闲」，不是空闲。所以判不出状态时与在跑、在等人同等对待：

- 同目录里状态未知的会话算占用：写派单回 **409** `code:"directory-busy"`，`occupants` 里那一条带 `state:"unknown"` 与 `stateReason`，**不带** `needsHuman`——不能把人叫去答一张可能不存在的卡；
- 目标会话自己状态未知：回 **409** `code:"session-unknown"`，`occupant` / `occupants` 同样带 `state:"unknown"` 与 `stateReason`，`hint` 指向「确认该会话状态或修好正文路径」，不投递；
- 只有**确定在等人**才给 `needsHuman`；在跑与未知都不提示答卡。

判据仍然只有一份：`/prompt` 读的是同一个派生函数算出的 `liveState`（`state` 为兼容别名），不另写一套 `pendingCalls` 判断。

**为什么不能只看投影**：`openStep` 跟的是模型这一口气有没有吐完，**工具执行期间它本来就是 `null`**——跑一条 `pwsh` 时投影同样是 `openStep:null` + `pendingCalls` 非空，只看这一对会把长命令误判成在等人（第二次实机差分：正文 seq 1115 就是那次 `pwsh` 调用）。所以只有 `pendingCalls` 非空时才回正文取工具名：正文按魔数 `28 b5 2f fd` 切 zstd 帧、逐帧解压、按换行拆记录（一帧不止一条）；工作目录桶从投影的 `workingDirectory` 对照取，取不到就报 `unknown`、不猜目录。其余状态不读正文，代价可控。

旧判据 `userQuestions.questions.active` **不承载 DSH 的选项提问卡**（实机差分：挂卡时 `active` 与 `settled` 都为空），已废弃，`questionsActive` 字段随之移除。投影在步边界落盘，`/status` 只是投影视图、滞后一个步。

`/status` **只读**：只读指针文件与投影缓存，不写任何东西；不碰浏览器 cookie，不自拼宿主 `/api` 请求，除桥自己的 token 外不走任何通道。报告 `waiting` 时，调用方只把它转达给人，**不代替人回答 DSH 提出的问题**。

## 返回码

| 码 | 含义 |
| --- | --- |
| 200 | 会话已创建（且已记账）/ 已补挂 / 已投递 / 指针已写 / 状态已返回 |
| 400 | body 不是 JSON；`cwd` 与 `workspaceId` 都没给；`prompt` 缺读写声明（`access`，或 `mode` 取 `read`/`write`）；`pointer` 缺 `taskId`/`sessionId`/`mode` 或字段不合规；**第二轮**：`acceptance` 不再是可写字段、`seq` 只配 `reported_*`、`reported_*` 缺 `seq`、写 `accepted`/`voided` 缺 `note`、汇报 `seq` 与正文对不上（`code:"report-unverified"`）；**第三轮（缺陷 I）**：块里的 `任务:` 不是这张票（`code:"report-task-mismatch"`）、块里没有任务行（`code:"report-missing-task"`） |
| 401 | 令牌缺失/不匹配 |
| 403 | Host 不是 loopback |
| 404 | 指定的 `workspaceId` 不存在（attach 时也可能是该目录没有工作区） |
| 405 | 非 POST |
| 409 | 目录未注册成工作区且 `createWorkspace:false`；**写派单被单写者拦截**（`directory-busy`，占用者在跑、在等人或状态未知——状态未知那条带 `stateReason` 且不给 `needsHuman`；在等人另带 `needsHuman`/`hint`）；**目标会话自己在等人**（`session-waiting`）；**目标会话自己状态未知**（`session-unknown`，带 `stateReason` 与修正文路径的 `hint`）；**任务号已绑定别的会话**（`task-bound`，带 `boundSessionId`）；**第二轮**：表外迁移（`invalid-stage-transition`）、同一 requestId 内 `seq` 不增的改口（`report-seq-not-increasing`）、自报 `ready` 但投影仍在跑/在等人（`conflict`，带 `stage` 与 `live` 两侧读数）。这些都不投递/不写指针 |
| 500 | 宿主侧失败（预设 id 不存在、cwd 不存在、attach 校验不通过、prompt 被宿主拒绝等，原因原样返回）；`pointers.json` 损坏时也回 500，且**不覆盖**原文件 |
| 503 | 宿主缺少 `sessionController` / `workspaceRegistry`，或未暴露 `list` / `prompt`（版本不匹配）；**写派单的单写者检查无法运行**（`projection-store-unavailable`，带 `reason`，**不投递**） |

**已知限制（投影损坏）**：投影文件存在但解析不出来（`corrupt`）的会话，既进不了 `activePeers`（连它在哪个工作目录都不知道），也拦不住写派单。它的投影里没有 `pendingCalls` 这种正面证据，判它占用是猜，所以**没有** fail-closed；调用方需自行确认该会话状态。

`sessions` / `prompt` / `pointer` / `status` 用同一套 loopback / Bearer / 400 / 401 / 403 / 405 门；`sessions` 在 `cwd` 或 `workspaceId` 对不上任何工作区时回 404。

## 端口

**端口每次启动都会变**。任何写死的端口都是错的：用 `--dry-run` 拿 `url` / `healthUrl`，它不会打印 token。

## 自测

仓库内自带离线自测，不需要宿主在线，也不依赖第三方包：

```bat
node test/selftest.mjs
```

覆盖（167 条断言）：`deriveState` 的三态与 `unknown`（假投影 + 假正文）、正文 zstd 切帧（多帧、一帧多条记录）、`/pointer` 的任务号绑定与 400/409 分支、`activePeers` 的分组与跳过规则、**第二轮** `report` 三态与缓存、`stage` 迁移表与 seq 复核/`conflict`、缺失 `acceptance`/`stage` 的既有记录派生、30 天清理、`cost` 七字段与缺行 `null`、**缺陷 H** 的扫描窗口逐级放大与命中即停、扫描帧数/字节数回出、三类 `stateReason` 字节级不同、`unreported` 只在整份读完时出现、`unknown` 不进缓存且正文还原后立刻给出正确读数、**缺陷 I/J** 的票级认领（同会话两票各取各的块）、任务号不符与缺任务行的 400 错误码、行中关键字不抢锚点、锚点行冒号后带话判 invalid、最新块缺任务行不回退旧块，**结单直通**（`delivered` 带 note 直接 `accepted`、缺 note 拒写、结单后补报撞表外、`reported_blocked` 到 `accepted` 仍拒），以及 CLI 参数校验。失败时打印挂掉的条目并以非零码退出，全过打印总数。夹具建在系统临时目录、跑完删除；不写仓库、不碰真宿主。

**不覆盖**（需真桥在线，重启后人工实调）：写派单 409 实调、`/health` 真探针、投递排队、`projection-store-unavailable` 503。
