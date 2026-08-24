# Agent Note: Schedule 交付在崩溃与回滚期间仍由 v1 持有

Status: implemented

[English](2026-08-25-schedule-delivery-rollback-safety.md) | 中文

## 问题

Schedule 原先会在版本 1 dispatch 持久化前，把 producer-owned Inbox message 排入队列。公共队列修改能力可以 edit、steer 或 remove 这条保留消息；而在队列准入与 dispatch 之间崩溃时，又没有持久身份可供恢复判断是否应重新发送。把版本 2 delivery mutation 放进 `schedule/change` 还会使旧版严格 decoder 在回滚期间进入故障。仅仅跳过新记录并不充分：旧 pin 必须重建相同的活动 Schedule，而且旧版随机 id message 可能在其 v1 dispatch 之前或之后持久化。

## 决定

版本 1 的 `schedule/change` 仍是唯一的 Schedule 业务状态权威。版本 2 的 `schedule/delivery` 是同一 Session stream 中的辅助 outbox 记录，绝不是第二套 scheduler、队列、store 或活动状态 owner。每个 delivery envelope 都使用 Session 原生的 `ignorable: true` 标记，而 Session 会拒绝把该标记用于 surface event。pending 会校验并围栏一个确切到期决策，但不会推进活动记录；只有 v1 dispatch 会推进活动状态。

Host 的单一公共 queue-update 边界现在会拒绝对所有 producer-owned message 执行 edit、steer 与 cancel。队列 snapshot 以 `mutable: false` 公开该 ownership，因此 client 会保留可见行，但不提供无效控制。Schedule 把无法移除兼容副本视为故障，且不会关闭 outbox。

launcher 可以在发布根 Agent 前提供一个关闭的进程内 `ScheduleDeliveryAdmission`。即使 provider 仍在 loading，Schedule 也会读取这个启动值，因此 provider activation 不会误用“未提供 controller”时的默认值。关闭准入会在 preflight 或持久化前冻结交付，但版本 1 管理仍然可用。`open()` 只会一次性释放所有等待中的 runtime；未提供 controller 的组合仍默认开放。

## 崩溃与回滚协议

writer 会在一个共享持久化 barrier 之前，先追加 delivery-pending 与完整有序的 v1 dispatch 批次。只有跨过该 barrier 后才能调用 `followup()`。pending seq 与完整有序的 occurrence 身份会派生一个 delivery id 和一个 message id；prompt 不进入任一身份。确切的持久 Session carrier 会形成 occurrence-id 并集。旧版部分 carrier 出现后，确定性 message 保持原始 batch id，但由 replay 派生的文本只包含 residual occurrence。确切重叠只会记账一次，使当前恢复不再追加副本，但 replay 不会删除旧 pin 已产生的历史重复。只有该并集覆盖原始 batch 时才会追加 delivery-complete，再跨过第二个 barrier。恢复 pending-only 或部分 mirror 前缀时，会在入队前补齐全部缺失的 v1 dispatch。Inbox message 已被 claim 或删除但没有持久化 `user/message` 时，会以确定性身份重新入队。当旧版为稍后 occurrence 写入的 message 后存在匹配的 v1 dispatch 时，replay 会让该 carrier 留在较早的 pending 并集之外；如果前缀中断在 message 与 dispatch 之间，则会以故障关闭，而不会猜测。v1 delete 会终止未来活动状态，但不会撤回 pending 已经保留的 occurrence。

受支持的旧 pin 会保留并跳过可忽略行，同时从 v1 读取完整状态。当前恢复只会依据 pending 后完全匹配的 `{ kind: "plugin", plugin: "schedule" }` source 与从 v1 dispatch 重建的 framing，识别旧版随机 id message。确切 pending 候选会形成并集；source 或 framing 未知时会进入故障状态，其中包括没有匹配 dispatch 的 torn 稍后 occurrence message。回滚前，当前 Host 必须 quiesce Agent 并 flush live Session。随后 updater 会调用 `ctx.sessionPersistence.list()`、对每个 header 调用 `inspect(header.id)`，再调用 `foldScheduleEvents(inspection.events, inspection.meta.seedLength ?? 0)`；只有每个结果都不存在 `pendingDelivery` 时才准入旧 pin。任何 flush、list、inspect 或 fold 失败都会阻断回滚。该查询基于现有 Session projection，而不是另一套 store。旧 Host 早于 producer ownership enforcement，因此降级期间禁止队列管理也是必要条件。

