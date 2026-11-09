---
name: dsh-session
description: 在本机 DeepSeek Harness（DSH）桌面版里管会话与派单：查工作区已有会话、新建会话、投第一条消息让它在侧栏显形、按任务号记票与挪站、一次读回现场状态与成本，并处置桥的 401/403/404/405/409/503。当用户说在 DSH 里开个会话、把这个任务交给 DSH 做、让 DSH 接着这个会话继续、用 DSH 的代码审查模式看这个仓库、查 DSH 那边跑到哪了、验收或作废一张 DSH 票时使用。
---

# DSH 会话桥

把当前工作交给本机 DSH 桌面版里的一个会话去做，人在 GUI 里把关。桥能建会话、投消息、记票、读状态；跑成什么样仍要人验收。

**不要用**：需要无人值守跑完整条链路并取回结果时。这个 skill 不返回对话框内容，也不代替人回答 DSH 提出的问题。

## 前置条件

1. DSH 桌面版正在运行；
2. 桥已挂进 DSH 的 profile（`dsh.profile.bundles` 里有 `dsh-session-bridge`）。插件在宿主启动时挂载，**改过代码或刚装完必须重启 DSH**，没有热加载。

两条都满足才往下走。探活：

```sh
curl -s "$HEALTH_URL"
```

期望 `ok:true`、`controller:true`，且 `list`、`prompt`、`sessions`、`pointer`、`status` 都是 `"function"`。这几项是真实探测：实现坏了会报 `degraded: <原因>`，只有旧版插件才写死字面量。少了任何一项就是宿主挂着旧插件，重启 DSH。

## 找到 CLI

CLI 随插件一起装，位置相对本 skill 的基目录固定：加载 skill 时公布的 base directory 往上两级再进 `bin`。

```sh
BRIDGE="<base directory>/../../bin/dsh-session.mjs"
node "$BRIDGE" --dry-run --cwd "$PWD"
```

一律用 `node` 直接跑 `.mjs`，跨平台，也绕开 Git Bash 里双层引号包 `.cmd` 会把引号吃进路径的坑。

`--dry-run` 不发请求、**不打印 token**，输出里取 `url` 与 `healthUrl`。**端口每次启动都会变，任何写死的端口都是错的。** 也不要 `cat` `bridge.json`：token 会跟着 url 一起进聊天和日志。

## 先查，再决定复用还是新建

```sh
node "$BRIDGE" --sessions --cwd "$PWD"
```

返回该工作区名册里的会话，带 `blank` 标记。判据只有一条：有 `blank:true` 且档位合适就 `--send` 续用它，没有可复用的才新建。攒下一堆空会话有害——它们占着名册、侧栏不画、除了点开这个工作区之外没法被碰到。

`count` 是 0 而名册里明明有会话：先看 health 的 `list` 是不是 `"function"`，不是就是旧宿主。

## 建会话与投消息

```sh
node "$BRIDGE" --cwd "$PWD" --preset code-review
```

`--preset code-review` 是代码审查模式，不传就用该 DSH 的默认预设。建会话本身不花额度、不会自己开工。

**建完侧栏看不见是正常的**：DSH 只画跑过轮次的会话，`blank` 要收到 `turn/start` 才清零。投第一条消息才让它永久显形：

```sh
node "$BRIDGE" --send "$SID" --text "先读 README，再列风险" --access read
```

`SID` 取上一步输出里的 `sessionId`。`--access` **必填**，声明本次派单是只读还是要写；缺了 CLI 直接退出 2，桥也不会猜。`--mode steer` 是往正在跑的一轮里插话，它只是投递通道，不是读写声明。

同一句话重复投不会跑两轮：宿主按 `requestId` 幂等收单，重试时传同一个 `--request-id`。

## 派单前先核权限档

**顺序不能反**：先记票，再读档位，合适才投递。

```sh
node "$BRIDGE" --pointer --task task-6 --session "$SID" --access read
node "$BRIDGE" --status --task task-6
```

`--status` 的每条指针都带 `permissions`（`preset` / `sandbox` / `approval`）与 `agentPreset`。判据只有一条：**`sandbox: workspace-write` 且 `approval: ask` 才算有人把关**，可以直接投。只要是 `danger-full-access`，或 `approval` 不是 `ask`，先跟用户确认再投——越出工作区的写删靠的就是这一档，风险不在桥，在会话中途被升档。接手一个跑了很久的会话尤其要先读这两个字段。

桥新建的会话默认就是 `workspace-write` + `ask`。

## 票与汇报

`--send` 带 `--task` 可以投递加记票一次完成：

```sh
node "$BRIDGE" --send "$SID" --text "只读检查：列风险" --task task-6 --access read
```

票有七站：`delivered`、`reported_ready`、`reported_blocked`、`reported_failed`、`reported_dropped`、`accepted`、`voided`。`stage` 加 append-only 的 `history` 是唯一真相。

