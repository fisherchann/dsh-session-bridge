# 给 Qoder（外部工具）的使用说明

本文件是 `dsh-session-bridge` 的完整参考手册。Qoder 侧的 skill 在 `skills/dsh-session/SKILL.md`，装成 Qoder 插件后由它引导日常使用。

## 1. 它做什么

在正在运行的 DSH 桌面版 GUI 里管会话生命周期，走的是 GUI 新建会话按钮的同一条宿主通路：建会话并挂进工作区名册、查某个工作区已有哪些会话（含侧栏还没画出来的空会话）、往指定会话投第一条消息、把孤儿会话补挂回名册，并记下「任务号 → 会话」的指针、一次调用读出所有在册任务的状态。

**关键区别，别记错**：建会话只保证它进了工作区名册；侧栏不会画出一个从没跑过轮次的会话（原因见第 5 节）。所以要让人看见，得再投一条消息。

**不做什么**：不切窗口、不返回对话框内容、不替你验收、不代替人回答 DSH 提出的问题。

## 2. 先决条件

1. DSH 桌面版正在运行，且已加载 `dsh-session-bridge`（profile 的 `dsh.profile.bundles` 里有它）；
2. 用 `--dry-run` 拿地址（**不要 `cat` `bridge.json`** —— token 会跟着 url 一起进聊天/日志）：

```bat
node bin/dsh-session.mjs --cwd "D:\work\demo" --dry-run
```

输出里取 `healthUrl` 探活：

```bat
curl -s "<healthUrl>"
```

期望：`{"ok":true,"name":"session-bridge","controller":true,"list":"function","prompt":"function","sessions":"function","pointer":"function","status":"function","workspaceRegistry":"object","workspaceCount":4}`。

- `controller:true` 才有 `create`；
- `list` 与 `prompt` 必须是 `"function"`。这两个字段缺失或不等于 `"function"`，说明宿主还挂着旧版插件；**改过 `lib/index.js` 之后必须重启 DSH 才生效**，插件在宿主启动时挂载，没有热加载；
- `pointer` / `status` / `sessions` 是**真实探测**，不是字面量：`pointer` 探「指针文件可解析 + 状态目录可写」，`status` 探「投影缓存目录可列举」，`sessions` **每次都会真调一次 `controller.list`** 并校验 `items` 是数组。实现可用报 `"function"`，路由挂上了但实现坏了报 `"degraded: <原因>"`；只有旧插件才会在这三项上写死 `"function"`；
- `workspaceRegistry:"object"` 表示宿主有工作区模型（有它才会记账）。

端口每次启动都会变，**任何写死的端口都是错的**，一律用 `--dry-run` 取 `url`。

## 3. 先查，再决定复用还是新建

```bat
node bin/dsh-session.mjs --sessions --cwd "D:\work\demo"
```

返回 `{"ok":true,"workspaceId":"…","workspaceTitle":"demo","count":9,"blankCount":2,"sessions":[{"sessionId":"session-…","blank":true,"running":false,"title":null,"cwd":"D:\\work\\demo","updatedAt":1762268871000,"origin":null}]}`。

若 `count` 是 0 而名册里明明有会话，先看 `health` 里的 `list` 是否为 `"function"`：不是就是旧宿主；是的话说明宿主内核的会话摘要字段名与桥不匹配（0.2.x 用 `sessionId`，0.1.x 用 `id`，当前版本两者都认）。

判据只有一条：有 `blank:true` 且档位合适（第 8 节）就用 `--send` 续用它，没有可复用的才新建。攒下一堆空会话有害 —— 它们占着名册、侧栏不画、除了点开这个工作区之外没法被碰到。

## 4. 建会话 / 投消息

建：

```bat
node bin/dsh-session.mjs --cwd "D:\work\demo" --preset code-review
```

返回：

```json
{ "status": 200, "ok": true, "sessionId": "session-…", "cwd": "D:\\work\\demo",
  "agentPreset": "code-review", "workspaceId": "37776011-…", "workspaceCreated": false,
  "attached": true, "guiUrl": "http://127.0.0.1:<端口>" }
```

判断标准（三条一起看）：

| 字段 | 期望 | 含义 |
| --- | --- | --- |
| `ok` / `status` | `true` / `200` | 会话建出来了 |
| `workspaceId` | 非空 | 已经落到某个工作区 |
| `attached` | `true` | 已进该工作区名册，**不等于侧栏可见**（见第 6 节） |

