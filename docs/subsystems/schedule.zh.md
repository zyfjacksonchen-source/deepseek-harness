# 仅限 Session 内的 Schedule

[English](schedule.md) | 中文

Schedule 拥有持久提醒；这些提醒会作为普通的后续对话轮次返回原 live Session。[持久 Schedule Agent Note](../../.agents/notes/implemented/feature/2026-08-05-durable-web-schedule.md) 负责持久化与生命周期决策，[回滚安全交付](../../.agents/notes/implemented/bug-fix/2026-08-25-schedule-delivery-rollback-safety.md) 负责 outbox 与队列权限边界，[对话式交付](../../.agents/notes/implemented/simplification/2026-08-09-conversational-schedule-delivery.md) 负责无回执边界，[显式时区边界](../../.agents/notes/implemented/simplification/2026-08-09-explicit-schedule-time-zone.md) 负责浏览器本地解释，[有界固定速率 Schedule](../../.agents/notes/implemented/simplification/2026-08-09-bounded-fixed-rate-schedule.md) 负责重复调度。本页记录 [`packages/schedule/schedule/src/types.ts`](../../packages/schedule/schedule/src/types.ts) 中的持久数据形状和面向模型的数据形状；[包 README](../../packages/schedule/schedule/README.md) 负责组合、工具行为与确切的提醒 framing。

## 持久记录