派单正文里要求对方按五行汇报，锚点与标签都必须**行首**：

```
汇报状态: ready
任务: task-6
结论: 一句话说清做完了什么
凭据: 跑了哪条命令、看了哪个文件、结果是什么
前置: 无
```

状态词取 `ready` / `blocked` / `failed` / `dropped`，冒号之后除空白与强调符外不能有别的话。`任务` 的值必须与票号逐字相等——票只认喊自己名字的那条汇报，认不出主人就不算任何一张票的结论。`前置` 只有 blocked 才填，写明卡在哪个条件、需要谁做什么。

对方汇报后挪站，`--seq` 是汇报在会话正文里的记录 seq，桥会回正文复核这个 seq 的状态词：

```sh
node "$BRIDGE" --pointer --task task-6 --session "$SID" --stage reported_ready --seq 1234
```

人工终局必须带 note：

```sh
node "$BRIDGE" --accept --task task-6 --session "$SID" --note "复核通过：自测 167 条全过，独立夹具复跑一致"
node "$BRIDGE" --void --task task-6 --session "$SID" --note "需求已撤"
```

`accepted` 可以从 `reported_ready` 进，也可以从 `delivered` 直接进——人核对后带 note 结单，不必等对方按协议回话。状态判据只否决对方的自报 `ready`，不否决人工终局。

## 状态怎么读

```sh
node "$BRIDGE" --status
node "$BRIDGE" --status --cwd "$PWD"
```

一次读回所有在册票的现场状态、阶段、汇报与成本。`liveState` 取 `running` / `waiting` / `idle` / `unknown`，`waitingKind` 区分 `question`（等你回答提问）与 `approval`（等你批准操作）。

**不要自己去撕投影文件和 zstd 正文**，桥已经读完了。三条要知道的语义：

- 投影在步边界落盘，步内不刷新，读到的状态最多滞后一个步；长命令跑到一半时别据此判定没在跑。
- `unknown` 不是 `idle`。状态读不出来时桥会附 `stateReason`，写派单会被单写者拦住；按原因处置，不要猜。
- 往挂着提问卡的会话投消息不会答卡，消息只排进下一轮的收件箱，卡片照挂而调用方拿到 200。答卡要人到 GUI 里点。

汇报读数是票级的：`report.state` 取 `ready` / `blocked` / `failed` / `dropped` / `unreported` / `invalid` / `unknown`，三者不合并——`unreported` 是整份正文读完都没找到认领本票的块，`invalid` 是找到了但格式不合协议，`unknown` 是正文读不出来。

## 错误码与处置

| 现象 | 含义 | 处置 |
| --- | --- | --- |
| 退出码 2 | CLI 参数不全，或读不到 `bridge.json` | 补参数；读不到就是插件没装或 DSH 没启动过带插件的版本 |
| 退出码 3 | 连不上宿主 | DSH 没开，或 `bridge.json` 是上次启动留下的；启动 DSH 再重试 |
| `401 unauthorized` | 令牌与 `bridge.json` 不一致 | 重跑 CLI，它每次读最新的 `bridge.json` |
| `403 forbidden host` | 请求 Host 不是 loopback | 用 `127.0.0.1` 或 `localhost`，不要用机器名或网卡 IP |
| `404` | 插件没挂载，或工作区/会话对不上 | 报给用户，不要改走其它接口硬试 |
| `405` | 用了 GET | 除 `/health` 外全部 POST |
| `409 directory-busy` | 同一工作目录已有会话在跑、在等人或状态未知 | 等它，或让人处置；在等人时响应带 `needsHuman` 与 `hint` |
| `409 session-waiting` / `session-unknown` | 目标会话自己在等人或状态未知 | 按 `hint` 处置，不要投 |
| `409 task-bound` | 任务号已绑定别的会话 | 响应带 `boundSessionId`，改用那个会话或换票号 |
| `409 invalid-stage-transition` | 挪站不在迁移表里 | 读当前 `stage`，按表走 |
| `409 conflict` | 对方自报 `ready` 但投影仍在跑或在等人 | 响应带 `stage` 与 `live` 两侧读数，以现场为准 |
| `503` | 宿主缺 `sessionController` / `workspaceRegistry`，或单写者检查跑不起来 | 版本不匹配，附 health 输出报给用户 |
| `500` | 宿主侧失败，或 `pointers.json` 损坏 | 原因原样给用户；指针文件损坏时桥不覆盖原文件 |

## 安全边界

- 只走 `bridge.json` 里的 `url` 加 token。不要自己拼 `/api`、不要读浏览器 cookie、不要试 `/connect`。
- token 是 0600 文件，不要打印到聊天、日志、提交里。取地址一律 `--dry-run`。
- 建会话和投消息会花用户额度，批量或长时间任务先问用户。
- 不切窗口、不替人验收。CLI 返回 200 只证明投递成功，不证明人在侧栏看得见——最后一步要人眼确认。