# schedule/ — Session-local reminders

English | [中文](README.zh.md)

The Schedule family owns reminders whose durable state lives in the original Session log. A process-local owner waits only while that Session has a live root Agent; cold Sessions resume overdue work when they become live again and never imply an external notification channel.

| Package | Role | ctx key |
|---|---|---|
| `schedule/` | Versioned Schedule events and fold, model-facing create/list/delete tools, and a live root-Agent timer owner | optional `ctx.scheduleDeliveryAdmission` input |

The package deliberately exposes no public Schedule management service or mutable database. A launcher may provide the optional process-local admission controller before root-Agent publication; the package never persists it. Tools and runtime append to the Session stream, and due work enters the same conversation through the Agent's ordinary follow-up queue.

Version-1 `schedule/change` remains the complete management and active-state authority. Version-2 `schedule/delivery` is an ignorable auxiliary outbox record in the same Session stream: pending plus the full v1 dispatch batch is checkpointed before queue admission, and complete is checkpointed only after the exact user message is durable. Current Hosts expose Schedule queue rows as producer-owned and reject public edit, steer, or cancel operations. Rollback admission is fail-closed: after quiescing and flushing, the updater uses `ctx.sessionPersistence.list()` plus `inspect()` and requires every `foldScheduleEvents(...).pendingDelivery` to be absent before selecting an old pin.

See [Session-local Schedule](../../docs/subsystems/schedule.md) for the durable record, transition, view, and delivery contracts.
