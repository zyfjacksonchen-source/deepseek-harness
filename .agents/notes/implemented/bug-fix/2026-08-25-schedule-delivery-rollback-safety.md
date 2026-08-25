# Agent Note: Schedule delivery remains v1-owned across crashes and rollback

Status: implemented

English | [中文](2026-08-25-schedule-delivery-rollback-safety.zh.md)

## Problem

Schedule originally queued a producer-owned Inbox message before its version-1 dispatch was durable. Public queue mutation could edit, steer, or remove that reserved message, while a crash between queue admission and dispatch left no durable identity for deciding whether recovery should resend it. A version-2 delivery mutation placed inside `schedule/change` also made the old strict decoder fault during rollback. Skipping new records was not sufficient: the old pin had to reconstruct the same active schedules, and old random-id messages could become durable either before or after their v1 dispatch.

## Decision

Version-1 `schedule/change` remains the sole Schedule business-state authority. Version-2 `schedule/delivery` is an auxiliary outbox record in the same Session stream, never a second scheduler, queue, store, or active-state owner. Every delivery envelope uses Session's native `ignorable: true` marker, and Session rejects that marker on surface events. Pending validates and fences an exact due decision but does not advance active records; only v1 dispatch does.

The Host's single public queue-update boundary now rejects edit, steer, and cancel for every producer-owned message. Queue snapshots expose this ownership as `mutable: false`, so clients keep the row visible while withholding invalid controls. Schedule treats failure to remove a compatible duplicate as a fault and does not close the outbox.

A launcher may provide one closed process-local `ScheduleDeliveryAdmission` before publishing a root Agent. Schedule reads that startup value even while its provider is still loading, so provider activation cannot fall through to the absent-controller default. Closed admission freezes delivery before preflight or persistence while version-1 management remains available. `open()` releases every waiting runtime once; compositions without a controller remain open by default.

## Crash and rollback protocol

The writer appends delivery-pending and the complete ordered v1 dispatch batch before one shared durability barrier. Only after that barrier may it call `followup()`. The pending seq and full ordered occurrence identities derive one delivery id and one message id; prompts enter neither. Exact durable Session carriers form an occurrence-id union. After an old partial carrier, the deterministic message keeps the original batch id while replay-derived text contains only residual occurrences. Exact overlaps are credited once so current recovery adds no further copy, but replay does not erase a historical old-pin duplicate. Delivery-complete follows only when the union covers the original batch, then crosses a second barrier. A pending-only or partially mirrored prefix is recovered by appending all missing v1 dispatches before enqueue. A claimed or deleted Inbox message with no durable `user/message` is requeued with the deterministic identity. When an old message for a later occurrence is followed by its matching v1 dispatch, replay keeps that carrier outside the earlier pending union; a torn message-before-dispatch prefix faults closed instead of guessing. A v1 delete terminates future active state but does not revoke an occurrence already reserved by pending.

The supported old pin retains and skips the ignorable row while reading complete state from v1. Current recovery recognizes old random-id messages only from the exact post-pending `{ kind: "plugin", plugin: "schedule" }` source and framing reconstructed from v1 dispatches. Exact pending candidates are unioned; an unknown source or framing, including a torn later-occurrence message with no matching dispatch, faults. Before rollback, the current Host must quiesce Agents and flush live Sessions. The updater then calls `ctx.sessionPersistence.list()`, `inspect(header.id)` for every header, and `foldScheduleEvents(inspection.events, inspection.meta.seedLength ?? 0)`, admitting the old pin only when every result has no `pendingDelivery`. Any flush, list, inspect, or fold failure blocks rollback. This is a query over the existing Session projection, not another store. The old Host predates producer ownership enforcement, so no queue management while downgraded is also required.

## Verification

Domain and runtime tests pin canonical crash cuts, partial Every batches, reverse old message/dispatch order, the stable later-occurrence message-plus-dispatch sequence, its torn fail-closed prefix, deterministic-versus-legacy Inbox conflicts, failed duplicate removal, delete-after-pending reservation, forks, and pure-v1 replay. Composition coverage creates a root Agent from the same still-loading provider that supplies a closed admission, proves every delivery side effect remains absent, then opens the one-way controller and observes the exact delivery. A 5,000-event executable gate includes high-frequency version-2 Every deliveries. The repeatable dual-build downgrade gate archives exact old commit `2bc16230975f6cf02aa1b283b1f86de44007b059`, builds both trees, and runs plain Node against each tree's public `lib` package entries through real persistence, Agent, Schedule, list, due, and chat paths over candidate-produced JSONL before re-upgrading and checking convergence. It is part of local `check-all` and the required PR consumer group. Single-old-interval pending prefixes are explicitly policy-bypass containment probes, not admitted rollbacks; they record per-occurrence request text and identities and require exactly one carrier for each original occurrence. Only the later pending-free old load is an admission-ready pass. A forced pending→old torn crash→old recovery scenario deliberately records C twice; it is NEGATIVE evidence that rollback admission must block while pending, and current upgrade asserts containment without pretending the old duplicate disappeared. The runnable TypeScript and Python SDK expected-output gates both include a real `schedule/delivery` event emitted through the assembled public path.

## Alternatives considered

**Keep delivery version 2 inside `schedule/change`.** Rejected because the old strict decoder faults before it can preserve v1 active state.

**Let ignorable pending advance current active state.** Rejected because an auxiliary record would become a second business-state authority and pending-only would project differently in current and old readers.

**Hide Schedule rows in the Web UI.** Rejected because API callers and other queue consumers would retain the destructive capability. The native Host boundary owns the permission check.

**Promise unconditional exactly-once delivery across arbitrary old binaries.** Rejected because consecutive forced old-pin crash recoveries can duplicate an occurrence while a v2 row is pending, the old Host can mutate producer-owned Inbox rows, and neither version can prove model completion, user acknowledgement, or external-effect completion.

**Use strict optional-service lookup and fall back to open.** Rejected because Cordis intentionally hides values owned by a loading provider from strict lookup. A launcher that provides the closed controller and creates a root Agent in the same activation would otherwise bypass probation before the provider becomes active.

## Consequences

Current crash recovery preserves one exact Session input across supported current prefixes, and admission-ready rollback keeps version-1 active state readable without a parallel scheduler. A launcher can hold all Schedule delivery during startup probation without freezing management or adding persistent state. Delivery adds an ignorable auxiliary event pair and deterministic identities to the existing Session log. Rollback is delayed whenever the exported Schedule fold reports `pendingDelivery`; bypassing that fence can create an old-pin duplicate which later code may contain but cannot undo. Model and external effects remain outside the durable acknowledgement contract.