## 验证

domain 与 runtime 测试固定了规范崩溃切点、部分 Every 批次、旧版 message/dispatch 反向顺序、稳定的稍后 occurrence message 加 dispatch 顺序、对应的 torn fail-closed 前缀、确定性与 legacy Inbox 冲突、重复项移除失败、delete-after-pending reservation、fork 和纯 v1 replay。组合测试会让提供关闭准入的同一个 still-loading provider 创建根 Agent，证明所有交付副作用都保持缺失，再打开单向 controller 并观察到确切交付。一个 5,000 event 可执行门禁包含高频版本 2 Every delivery。可重复双构建降级门禁会归档精确旧 commit `2bc16230975f6cf02aa1b283b1f86de44007b059`，构建两棵源码树，并通过普通 Node 针对各自的公共 `lib` package entry 运行真实 persistence、Agent、Schedule、list、due 与 chat 路径，让旧版读取 candidate 生成的 JSONL，再重新升级并检查收敛。该门禁已接入本地 `check-all` 与必需的 PR consumer 分组。单个旧版区间的 pending 前缀会明确标成绕过策略的收容 probe，而不是已准入回滚；它们记录每个 occurrence 的 request 文本和身份，并要求原始每个 occurrence 恰好拥有一个 carrier。只有随后不含 pending 的旧版加载才是通过准入的案例。另一个强制 pending→old torn crash→old recovery 场景会特意记录 C 两次；它是“存在 pending 时必须阻断回滚”的 NEGATIVE 证据，当前升级只断言收容，绝不假装旧版重复已经消失。TypeScript 与 Python SDK 的可运行 expected-output 门禁都包含通过 assembled public path 发出的真实 `schedule/delivery` event。

## 已考虑的替代方案

**把版本 2 delivery 保留在 `schedule/change` 中。** 否决，因为旧版严格 decoder 会在保留 v1 活动状态之前进入故障。

**让可忽略 pending 推进当前活动状态。** 否决，因为辅助记录会成为第二个业务状态权威，而且 pending-only 在当前 reader 与旧 reader 中会产生不同投影。

**在 Web UI 中隐藏 Schedule 行。** 否决，因为 API caller 与其他队列 consumer 仍会保留破坏性能力。权限检查应由原生 Host 边界持有。

**承诺跨任意旧 binary 的无条件恰好一次交付。** 否决，因为 v2 行 pending 时，连续强制 old-pin crash recovery 可能重复 occurrence；旧 Host 仍可修改 producer-owned Inbox 行，而且两个版本都不能证明模型完成、用户确认或外部效果完成。

**使用严格的可选 service 读取并在缺失时默认开放。** 否决，因为 Cordis 会有意对严格读取隐藏仍由 loading provider 持有的值。若 launcher 在同一次 activation 中提供关闭 controller 并创建根 Agent，这种读取会在 provider active 前错误绕过 probation。

## 影响

当前崩溃恢复会在受支持的当前前缀间保留一个确切 Session 输入，已通过准入的回滚也可持续读取版本 1 活动状态，而无需平行 scheduler。launcher 可以在启动 probation 期间阻止全部 Schedule 交付，而不冻结管理或增加持久状态。交付会在现有 Session 日志中增加一对可忽略的辅助 event 以及确定性身份。只要导出的 Schedule fold 报告 `pendingDelivery`，回滚就必须延后；绕过该围栏可能产生旧 pin 重复，后续代码只能收容而无法撤销。模型与外部效果仍不属于持久确认合同。
