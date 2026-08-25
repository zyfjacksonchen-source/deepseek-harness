# Agent Note: Cross-owner kind job admission

Status: implemented

English | [中文](2026-08-25-cross-owner-kind-job-admission.zh.md)

## Problem

The existing `maxConcurrentJobsPerOwner` policy correctly bounds each exact Agent, but it cannot express a producer resource shared by unrelated Sessions. Two parent Agents can each pass their own bucket and start the same expensive producer kind concurrently. Serializing that work in a product plugin with a module-global flag, Promise tail, or private queue would duplicate Job lifecycle and lose exact owner cancellation during reload or teardown.

Some producers also release their scarce resource when their Job settles while a surrounding child Agent may take longer, or fail, to dispose. Waiting for that child lifecycle would hold capacity after the authoritative producer resource is gone.

## Decision

`JobRegistry` exposes `startWhenAvailable(spec, signal?)`, which returns `{ id, admitted: Promise<void> }` immediately after ordinary validation and per-owner admission register a real Job. The original exact Agent is its owner while it waits, so existing access, kill, read, notice, and cleanup contracts apply before producer execution. `admitted` resolves after `run()` returns and its hooks are installed; producer `done` remains the separate terminal settlement.

`LocalJobRegistry` delays only `run()`. Its per-kind FIFO stores JobIds, while each authoritative `TrackedTask` carries a private waiting, started, or settled phase and all admission Promise state. A waiting Job is publicly `running`, has no producer hooks or execution resource, and counts toward its exact owner's ordinary limit. Each kind retains at most 64 waiters; the 65th fails before id allocation or producer execution, after the owner limit is checked. Terminal Job settlement commits the record, publishes the visible-set change, and then drains the next id before completion listeners may wake an owner. A producer fiber, child Agent, or child-disposal Promise cannot release or hold the lane.

The caller's AbortSignal and native `kill` cancel only a Job that is still waiting: they remove its id from the FIFO, settle the record as `killed`, and reject `admitted` without calling `run()`. Exact owner disposal and service disposal do the same for every matching waiter and settle every admission Promise before teardown returns. A synchronous starter throw rejects `admitted`, settles the already allocated Job as `failed`, and lets the next FIFO id try the released lane. First-wins settlement prevents a late producer outcome or repeated cancellation from releasing the lane or notifying twice.

Ordinary `start()` remains synchronous, immediate, and unqueued. It observes the same Job records but does not join the FIFO, so a producer that requires this product-wide bound must route every start of its constrained kind through `startWhenAvailable()` and observe `admitted`. The lane capacity is fixed at one until a measured consumer justifies a wider native contract; this change adds no priority, retry, persistence, durable queue, generic scheduler, or public Job state.

## Verification

The Service Definition test pins the synchronous handle and `Promise<void>` barrier. The process-local provider suite uses real `Session`-backed parent Agents to pin immediate native visibility, queued kill and abort terminal state, cross-owner FIFO order, terminal-only release, owner-scoped access, independent kinds, owner and service teardown Promise settlement, synchronous starter failure on the allocated id, first-wins release, owner-limit priority, and rejection of the 65th waiter without id allocation or producer execution. A real Cordis Loader composition loads the provider row and proves two parent Sessions cannot start the same producer kind together.

## Alternatives considered

**Keep a product-plugin global boolean, Promise tail, or private queue.** Rejected because it creates a second lifecycle owner outside `JobRegistry`; reload, owner disposal, and service teardown can strand the lock or admit work after its Agent disappeared.

**Use `maxConcurrentJobsPerOwner: 1`.** Rejected because the two competing parents are different exact Agents and therefore occupy different intended buckets. Changing the existing policy to one process-wide owner bucket would let one unrelated producer deny every other Job kind and Session.

**Wait for the surrounding child Agent to dispose.** Rejected because the Job's `done` settlement is the authority that the producer resource has quiesced. A hanging child cleanup must not hold a released image/provider slot.

**Add a generic scheduler with configurable parallelism, priorities, and retries.** Rejected because the current need is exactly one FIFO slot for one opted-in kind. No measurement or consumer contract justifies additional scheduling vocabulary.

## Consequences

Two unrelated owners can share one scarce producer lane without losing ordinary Job ownership or adding a product-local scheduler. A waiting Job is intentionally visible through the existing Job API without adding a public waiting status; callers use its id immediately and await `admitted` only when producer startup matters. Ordinary `start()` can bypass the opt-in lane by design, so integration coverage must prove every producer entry point for a constrained kind uses the new method. Waiting Jobs remain process-local and settle through normal lifecycle teardown rather than persistence or replay.
