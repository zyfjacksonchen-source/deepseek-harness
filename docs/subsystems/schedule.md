# Session-local Schedule

English | [中文](schedule.zh.md)

Schedule owns durable reminders that return to the original live Session as ordinary later conversation turns. The [durable Schedule Agent Note](../../.agents/notes/implemented/feature/2026-08-05-durable-web-schedule.md) owns the persistence and lifecycle decisions, [rollback-safe delivery](../../.agents/notes/implemented/bug-fix/2026-08-25-schedule-delivery-rollback-safety.md) owns the outbox and queue-permission boundary, [conversational delivery](../../.agents/notes/implemented/simplification/2026-08-09-conversational-schedule-delivery.md) owns the no-receipt boundary, the [explicit time-zone boundary](../../.agents/notes/implemented/simplification/2026-08-09-explicit-schedule-time-zone.md) owns browser-local interpretation, and [bounded fixed-rate Schedule](../../.agents/notes/implemented/simplification/2026-08-09-bounded-fixed-rate-schedule.md) owns recurrence. This page records the durable and model-facing shapes from [`packages/schedule/schedule/src/types.ts`](../../packages/schedule/schedule/src/types.ts); the [package README](../../packages/schedule/schedule/README.md) owns composition, tool behavior, and the exact reminder framing.

## Durable records

