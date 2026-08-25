# Agent Note: Cross-owner kind job admission

Status: implemented

English | [中文](2026-08-25-cross-owner-kind-job-admission.zh.md)

## Problem

The existing `maxConcurrentJobsPerOwner` policy correctly bounds each exact Agent, but it cannot express a producer resource shared by unrelated Sessions. Two parent Agents can each pass their own bucket and start the same expensive producer kind concurrently. Serializing that work in a product plugin with a module-global flag, Promise tail, or private queue would duplicate Job lifecycle and lose exact owner cancellation during reload or teardown.

Some producers also release their scarce resource when their Job settles while a surrounding child Agent may take longer, or fail, to dispose. Waiting for that child lifecycle would hold capacity after the authoritative producer resource is gone.

## Decision

`JobRegistry` exposes `startWhenAvailable(spec, signal?)`, and `LocalJobRegistry` implements it as an opt-in process-wide FIFO keyed by `JobStart.kind`. The lane admits one active Job across all owners. Once admitted, the ordinary `start()` path creates the Job, so the original exact Agent remains owner and existing access, kill, read, notice, and cleanup contracts remain unchanged.

A pending request has no Job id, snapshot, producer execution resource, or second active counter. The local provider retains only the request and derives occupancy from its authoritative `running` and `stopping` Job records. Terminal `JobHooks.done` settlement commits the record, publishes the visible-set change, and then drains the next request before completion listeners may wake an owner. A producer fiber, child Agent, or child-disposal Promise cannot release or hold the lane.

The caller's AbortSignal cancels only a request that is still queued. Exact owner disposal rejects that owner's pending requests before cancelling its started Jobs. Service disposal closes admission synchronously and rejects every pending request before cancelling and awaiting started Jobs. Each rejection occurs before `run()` and id allocation; a throwing admitted starter rejects its request and lets the next FIFO entry try the same now-free lane.

Ordinary `start()` remains synchronous, immediate, and unqueued. It observes the same Job records but does not join the FIFO, so a producer that requires this product-wide bound must route every start of its constrained kind through `startWhenAvailable()`. The lane capacity is fixed at one until a measured consumer justifies a wider native contract; this change adds no priority, retry, persistence, durable queue, generic scheduler, or public Job state.

## Verification

The Service Definition test pins the Promise API. The process-local provider suite uses real `Session`-backed parent Agents to pin cross-owner FIFO order, terminal-only release, owner-scoped get and kill authority, abort without producer execution or id allocation, queued owner disposal, failed-starter progress, and bounded service teardown. A real Cordis Loader composition loads the provider row and proves two parent Sessions cannot enter the same producer kind together.

## Alternatives considered

**Keep a product-plugin global boolean, Promise tail, or private queue.** Rejected because it creates a second lifecycle owner outside `JobRegistry`; reload, owner disposal, and service teardown can strand the lock or admit work after its Agent disappeared.

**Use `maxConcurrentJobsPerOwner: 1`.** Rejected because the two competing parents are different exact Agents and therefore occupy different intended buckets. Changing the existing policy to one process-wide owner bucket would let one unrelated producer deny every other Job kind and Session.

**Wait for the surrounding child Agent to dispose.** Rejected because the Job's `done` settlement is the authority that the producer resource has quiesced. A hanging child cleanup must not hold a released image/provider slot.

**Add a generic scheduler with configurable parallelism, priorities, and retries.** Rejected because the current need is exactly one FIFO slot for one opted-in kind. No measurement or consumer contract justifies additional scheduling vocabulary.

## Consequences

Two unrelated owners can share one scarce producer lane without losing ordinary Job ownership or adding a product-local scheduler. A queued request is intentionally not visible as a Job; callers surface their existing queue or child-task state until admission returns an id. Ordinary `start()` can bypass the opt-in lane by design, so integration coverage must prove every producer entry point for a constrained kind uses the new seam. Pending requests are process-local and disappear through explicit rejection on teardown rather than persistence or replay.