`attached:false` 时会有 `attachError`：会话已创建但没挂上（例如目录不存在），先修目录再用 `--attach` 补挂。

投第一条消息：

```bat
node bin/dsh-session.mjs --send "session-…" --text "先读 README，再列风险" --access read
```

返回 `{"status":200,"ok":true,"sessionId":"session-…","requestId":"8c1e…","access":"read"}`。成功后这一行才在侧栏显形。投递按 `requestId` 幂等：要重试就带上同一个 `--request-id`，宿主只收一次，不会跑两轮。

**`--send` 现在必须带 `--access read|write`**：声明这次派单是只读还是写。不带时 CLI 直接退出 2；就算绕过 CLI，桥也回 400 且**不投递**。`--mode queue|steer` 只是投递通道，不能代替 `--access`。

写派单（`--access write`）还有并发拦截：目标会话自己、或同工作目录的别的会话处于**在跑、在等人、或状态判不出来（`unknown`）**时回 409、不投递（详见第 9 节）。只读派单不受限；向正在跑的同一会话追问/纠偏也不受限。

## 5. 记指针与查状态（需求 1、2）

派完活必须把「任务号 → 会话」记下来，否则事后不知道这个会话去了哪、是在跑还是在等人。

`--send` 带 `--task`，投完顺手记（复用宿主返回的 `requestId`）：

```bat
node bin/dsh-session.mjs --send "session-…" --text "只读检查：列风险" --task task-6 --access read
```

也可以单独记 / 刷新：

```bat
node bin/dsh-session.mjs --pointer --task task-6 --session "session-…" --access read --request-id <uuid>
```

人验收之后标一下（`accepted` 是人工终局，**必须带 `--note`**；`--void` 同理）：

```bat
node bin/dsh-session.mjs --accept --task task-6 --session "session-…" --note "复核通过"
node bin/dsh-session.mjs --void --task task-6 --session "session-…" --note "需求已撤"
```

对方按协议回报之后，把票挪到对应站（`--seq` 是对方正文里锚点记录的 seq，桥会回正文复核）：

```bat
node bin/dsh-session.mjs --pointer --task task-6 --session "session-…" --stage reported_ready --seq 1234
```

一次查所有在册任务的状态：

```bat
node bin/dsh-session.mjs --status --cwd "D:\work\demo"
```

每条返回里：

