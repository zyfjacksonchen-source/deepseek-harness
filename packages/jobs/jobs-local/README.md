# @deepseek-ai/dsh-jobs-local

English | [中文](README.zh.md)

Process-local implementation of the [`@deepseek-ai/dsh-jobs`](../jobs/README.md) registry contract: `LocalJobRegistry` keeps every record in memory, issues per-kind `<kind>-N` ids, and hands out fresh snapshots, never live state. Load it as a plugin and it registers as `ctx.jobs`.

## Admission

`maxConcurrentJobsPerOwner` is a positive safe integer and defaults to `10`. Before invoking a producer, `start()` counts the exact owner's `running` and `stopping` records; all unowned jobs share one separate service bucket. Terminal history does not occupy capacity, and only producer `done` settlement releases a stopping job's place.

At capacity, `start()` fails before producer execution and id allocation with an error that names the limit and tells the model to use `job_kill`, wait for the job to finish stopping, and retry. This immediate path does not queue, preempt, or maintain a second mutable counter.

`startWhenAvailable()` is a separate opt-in admission path for a producer that needs one active Job of its kind across all owners. It keeps a FIFO of not-yet-started requests keyed by `JobStart.kind`; requests carry their original owner but allocate no id, snapshot, or producer resource while waiting. The registry derives occupancy from its authoritative `running` and `stopping` records, so only terminal `done` settlement releases the next request. Abort, exact-owner disposal, and service disposal remove and reject queued requests. Ordinary `start()` remains synchronous and can bypass this lane, so every producer of a constrained kind must use the async seam.

## Lifecycle

Jobs belong to their owner and backend, not the producer tool fiber, so producer and controller reloads do not stop them. The first job or queued admission for an owner attaches one awaited effect to the exact `Agent` scope. Owner disposal rejects that object's queued requests, cancels its started jobs, awaits producer quiescence, and removes their snapshots; reused agent or session ids cannot redirect an old cleanup.

Service disposal closes listeners, cancels all live jobs, awaits their records, and detaches effects from surviving owner scopes. If teardown cancellation throws, the service force-fails the record and warns that work may be orphaned instead of deadlocking. A cancellation that returns but never settles `done` remains indistinguishable from a slow stop and can stall teardown.

Settlement is first-wins: the earliest terminal outcome — producer settlement, a rejected `done` contained as `failed`, or a teardown force-failure — records once, releases waiters, and notifies listeners once with per-listener containment. Pending waits mark the job reported before listeners run so completion reporters do not duplicate notices, and a teardown cancel marks it for the same reason: nothing will read a notice addressed to an owner being destroyed. Completion is the last thing a settlement announces, after the record is committed and the visible-set change is published, because a reporter may open a model turn synchronously and every other observer must already have seen the settled record.

Controllers and listeners are layered by the scope that registered them, in the tools-registry shape: a registration files into its registering context's scope, and a read unions the global layer with the owner's scope chain. One process-wide registry therefore answers per-owner questions per owner — `start()` refuses `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)` for an owner whose own composition attaches none, however many other compositions attach theirs, and a settlement reaches only the listeners its owner's composition registered.

## Model Experience

Indirectly, through producer plugins and [`dsh-tool-jobs`](../tool-jobs/README.md), which render job ids, output, status, cancellation, and completion notices.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Jobs are process-local** — records die with the harness process; durable or cross-restart execution needs a separate backend implementing the seam.
- **A silently ineffective cancel can stall teardown and hold capacity** — if `cancel` returns without settling `done`, the registry cannot distinguish it from a slow stop; the job keeps one bucket slot for the rest of the service lifetime, and only an explicit throw can be force-failed safely.
- **Per-kind FIFO capacity is fixed at one** — no current consumer has measurements justifying a wider native lane. Raising it requires a concrete result and keeps Job records as the only active-count authority.
