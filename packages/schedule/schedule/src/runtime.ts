/**
 * Disposable live timer projection for one exact root agent.
 * @module @deepseek-ai/dsh-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import {
  createScheduleDeliveryPendingChange,
  foldScheduleEvents,
  isPendingScheduleDeliveryMessage,
  isScheduleDeliveryMessage,
  renderScheduleDeliveryFraming,
  resolveScheduleDueDecision,
  ScheduleLogError,
} from './domain.ts'
import type {
  FoldedSchedules,
  PendingScheduleDelivery,
  ScheduleDueDecision,
} from './domain.ts'
import type { ScheduleDeliveryAdmission } from './admission.ts'
import { flushSchedulePersistence } from './persistence.ts'
import { runScheduleTransaction } from './transaction.ts'

/** Largest delay that Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Render an unknown value for process-local diagnostics only. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** One process-local, disposable projection of an exact agent's durable schedules. */
export class ScheduleRuntime {
  private readonly stop = Promise.withResolvers<void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private idleWait: Promise<void> | undefined
  private admissionWait: Promise<void> | undefined
  private run: Promise<void> | undefined
  private requested = false
  private stopping = false
  private faulted = false
  private disposal: Promise<void> | undefined

  /**
   * Construct an inactive runtime; {@link start} begins the first preflight.
   * @param ctx - Global service context.
   * @param agent - Exact live root agent.
   * @param admission - Process-local delivery admission selected before runtime creation.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly admission: ScheduleDeliveryAdmission,
  ) {}

  /** Begin the initial durability preflight and timer derivation. */
  start(): void {
    this.requestDrive()
  }