| 字段 | 含义 |
| --- | --- |
| `liveState` | `running` 在跑 / `waiting` 在等人 / `idle` 空闲 / `unknown` 无投影或判不出来（看 `stateReason`）；`state` 是上一轮的兼容别名，值相同 |
| `stage` | 票停在哪一站：`delivered`、`reported_ready/blocked/failed/dropped`、`accepted`、`voided`；与 `liveState` 并列，**不进 history** |
| `history` | 只追加：`{stage, at, evidence}`，证据为 `report`（seq）/ `human`（note）/ `redeliver`（requestId） |
| `report` | `{state, taskId, seq, missing, reason, lines, stateReason, scannedFrames, scannedBytes, bodyFrames, bodyBytes, fromCache}`：**这张票自己**那条汇报（按块里的 `任务:` 认领）。没有本票的块 `state=unreported`（**只在整份正文读完时**）；缺行/坏词/锚点行带话 `state=invalid` 并给 `missing`；正文取不到 `state=unknown` 并给 `stateReason` |
| `cost` | `uncachedInputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`surfaceTokens`、`contextWindow`、`pressureTokens` 原样透出；读不到为 `null`，不是 0 |
| `openStep` | 当前打开的步骤（对象或 `null`）；它非空只说明模型还在吐字，不是等人判据 |
| `pendingCalls` | 在飞工具调用数（按 callId 计） |
| `pendingCallIds` | 未返回的 callId 及它们在会话正文里的工具名；等人判定就看这个 |
| `waitingKind` | `question` 等你回答提问（`ask_user_question`）/ `approval` 等你批准操作（`approval/asked` 未 decided）/ `null` |
| `stateReason` | `liveState = unknown` 时的原因（如正文缺失、正文里没有该 callId 的 `tool/call`） |
| `blank` / `lastPromptAt` / `permissions` | 从投影缓存现读，**不落盘** |
| `sessionCwd` | 会话真实工作目录，取自投影的 `workingDirectory`；筛选/分组都用它 |
| `acceptance` | **由 `stage` 派生**：`stage === 'accepted'` 才是 `accepted`，其余是 `pending`；不再是可写字段 |
| `acceptedAt` | `history` 中 `accepted` 那站的 `at`（旧记录回退到旧的 `acceptedAt`） |

判据（投影 + 只在 `pendingCalls` 非空时回一次会话正文）：

- **在跑**：`sessionStats.openStep` 有值；或 `turnBoundary.openTurnStartSeq` 有值且 `lastStepBoundary.kind !== "end"`；或 `pendingCalls` 非空但对应的是普通工具；
- **在等人**：`pendingCalls` 非空，且这些 callId 在正文的 `tool/call.name` 是 `ask_user_question`，或其 `approval/asked` 没有 `approval/decided`；
- **未知**：`pendingCalls` 非空但正文找不到/读不了、或正文里没有该 callId —— 报 `unknown` + `stateReason`，不猜；**写派单也不放行**：目标会话自己未知回 409 `session-unknown`，同目录的未知会话计入占用（`directory-busy`，`occupants` 带 `state:"unknown"` 与 `stateReason`，**不给** `needsHuman`——不提示去答一张可能不存在的卡）；
- **空闲**：以上都不满足。

**别只看投影判等人**：工具执行期间 `openStep` 本来就是 `null`，`openStep:null` + `pendingCalls` 非空在跑 `pwsh` 长命令时同样出现（正文 seq 1115 就是实证）；名字必须从正文取（`28 b5 2f fd` 切帧、逐帧解压、按换行拆记录）。投影在步边界落盘，`--status` 是投影视图、**滞后一个步**，响应里的 `staleness` 写着这句。

旧判据 `userQuestions.questions.active` **不承载选项提问卡**（实机挂卡时 `active`/`settled` 都空），已废弃，`questionsActive` 字段也移除了——现在只看投影，且仅在 `pendingCalls` 非空时回正文取工具名。

**第二轮的汇报与站**：任务书末尾要求对方只回五行块（`汇报状态` / `任务` / `结论` / `凭据` / `前置`），每行从行首写起。`report` 是**票级**读数（缺陷 I）：一个会话常同时挂着几张票，会话里最近一条汇报属于谁只能由块里的 `任务:` 说了算——从正文**末尾向前逐级放大**（先 8 帧，再 64、512 帧，最后整份，**命中即停**）扫第一个 `任务:` 与本票任务号逐字相等的块；别的票的块跳过。没有本票的块才叫 `unreported`（不拿会话里最近那条顶替）；缺 `任务:` 行的块判 `invalid` 并点名 `任务`，最新一个块缺任务行也判 `invalid`、不回退到更老的块。锚点与标签还必须**行首**（缺陷 J）：`汇报状态` 前面只允许空白 / `>` / 围栏与强调符，冒号后除空白与强调符外还有别的文字就判 `invalid`，所以 `凭据:` 行里整段引用旧汇报（含 `汇报状态: …`）不会抢走真锚点。整份读完仍无本票的块才是 `unreported`；缺行/坏词 `invalid`（`missing` 点名缺哪行）；正文定位不到 / 某一帧解压失败（更新的帧读不出，更新的汇报不能被排除）/ 超过 16 MiB 扫描上限读不满，一律 `unknown` + `stateReason`，**不猜**，三种原因字节级不同。`unknown` 不进缓存：正文修好后下一次 `--status` 就给出正确读数，不需要重启。响应里的 `taskId` 是块里写的任务号，`scannedFrames`/`scannedBytes` 是本次真扫了多少（命中缓存为 0），`bodyFrames`/`bodyBytes` 是整份正文多大。历史四行汇报（seq 2963 / 3640）不回改正文，已落的站留在 `history` 里。

票的 `stage` 只由证据推进：`reported_*` 必须带 `seq` 且桥回正文复核同一状态词**和同一任务号**（块里写别票回 **400 `report-task-mismatch`**，没有任务行回 **400 `report-missing-task`**，都不写指针）；同一 `requestId` 改口要 `seq` 严格增；自报 `ready` 而投影仍 `openStep` 有值或 `pendingCalls` 未闭合回 **409 `conflict`**（给两侧读数、不写文件）；`accepted` / `voided` 必须带 `note`，只能人写；表外迁移回 **409 `invalid-stage-transition`**。`cost` 七字段与 `liveState` 都是现读、滞后一个步，和 `report` 一样**不落盘**。

几条纪律：

1. `liveState = waiting` 时，**只把它转达给人，不代替人回答** DSH 提出的问题；此时向该会话投写派单会被 409 挡住（`needsHuman` + `hint`），别绕过——排队消息在答卡前不会跑；
2. 指针文件只存人知道/证据性的东西（任务号、会话 id、读写性质、requestId、`stage`、`history`、note）；**目录不落盘**——筛选与分组一律取投影的 `workingDirectory`，请求里带 `cwd` 会被忽略。`liveState`、`cost`、`report`、`blank`、最后投递时间、权限档一律现算；终局站（`accepted`/`voided`）满 30 天自动清理，不立即删除；
3. **任务号是唯一键**：同一个任务号投到另一个会话会回 409 `task-bound` 并给出 `boundSessionId`。先决定是复用已绑定的会话，还是换一个任务号——别拿新会话重试。
4. **别把 `unknown` 当空闲**（缺陷 F）：`pendingCalls` 非空但正文读不到时，那会话不是「闲」，是「证不出闲」——写派单会被 409 挡住。先确认它是真的空闲，还是正文路径坏了；不要绕过拦截，也不要把排队消息当成已送达。
5. **站与现场状态不是一回事**：`stage` 是票走到哪一站，`liveState` 是此刻在不在跑/等；别拿 `liveState` 推站，也别把站当实时读数。挪站按迁移表与证据规则走，不要手改 `pointers.json`。

## 6. 参数

| 参数 | 说明 |
| --- | --- |
| `--cwd <dir>` | 工作目录（缺省 = 当前目录；接受 `/d/...`） |
| `--preset <id>` | agent preset（`code-review` = 代码审查模式） |
| `--workspace <id>` | 显式指定工作区（一般不用，按 cwd 自动解析） |
| `--no-create-workspace` | 该目录未注册成工作区时报 409，不自动注册 |
| `--sessions` | 列会话，带 `blank` 标记；配 `--cwd` 或 `--workspace` 只列该名册内的 |
| `--send <sessionId>` | 往该会话投消息，必须配 `--text` 与 `--access` |
| `--text "<msg>"` | 消息正文 |
| `--mode queue\|steer` | 缺省 `queue`；`steer` 是往正在跑的一轮里插话。**只是投递通道，不是读写声明** |
| `--request-id <uuid>` | 显式幂等 id，重试时传同一个 |
| `--task <id>` | 任务号（任务书首行，如 `task-6`）；配 `--pointer`/`--accept`/`--void`/`--send` |
| `--access read\|write` | **派单的读写性质，`--send` 必填、`--pointer` 新建/刷新时必填**；缺了 CLI 退出 2，桥也不会猜 |
| `--stage <stage>` | 把票挪到七站之一；`reported_*` 还要配 `--seq` |
| `--seq <n>` | 汇报锚点记录的 seq（`--stage reported_*` 必填，桥回正文复核） |
| `--session <sessionId>` | 指针指向的会话（`--pointer`/`--accept`/`--void` 用） |
| `--pointer` | 写/刷新指针；挪站用 `--stage` |
| `--accept` | 人工终局：标成 `accepted`（**必须带 `--note`**） |
| `--void` | 人工终局：标成 `voided`（**必须带 `--note`**） |
| `--note "<text>"` | 人工终局结论/备注（≤500 字）；`--accept`/`--void` 必填 |
| `--status` | 查所有在册任务的状态；可配 `--task`/`--session`/`--cwd` |
| `--attach <sessionId>` | 把已存在的会话补挂到工作区（修复孤儿） |
| `--create-workspace` | 配合 `--attach`，允许为孤儿会话目录新建工作区 |
| `--dry-run` | 只打印将要 POST 的内容，不发请求，**不打印 token** |

## 7. 会话出现在哪，看不见是怎么回事

侧栏的过滤规则在 `packages/client/ui-workspace/src/client/tree.ts`：

```ts
session.origin !== 'subagent' && !archived.has(session.id) && (!session.blank || session.id === current)
```

`blank` 只在收到 `turn/start` 时清零（`packages/api/session-controller/src/list.ts`）。于是：

- 桥建出来的会话**在册、在磁盘、但侧栏不画** —— 这是客户端规则，不是插件记账失败；
- GUI 那个新建会话按钮的产物看得见，是因为它随后走 `connectWorkspace` → `replaceMain`，顺手把空会话设成了当前会话；
- 两条显形的路：在 GUI 里点开该工作区分组（会复用该路径下第一个空会话），或者 `--send` 投一条消息把 `blank` 清掉，此后永久可见。

已打开的页面刷新一次再看（列表变更走 `api-session/added` 推送，但空会话仍受上面那条规则约束）。

## 8. 权限档（投消息之前先看这一行）

档位落在 `%DSH_HOME%\storages\session_projcache\sessions\<sessionId>.json` 的 `record.rows.sandboxMode.val` 与 `record.rows.permissions.val`；`--status` 的 `permissions` 字段就是它的现值。

- 可以直投：`sandboxMode = workspace-write` 且 `permissions.approval = ask`，越出工作区的写删仍要人点头；
- 先跟用户确认再投：`danger-full-access`，或 `approval` 不是 `ask`。

越出工作区的写删靠的是 `sandbox: danger-full-access` 加 `permissions.preset: auto` 这一档。风险不在桥，在会话被中途升档 —— 每次接手一个跑了很久的会话，先读这两个字段。

## 9. 排错

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| CLI 退出码 2 | 没有 `bridge.json` | 启动一次带插件的 DSH |
| CLI 退出码 3 | 连不上 `url`（DSH 没开 / 旧端口） | 重跑 `--dry-run` 拿新地址 |
| `--pointer/--accept/--void need --task` | 少传任务号 | 补 `--task task-N` |
| `--pointer needs --access read\|write or --stage` | 少传读写性质，也没给 `--stage` | 新建/刷新补 `--access`；挪站补 `--stage`（+`--seq`） |
| `--accept/--void need --note` | 人工终局没给结论 | 补 `--note "<结论>"`；桥不接受对方自报终局 |
| `--stage reported_* needs --seq` | 挪到汇报站没带 seq | 从对方正文锚点记录取 seq 补上 |
| 401 | 令牌不匹配 | 重跑 CLI（每次读最新 `bridge.json`） |
| 403 | Host 不是 loopback | 用 `127.0.0.1` / `localhost` |
| 404 | 插件没挂载；`--workspace` 的 id 不存在；或 `--sessions` 的 cwd 对不上任何工作区 | 查 `dsh.profile.bundles` / 改用 cwd 方式 |
| `--send needs --access read\|write` | `--send` 没带读写性质，CLI 直接退出 2 | 补 `--access read` 或 `write` |
| 409 `directory-busy` | 同工作目录已有别的会话在跑、在等人，或状态未知（写派单被单写者拦住） | 看 `occupant.sessionId` / `state`；`state:"unknown"` 那条带 `stateReason`（正文读不到，判不定）且**没有** `needsHuman`——先确认它空闲或修好正文路径；在等人时按 `hint` 到 GUI 答卡 |
| 409 `session-waiting` | 目标会话自己正挂着选项提问卡 | 到 GUI 答卡后再投；桥不代答，排队消息在答卡前不会跑 |
| 409 `session-unknown` | 目标会话自己有未返回调用，但会话正文读不到或对不上，判不出在跑还是等卡——**不等于空闲** | 看 `occupant.stateReason` 与 `hint`：确认该会话状态，或修好正文路径（`%DSH_HOME%\sessions\<工作目录编码>\<sessionId>\session.v4.jsonl.zstd`）后重试 |
| 409 `task-bound` | 任务号已绑定别的会话 | 响应里的 `boundSessionId` 是已绑定会话；复用那个会话，或换任务号 |
| 409 `invalid-stage-transition` | 想走的站不在迁移表里（例如 `reported_blocked` 直接到 `accepted`） | 看响应里的 `stage.current` / `stage.target`；`accepted` 只能从 `reported_ready` 或 `delivered` 进，其余先按第 5 节的证据规则逐站走 |
| 409 `report-seq-not-increasing` | 同一 requestId 内改口，但后一次汇报的 seq 不比前一次大 | 用最新一条汇报的 seq；桥只接受严格增，两次都留 `history` |
| 409 `conflict` | 对方自报 `ready`，但投影此刻 `openStep` 有值或 `pendingCalls` 未闭合 | 看 `live` 两侧读数；等它真的收工再挪站，不要猜 |
| 400 `report-unverified` | 给的 seq 处正文解析不出同一个状态词（seq 错、正文变了、或该记录不是汇报） | 重新读对方正文锚点的 seq；对不上就不挪站 |
| 400 `report-task-mismatch` | 给的 seq 处那个块 `任务:` 写的是别的票（缺陷 I：汇报认领到票） | 换成块里 `任务:` 等于本票的 seq；报错里会写明块指名了谁 |
| 400 `report-missing-task` | 给的 seq 处那个块没有 `任务:` 行（例如上一轮的四行历史汇报） | 让本票按五行协议重报一次再挪站；历史四行块不回改正文 |
| 400 `acceptance is derived from stage` | 还在按上一轮写法传 `acceptance` | 改用 `--accept`/`--void`（带 note）或 `--stage` |
| 409（建会话时） | 目录未注册成工作区，且带 `--no-create-workspace` | 去掉该参数，或先在 GUI「添加工作区」 |
| 400 `mode is required` | 绕过 CLI 直接 POST，没带 `access`（也没用 `mode:read\|write`） | 补读写声明；桥不猜 |
| 503 `projection-store-unavailable` | 写派单的单写者检查跑不了（投影目录列不出来 / 该会话投影读不了），带 `reason`，**不投递** | 查 `%DSH_HOME%\storages\session_projcache` 是否可读；修好后重试 |
| 503 | 宿主没有 `sessionController` / `workspaceRegistry`，或未暴露 `list` / `prompt` | 看 health 字段；报给维护者 |
| 改完 `lib/index.js` 行为没变 | 宿主没重启，旧实现还在跑 | 重启 DSH；插件在宿主启动时挂载，没有热加载 |
| 500 `cwd does not resolve` | 目录不存在 | 先建目录 |
| 500 `Unknown agent preset: <id>` | 该 DSH 没声明这个预设 | 去掉 `--preset` |
| 500 `its cwd resolves to '<另一个路径>'` | `--attach` 的会话不属于该工作区 | 用会话自己的 cwd 补挂 |
| 500 `its stored header carries no cwd` | 会话头没记 cwd（很老的会话） | 无法补挂，删除即可 |
| 500 `prompt content must include…` | `--send` 的 `--text` 只有空白 | 给正文 |
| 500 `pointers.json is not valid JSON` | 指针文件被人手改坏 | 修好或删掉该文件（桥**不会**覆盖它） |
| `liveState = unknown` | 没有投影缓存（新会话），或有未返回调用但正文读不到/对不上（看 `stateReason`） | 无投影：先投一条消息让它跑起来；有未返回调用：确认会话状态或修好正文路径，别指望写派单放行 |
| `report = unreported` | 整份正文都扫过、没有**本票任务号**的块（`scannedFrames === bodyFrames`） | 别把沉默当成功，也别拿会话里最近那条顶替；要求对方按五行块（含 `任务:`）回报，或人工核正文 |
| `report = unknown` | 正文取不到：定位不到 / 某一帧解压失败（更新的帧读不出）/ 正文超过 16 MiB 扫描上限没读满——看 `stateReason` | 修好正文路径或文件后**再调一次**即可（`unknown` 不进缓存，不需要重启宿主）；别把 `unknown` 当成「没汇报」 |
| `report = invalid` | 有锚点但缺 `任务`/`结论`/`凭据`/blocked 的 `前置`，状态词不在四个之内，或锚点行冒号后还有别的话 | 看 `missing` / `reason`；让对方按五行协议补齐重报，不要就近猜一个状态词 |
| 投影文件损坏（解析不出来） | 该会话进不了 `activePeers`，写派单也拦不住——已知限制，不判占用（没有 `pendingCalls` 正面证据） | 修好或删掉该投影文件；不确定时先问人，别把它当空闲 |
| `--send` 返回 200 但侧栏还是没这一行 | 宿主挂的是旧插件（`health` 里 `prompt` 不是 `function`） | 重启 DSH |
| 503 | 宿主没有 `sessionController` / `workspaceRegistry`，或未暴露 `list` / `prompt` | 看 health 字段；报给维护者 |

改完桥代码先跑仓库内离线自测 `node test/selftest.mjs`（不需要宿主在线；失败会打印条目并非零退出），再重启 DSH 做真桥实调。

## 10. 安全

- 只走 bridge 的 url + bearer；不要自己拼 `/api`、不要碰浏览器 cookie、不要试 `/connect`。
- token 是 0600 文件，别贴进聊天/日志/提交；要地址用 `--dry-run`。
- 建会话与投消息都消耗用户额度；批量操作前先确认。
- 投消息前先核档位（第 8 节）；DSH 跑出来的东西仍要人验收，不整段交出去不管。
- 想临时关闭：把 profile 的 `dsh.profile.bundles` 里的 `dsh-session-bridge` 去掉并重启。