`ScheduleId` is a [branded id](core.md#branded-ids), unique and never reused within one Session. Version 1 supports a positive safe-integer `after_seconds` delay, an explicit absolute `at` target, or a safe-integer `every_seconds` interval of at least five minutes. Creation canonicalizes every first target into a four-digit-year RFC 3339 UTC `scheduledAt`; an `after` record retains its submitted delay, an `at` record stores only the resulting instant, and an `every` record retains its fixed interval and next target.

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

## Absolute-time input

The `at` selector is either a strict offset-bearing RFC 3339 string or an exact local-calendar object. The local form keeps its interpretation explicit at the tool boundary:

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

The official Web overlay samples the browser's IANA zone for every prompt. Time-context tells the model to interpret otherwise-unqualified natural-language dates and times in that request-local zone when the open turn has one unambiguous browser zone; mixed or missing provenance tells the model to ask. That guidance is not a durable Session default: the model must still pass an offset in the string form or `time_zone` in the local form, and Schedule never reads browser, Session, process, or model context.

Schedule rejects invalid offsets and zones, offset-free strings, non-future targets, and local times inside daylight-saving gaps. A daylight-saving overlap chooses its first, earlier instant. Successful creation stores only canonical UTC `scheduledAt`, so replay never depends on ambient time-zone state.

## Fixed-rate input and catch-up

`every_seconds` is a per-record interval of at least 300 seconds, anchored to creation time. It is fixed-rate recurrence only: the protocol has no calendar or Cron expression, recurrence time zone, shared cooldown, or cross-record admission gate.

When a Session was cold or busy across several targets, one Every record contributes only its latest due occurrence. The dispatch advances it directly to the first creation-anchor-aligned target after the dispatch decision time, without enumerating, persisting, or replaying missed intervals. If that next target cannot fit in a four-digit UTC year, the final dispatch terminates the record.

When multiple distinct Every records are overdue and no one-shot is due, each contributes one occurrence to the same follow-up batch in target and creation order. Every record keeps independent state, while all dispatches in that admitted batch use the same decision time. Batching bounds model turns; the five-minute minimum bounds each record's timer frequency.

## Durable changes and replay

The version-1 `schedule/change` Session event is the sole Schedule business-state authority. Create stores the complete record, and delete is a terminal id-only transition. A one-shot dispatch is also terminal and id-only. An Every dispatch carries the wall-clock decision time used to select its latest due occurrence and normally advances the active record instead of terminating it. Dispatch commits the selected occurrence in version-1 state; it does not claim that a queue admission, model answer, or user acknowledgement succeeded.

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

The strict decoder and fold reject unknown versions, extra fields, reused ids, mismatched one-shot or Every dispatch shapes, and delete or dispatch transitions against inactive records. A normal Session folds its complete event stream. A fork folds only events at or after `SessionHeader.seedLength`, so it retains history without adopting the parent Session's active reminders. The persistence catalog indexes both [`schedule/change`](../persistence-catalog.md#schedulechange--log-only) and [`schedule/delivery`](../persistence-catalog.md#scheduledelivery--log-only).

Version-2 `schedule/delivery` is an auxiliary outbox row in the same Session stream, never a second scheduler, queue, store, or active-state owner. Pending validates and fences one exact due decision without changing active records; only the corresponding version-1 dispatch changes do that. Complete closes the row only after the exact Session `user/message` is durable. Writers mark every delivery envelope `ignorable: true`, allowing supported old readers to preserve and skip the auxiliary row while deriving the full active state from version 1.

The pending event seq and complete ordered occurrence identities derive one delivery id and one deterministic message id; prompts never enter either identity. Those ids continue to name the original batch after a rollback prefix. Replay maps every old random-id message with exact dispatch-prefix framing to its occurrence ids, unions those identities, and keeps the deterministic message's original id while rendering only the still-unrepresented occurrences. Complete is valid only when that union covers every pending occurrence. Exact overlaps caused by forced old-pin crash recovery are credited once so current recovery adds no further copy, but they remain historical duplicates rather than being rewritten or hidden. A v1 delete after pending terminates future active state but does not revoke the already reserved occurrence.

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

## Active views and management

Tool values combine the durable record with delivery state derived from the current wall clock. `session-local` means the original Session must be live: no external notification channel or cold-session scheduler exists.

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

The generated [tool catalog](../tool-catalog.md#deepseek-aidsh-schedule) owns the argument and result schemas for `schedule_create`, `schedule_list`, and `schedule_delete`. Management calls serialize with due work in one Agent-scoped queue. Every read or decision first waits for the shared Session persistence barrier; create and an actual delete wait again after appending. A barrier failure reports `persistence_uncertain` instead of guessing whether an eager write committed. The other stable error codes are `invalid_prompt`, `invalid_selector`, `invalid_rule`, `invalid_time_zone`, `not_future`, `time_out_of_range`, `frequency_too_high`, `corrupt_schedule_log`, and `internal_error`.

## Live delivery

The process-local owner derives its earliest timer from the durable fold and rereads the wall clock after every bounded wait. Cold Sessions do no work; reopening one reconstructs timers and makes past targets overdue. Due one-shots take priority and enter one later turn at a time. When no one-shot is due, all overdue Every records form the single batch described above.

Due work waits for the Agent to become fully idle and claims the maintenance phase before it refolds state and samples one decision. It appends one ignorable delivery-pending row and the complete ordered version-1 dispatch batch, then crosses one durability barrier before it queues the deterministic `followup()`. The pending row fences a current reader without changing active state; a torn prefix is repaired by appending every missing v1 dispatch before any message can enter Inbox. It never calls `steer()` and never interrupts a current turn.

The admitted one-shot or fixed-rate batch starts one normal later turn and appears only through the ordinary conversation transcript; Schedule has no independent durable Web receipt or browser renderer. The exact Session `user/message` admits the outbox row. Recovery removes any other compatible Inbox copy, appends delivery-complete, and crosses a second barrier; failure to remove a copy faults closed without completing. Current queue snapshots expose producer ownership, and the Host's public update boundary rejects edit, steer, and cancel for Schedule rows rather than hiding them in one UI.

Rollback admission uses only native Session projections. The current Host first quiesces Agents and flushes every live Session, then the updater enumerates `ctx.sessionPersistence.list()`, calls `inspect(header.id)` for each header, and requires `foldScheduleEvents(inspection.events, inspection.meta.seedLength ?? 0).pendingDelivery === undefined` for all Sessions. Any flush, list, inspect, or fold failure blocks selection of the old pin; this read path adds no sidecar or second store. Once admitted, the old reader retains and skips ignorable delivery rows while reading full active state from v1. Current recovery maps only post-pending old messages with the exact plugin source and reconstructed dispatch-prefix framing. Once a matching later-occurrence v1 dispatch is present, it leaves that old carrier outside the earlier pending union; a torn prefix with the message but no dispatch faults closed. It unions every exact pending carrier, queues only residual occurrences, and faults on unknown source or framing. Exact overlaps prevent another current resend but cannot conceal a duplicate already produced by consecutive forced old-pin crash recoveries. The forced old→old gate is therefore negative evidence that rollback while pending must remain blocked, not a passing compatibility case. The old Host also predates producer-owned queue protection, so queue management remains forbidden while downgraded. The admitted protocol deduplicates Session input but does not promise model completion, user acknowledgement, or exactly-once external effects.