  /** Recompute the live projection after a committed mutation or idle transition. */
  requestDrive(): void {
    if (this.stopping || this.faulted) return
    this.clearTimer()
    this.requested = true
    if (!this.admission.isOpen) {
      this.waitForAdmission()
      return
    }
    if (this.run !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(() => this.runRequested())
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(`schedule: could not start runtime for agent "${this.agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    this.run = run
    void run.then(
      () => { this.retire(run) },
      (error: unknown) => {
        if (this.isLive()) {
          this.ctx.logger.warn(`schedule: runtime failed for agent "${this.agent.id}": ${renderThrown(error)}`)
        }
        this.faulted = true
        this.retire(run)
      },
    )
  }

  /** Stop future work, cancel timers, and await every outstanding runtime promise. */
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.stopping = true
      this.requested = false
      this.clearTimer()
      this.stop.resolve()
      const pending = [this.run, this.idleWait, this.admissionWait]
        .filter((value): value is Promise<void> => value !== undefined)
      await Promise.allSettled(pending)
    })())
  }

  /** Retain one coalesced trigger until the launcher's one-way gate opens. */
  private waitForAdmission(): void {
    if (this.admissionWait !== undefined) return
    const wait = Promise.race([this.admission.whenOpen(), this.stop.promise])
    this.admissionWait = wait
    void wait.then(() => {
      this.admissionWait = undefined
      if (this.admission.isOpen) this.requestDrive()
    })
  }

  /** Drain coalesced triggers serially. */
  private async runRequested(): Promise<void> {
    while (this.requested && !this.stopping && !this.faulted) {
      this.requested = false
      await runScheduleTransaction(this.agent, () => this.driveOnce())
    }
  }

  /** Retire one exact run and honor a trigger that landed during its final microtask. */
  private retire(run: Promise<void>): void {
    /* v8 ignore next -- only the exact stored run installs this callback. */
    if (this.run !== run) return
    this.run = undefined
    /* v8 ignore next -- covers a trigger in the promise-settlement microtask gap. */
    if (this.requested && !this.stopping && !this.faulted) this.requestDrive()
  }

  /** Whether this exact root lifecycle remains authoritative. */
  private isLive(): boolean {
    return this.ctx.agents.get(this.agent.id) === this.agent
      && this.ctx.agents.roots().includes(this.agent)
  }

  /** Whether this runtime may start or continue Schedule work. */
  private isRunnable(): boolean {
    return this.admission.isOpen && !this.stopping && this.isLive()
  }

  /** Cancel the currently armed timer, if any. */
  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Arm one bounded timer segment; every wake rechecks the wall clock. */
  private arm(target: number, now: number): void {
    if (!this.isRunnable()) return
    const delay = Math.min(target - now, MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestDrive()
    }, delay)
  }

  /** Await one public idle boundary without holding admission or creating a retry timer. */
  private waitForIdle(): void {
    if (this.idleWait !== undefined) return
    const wait = Promise.race([this.agent.whenIdle(), this.stop.promise])
    this.idleWait = wait
    void wait.then(
      () => {
        this.idleWait = undefined
        this.requestDrive()
      },
      (error: unknown) => {
        this.idleWait = undefined
        if (this.isLive()) {
          this.ctx.logger.warn(`schedule: idle wait failed for agent "${this.agent.id}": ${renderThrown(error)}`)
        }
      },
    )
  }

  /** Fold the current exact runtime suffix and contain a corrupt durable stream. */
  private readFolded(): FoldedSchedules | undefined {
    try {
      return foldScheduleEvents(
        this.agent.session.events,
        this.agent.session.header.seedLength ?? 0,
      )
    } catch (error: unknown) {
      this.faulted = true
      const detail = error instanceof ScheduleLogError ? error.message : renderThrown(error)
      this.ctx.logger.warn(`schedule: corrupt schedule log for agent "${this.agent.id}": ${detail}`)
      return undefined
    }
  }

  /** Contain an invalid wall-clock decision without permanently faulting this runtime. */
  private decide(folded: FoldedSchedules, now: number): ScheduleDueDecision | undefined {
    try {
      return resolveScheduleDueDecision(folded.active, now)
    } catch (error: unknown) {
      this.ctx.logger.warn(`schedule: fixed-rate decision failed for agent "${this.agent.id}": ${renderThrown(error)}`)
      return undefined
    }
  }

  /** Requeue the exact pending message, replacing a cold pending copy to wake its Agent. */
  private queuePending(delivery: PendingScheduleDelivery): boolean {
    if (!this.isRunnable()) return false
    const deterministic = freezeMessage({
      id: delivery.messageId,
      role: 'user' as const,
      content: [{ type: 'text' as const, text: renderScheduleDeliveryFraming(delivery) }],
      source: { kind: 'plugin' as const, plugin: 'schedule' },
    })
    if (this.agent.inbox.nextStep.some(candidate => candidate.id === delivery.messageId)) {
      this.faulted = true
      this.ctx.logger.warn(
        `schedule: pending identity appeared in the next-step Inbox for agent "${this.agent.id}"`,
      )
      return false
    }
    const reserved = this.agent.inbox.nextTurn
      .find(candidate => candidate.id === delivery.messageId)
    if (reserved !== undefined && !isScheduleDeliveryMessage(reserved, delivery)) {
      this.faulted = true
      this.ctx.logger.warn(
        `schedule: pending Inbox identity conflicted for agent "${this.agent.id}"`,
      )
      return false
    }
    const matching = this.agent.inbox.nextTurn
      .filter(candidate => isPendingScheduleDeliveryMessage(candidate, delivery))
    try {
      for (const candidate of matching) {
        if (!this.agent.inbox.remove(candidate.id)) {
          throw new Error('pending message disappeared before Schedule could wake it')
        }
      }
      this.agent.followup(deterministic)
      return true
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(
          `schedule: deterministic followup failed for agent "${this.agent.id}": ${renderThrown(error)}`,
        )
      }
      return this.agent.inbox.nextTurn.some(candidate =>
        isPendingScheduleDeliveryMessage(candidate, delivery))
    }
  }

  /** Remove any second compatible copy after one current or old-pin message is durable. */
  private discardPendingCopies(delivery: PendingScheduleDelivery): boolean {
    if (!this.isRunnable()) return false
    for (const message of [...this.agent.inbox.nextStep, ...this.agent.inbox.nextTurn]) {
      if (isPendingScheduleDeliveryMessage(message, delivery)
        && !this.agent.inbox.remove(message.id)) {
        throw new Error('pending message disappeared before Schedule could discard its duplicate')
      }
    }
    return true
  }

  /** Append the still-missing v1 state mirrors before any reminder can enter Inbox. */
  private appendManagementDispatches(delivery: PendingScheduleDelivery): boolean {
    if (!this.isRunnable()) return false
    for (const change of delivery.managementDispatches) {
      this.agent.session.append('schedule/change', change)
    }
    return true
  }

  /** Preflight, fold, arm, or dispatch the next one-shot or fixed-rate batch. */
  private async driveOnce(): Promise<void> {
    this.clearTimer()
    if (!this.isRunnable()) return
    try {
      await flushSchedulePersistence(this.ctx, this.agent.session)
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(`schedule: preflight failed for agent "${this.agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    if (!this.isRunnable()) return

    const folded = this.readFolded()
    if (folded === undefined) return
    if (folded.pendingDelivery === undefined) {
      const wakeNow = Date.now()
      const wakeDecision = this.decide(folded, wakeNow)
      if (wakeDecision === undefined) return
      if (wakeDecision.kind === 'wait') {
        if (wakeDecision.target !== undefined) this.arm(wakeDecision.target, wakeNow)
        return
      }
    }

    let maintenance: Promise<'none' | 'queued' | 'completed'>
    try {
      maintenance = this.agent.runMaintenance(async () => {
        if (!this.isRunnable()) return 'none'
        const claimed = this.readFolded()
        if (claimed === undefined) return 'none'
        if (claimed.pendingDelivery !== undefined) {
          let delivery = claimed.pendingDelivery
          if (delivery.managementDispatches.length !== 0) {
            if (!this.appendManagementDispatches(delivery)) return 'none'
            try {
              await flushSchedulePersistence(this.ctx, this.agent.session)
            } catch (error: unknown) {
              if (this.isLive()) {
                this.ctx.logger.warn(
                  `schedule: management dispatch barrier failed for agent "${this.agent.id}": ${renderThrown(error)}`,
                )
              }
              return 'none'
            }
            if (!this.isRunnable()) return 'none'
            const reconciled = this.readFolded()?.pendingDelivery
            if (reconciled === undefined || reconciled.deliveryId !== delivery.deliveryId
              || reconciled.managementDispatches.length !== 0) return 'none'
            delivery = reconciled
          }
          if (delivery.admitted) {
            if (!this.discardPendingCopies(delivery) || !this.isRunnable()) return 'none'
            this.agent.session.append('schedule/delivery', {
              version: 2,
              operation: 'delivery-complete',
              deliveryId: delivery.deliveryId,
              messageId: delivery.messageId,
            }, { ignorable: true })
            return 'completed'
          }
          return this.queuePending(delivery) ? 'queued' : 'none'
        }
        const decisionNow = Date.now()
        const decision = this.decide(claimed, decisionNow)
        if (decision === undefined) return 'none'
        if (decision.kind === 'wait') {
          if (decision.target !== undefined) this.arm(decision.target, decisionNow)
          return 'none'
        }
        const pendingChange = createScheduleDeliveryPendingChange(decision, this.agent.session.seq)
        try {
          if (!this.isRunnable()) return 'none'
          this.agent.session.append('schedule/delivery', pendingChange, { ignorable: true })
          const reserved = this.readFolded()?.pendingDelivery
          if (reserved === undefined || reserved.deliveryId !== pendingChange.deliveryId) {
            throw new Error('delivery-pending did not become the current Schedule outbox row')
          }
          if (!this.appendManagementDispatches(reserved)) return 'none'
        } catch (error: unknown) {
          this.faulted = true
          this.clearTimer()
          this.ctx.logger.warn(
            `schedule: delivery-pending append failed for agent "${this.agent.id}": ${renderThrown(error)}`,
          )
          return 'none'
        }
        try {
          await flushSchedulePersistence(this.ctx, this.agent.session)
        } catch (error: unknown) {
          if (this.isLive()) {
            this.ctx.logger.warn(
              `schedule: delivery-pending barrier failed for agent "${this.agent.id}": ${renderThrown(error)}`,
            )
          }
          return 'none'
        }
        if (!this.isRunnable()) return 'none'
        const admitted = this.readFolded()?.pendingDelivery
        if (admitted === undefined
          || admitted.deliveryId !== pendingChange.deliveryId
          || admitted.messageId !== pendingChange.messageId
          || admitted.managementDispatches.length !== 0) return 'none'
        return this.queuePending(admitted) ? 'queued' : 'none'
      })
    } catch (_busy: unknown) {
      // `runMaintenance` rejects synchronously only while another agent activity owns the idle phase.
      if (this.isLive()) this.waitForIdle()
      return
    }
    const outcome = await maintenance
    if (outcome === 'none') return

    try {
      await flushSchedulePersistence(this.ctx, this.agent.session)
    } catch (error: unknown) {
      if (this.isLive()) {
        this.ctx.logger.warn(`schedule: delivery barrier failed for agent "${this.agent.id}": ${renderThrown(error)}`)
      }
      return
    }
    if (outcome === 'completed' && this.isRunnable()) this.requestDrive()
  }
}