`ScheduleId` 是[品牌化 id](core.md#branded-ids)，在单个 Session 内唯一且绝不复用。版本 1 支持正的安全整数 `after_seconds` 延时、显式的绝对 `at` 目标，或至少五分钟的安全整数 `every_seconds` 间隔。创建操作会将每个初始目标规范化为使用四位年份的 RFC 3339 UTC `scheduledAt`；`after` 记录会保留提交的延时，`at` 记录只存储结果时点，`every` 记录则保留固定间隔和下一个目标。

```ts type-equiv
/** Durable one-shot reminder created from a positive delay. */
interface AfterScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a delayed one-shot reminder. */
  readonly kind: 'after'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Positive safe-integer delay accepted at creation. */
  readonly afterSeconds: number
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable one-shot reminder created from an absolute instant. */
interface AtScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator for an absolute one-shot reminder. */
  readonly kind: 'at'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable fixed-rate reminder whose next target remains creation-anchor-aligned. */
interface EveryScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a fixed-rate recurring reminder. */
  readonly kind: 'every'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Fixed safe-integer interval, never below five minutes. */
  readonly everySeconds: number
  /** Earliest anchor-aligned occurrence not yet dispatched. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** One-shot record variants that terminate on an id-only dispatch. */
type OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord
```

```ts type-equiv
/** The v1 durable reminder record union. */
type ScheduleRecord = OneShotScheduleRecord | EveryScheduleRecord
```

## 绝对时间输入

`at` 选择器可以是严格且带偏移量的 RFC 3339 字符串，也可以是精确的本地日历对象。本地形式让这种解释在工具边界保持显式：

```ts type-equiv
/** Structured local-calendar input accepted by `schedule_create`. */
interface LocalAtInput {
  /** Four-digit ISO calendar date. */
  readonly date: string
  /** Local wall-clock time with optional one-to-three digit milliseconds. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}
```

```ts type-equiv
/** Absolute selector accepted by `schedule_create`. */
type AtInput = string | LocalAtInput
```

官方 Web overlay 会为每条提示词采样浏览器的 IANA 时区。当 open turn 只有一个无歧义的浏览器时区时，Time-context 会告诉模型按该请求本地时区解释未明确限定时区的自然语言日期和时间；provenance 混合或缺失时，则告诉模型询问用户。该指引不是持久 Session 默认值：模型仍必须在字符串形式中传入偏移量，或在本地形式中传入 `time_zone`；Schedule 绝不会读取浏览器、Session、进程或模型上下文。

Schedule 会拒绝无效偏移量与时区、不带偏移量的字符串、非未来目标，以及落在夏令时缺口内的本地时间。遇到夏令时重叠时，会选择第一次出现的较早时点。创建成功后只存储规范化后的 UTC `scheduledAt`，因此回放绝不依赖环境时区状态。

## 固定速率输入与补偿

`every_seconds` 是每条记录单独拥有且至少为 300 秒的间隔，以创建时间为锚点。它只提供固定速率重复调度：协议不包含日历规则或 Cron 表达式、重复调度时区、共享冷却时间或跨记录准入门禁。

如果一个 Session 在多个目标到期期间处于 cold 或 busy 状态，一条 Every 记录只会贡献其中最新的一次到期触发。dispatch 会直接将记录推进到 dispatch 判断时刻之后第一个与创建锚点对齐的目标，而不会枚举、持久化或回放错过的间隔。如果下一个目标无法落在四位数年份的 UTC 范围内，最后一次 dispatch 将终结该记录。

当多条彼此不同的 Every 记录均已到期，且没有一次性提醒到期时，每条记录都会向同一个 follow-up 批次贡献一次触发，并按目标时间和创建顺序排列。每条 Every 记录的状态互相独立，但该获准批次中的所有 dispatch 都使用同一个判断时刻。批处理限制模型轮次数量；五分钟下限限制每条记录的 timer 频率。

## 持久变更与回放

版本 1 的 `schedule/change` Session 事件是唯一的 Schedule 业务状态权威。create 保存完整记录，delete 是终结性且仅含 id 的转换。一次性提醒的 dispatch 同样是终结性且仅含 id。Every dispatch 携带用于选择最新到期触发的墙钟判断时刻，通常推进活动记录而不终结它。dispatch 会把选中的 occurrence 提交到版本 1 状态；它不表示队列准入、模型答复或用户确认已经成功。

```ts type-equiv
/** Creates one durable reminder record. */
interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: ScheduleRecord
}
```

```ts type-equiv
/** Deletes one currently active reminder. */
interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records that one active one-shot reminder entered the durable dispatch history. */
interface OneShotScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records one fixed-rate decision and advances directly past missed occurrences. */
interface EveryScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
  /** Wall-clock decision time used to select the latest due occurrence. */
  readonly acceptedAt: string
}
```

```ts type-equiv
/** Durable dispatch shapes supported by the current rule set. */
type ScheduleDispatchChange = OneShotScheduleDispatchChange | EveryScheduleDispatchChange
```

```ts type-equiv
/** Strict durable version-1 Schedule management mutation union. */
type ScheduleChange =
  | ScheduleCreateChange
  | ScheduleDeleteChange
  | ScheduleDispatchChange
```

严格 decoder 与 fold 会拒绝未知版本、额外字段、复用 id、不匹配的一次性提醒或 Every dispatch 形状，以及针对非活动记录的 delete 或 dispatch 转换。普通 Session 折叠完整事件流。fork 只折叠 `SessionHeader.seedLength` 位置及其后的事件，因此保留历史，但不会接管父 Session 的活动提醒。持久化目录同时收录 [`schedule/change`](../persistence-catalog.md#schedulechange--log-only) 与 [`schedule/delivery`](../persistence-catalog.md#scheduledelivery--log-only)。

版本 2 的 `schedule/delivery` 是同一 Session stream 中的辅助 outbox 行，绝不是第二套 scheduler、队列、store 或活动状态 owner。pending 会校验并围栏一个确切到期决策，但不会改变活动记录；只有对应的版本 1 dispatch 变更才会改变活动状态。只有确切的 Session `user/message` 持久化后，complete 才会关闭该行。writer 会为每个 delivery envelope 标记 `ignorable: true`，使受支持的旧 reader 可以保留并跳过辅助行，同时从版本 1 派生完整活动状态。

pending event seq 与完整有序的 occurrence 身份会派生一个 delivery id 和一个确定性 message id；prompt 永远不会进入这两类身份。回滚前缀出现后，这些 id 仍命名原始 batch。replay 会把每条具备确切 dispatch-prefix framing 的旧版随机 id message 映射到对应 occurrence id，合并这些身份，并让确定性 message 保持原始 id、只渲染仍未被表示的 occurrence。只有该并集覆盖每个 pending occurrence 时，complete 才合法。强制 old-pin crash recovery 造成的确切重叠只会记账一次，使当前恢复不再追加副本，但这些历史重复不会被改写或隐藏。pending 之后的 v1 delete 会终止未来活动状态，但不会撤回已经保留的 occurrence。

```ts type-equiv
/** One occurrence reserved in a version-2 delivery batch. */
interface ScheduleDeliveryOccurrence {
  /** Deterministic identity derived from the pending event seq, schedule id, and occurrence instant. */
  readonly occurrenceId: ScheduleOccurrenceId
  /** Active schedule that produced the occurrence. */
  readonly scheduleId: ScheduleId
  /** Canonical UTC occurrence instant. */
  readonly occurrenceAt: string
}
```

```ts type-equiv
/** Durably reserves occurrences before their deterministic Inbox message is queued. */
interface ScheduleDeliveryPendingChange {
  readonly version: 2
  readonly operation: 'delivery-pending'
  /** Deterministic identity of this ordered occurrence batch. */
  readonly deliveryId: ScheduleDeliveryId
  /** Deterministic Session-local user-message identity for the batch. */
  readonly messageId: MessageId
  /** Wall-clock decision time that selected the occurrences. */
  readonly acceptedAt: string
  /** One one-shot occurrence or the complete due fixed-rate batch. */
  readonly occurrences: readonly ScheduleDeliveryOccurrence[]
}
```

```ts type-equiv
/** Closes one pending delivery after exact durable carriers cover every occurrence. */
interface ScheduleDeliveryCompleteChange {
  readonly version: 2
  readonly operation: 'delivery-complete'
  readonly deliveryId: ScheduleDeliveryId
  readonly messageId: MessageId
}
```

```ts type-equiv
/** Strict version-2 delivery mutation union. */
type ScheduleDeliveryChange = ScheduleDeliveryPendingChange | ScheduleDeliveryCompleteChange
```

## 活动视图与管理

工具值将持久记录与根据当前墙钟派生的交付状态组合起来。`session-local` 表示原 Session 必须处于 live 状态：不存在外部通知渠道或 cold Session scheduler。

```ts type-equiv
/** Current delivery timing derived from the durable record and wall clock. */
type ScheduleState = 'scheduled' | 'overdue'
```

```ts type-equiv
/** Fixed v1 delivery boundary: the original session must be live. */
type ScheduleDeliveryMode = 'session-local'
```

```ts type-equiv
/** Complete model-facing view of one active reminder. */
type ScheduleView = ScheduleRecord & {
  /** Whether the target remains in the future. */
  readonly state: ScheduleState
  /** Reminder delivery never leaves the owning session. */
  readonly deliveryMode: ScheduleDeliveryMode
}
```

生成的[工具目录](../tool-catalog.md#deepseek-aidsh-schedule)负责 `schedule_create`、`schedule_list` 和 `schedule_delete` 的参数与结果 schema。一条 Agent-scoped 队列将管理调用与到期工作串行化。每次读取或判断都会先等待共享的 Session 持久化 barrier；create 与实际执行的 delete 在追加后还会再次等待。barrier 失败会报告 `persistence_uncertain`，而不是猜测 eager write 是否已提交。其他稳定错误代码是 `invalid_prompt`、`invalid_selector`、`invalid_rule`、`invalid_time_zone`、`not_future`、`time_out_of_range`、`frequency_too_high`、`corrupt_schedule_log` 和 `internal_error`。

## Live 交付

进程内 owner 根据持久 fold 派生最早的 timer，并在每次有界等待后重新读取墙钟。cold Session 不执行任何工作；重新打开后会重建 timer，并使已经过去的目标进入 overdue 状态。到期的一次性提醒享有优先级，每次只进入一个后续轮次。当没有一次性提醒到期时，所有 overdue 的 Every 记录会组成上述单个批次。

到期工作会先等待 Agent 完全 idle 并认领 maintenance phase，再重新折叠状态并采样一次决策。它会先追加一条可忽略的 delivery-pending 行和完整有序的版本 1 dispatch 批次，跨过一个持久化 barrier 后，才把确定性的 `followup()` 排入队列。pending 行会为当前 reader 建立围栏，但不会改变活动状态；发生 torn prefix 时，恢复会在任何 message 进入 Inbox 前补齐所有缺失的 v1 dispatch。它绝不会调用 `steer()`，也绝不会中断当前轮次。

获得准入的一次性提醒或固定速率批次会启动一个普通的后续轮次，且只通过普通对话 transcript（文本记录）出现；Schedule 不提供独立的持久 Web 回执或浏览器渲染器。确切的 Session `user/message` 会让 outbox 行获得准入。恢复会移除任何其他兼容的 Inbox 副本、追加 delivery-complete，并跨过第二个 barrier；如果移除副本失败，则会以故障关闭且不完成交付。当前队列 snapshot 会公开 producer ownership，Host 的公共 update 边界会拒绝 Schedule 行的 edit、steer 与 cancel，而不是只在某个 UI 中隐藏操作。

回滚准入只使用原生 Session projection。当前 Host 会先 quiesce Agent 并 flush 每个 live Session；随后 updater 枚举 `ctx.sessionPersistence.list()`，对每个 header 调用 `inspect(header.id)`，并要求所有 Session 都满足 `foldScheduleEvents(inspection.events, inspection.meta.seedLength ?? 0).pendingDelivery === undefined`。任何 flush、list、inspect 或 fold 失败都会阻断旧 pin 的选择；该读取路径不会增加 sidecar 或第二 store。通过准入后，旧 reader 会保留并跳过可忽略的 delivery 行，同时从 v1 读取完整活动状态。当前恢复只会映射 pending 之后、具备确切 plugin source 与重建 dispatch-prefix framing 的旧 message，其中包括 user-message 先于 dispatch 的顺序。它会合并每个确切 carrier，只排入 residual occurrence，并在 source 或 framing 未知时进入故障状态。确切重叠会防止当前版本再次发送，但无法掩盖连续强制 old-pin crash recovery 已经产生的重复。因此 forced old→old 门禁是“存在 pending 时必须阻断回滚”的负面证据，而不是通过的兼容案例。旧 Host 也早于 producer-owned 队列保护，因此降级期间仍禁止队列管理。通过准入的协议会对 Session 输入去重，但不承诺模型完成、用户确认或外部副作用恰好一次。
