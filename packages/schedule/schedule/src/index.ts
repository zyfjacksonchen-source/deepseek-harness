/**
 * Agent-scoped durable one-shot and fixed-rate reminders over the session event log.
 * @module @deepseek-ai/dsh-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { ScheduleDeliveryAdmission } from './admission.ts'
import { ScheduleRuntime } from './runtime.ts'
import { registerScheduleTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned one-way gate for Schedule delivery work. */
    scheduleDeliveryAdmission?: ScheduleDeliveryAdmission
  }
}

export type * from './types.ts'
export {
  SCHEDULE_CHANGE_VERSION,
  SCHEDULE_DELIVERY_VERSION,
  MIN_EVERY_INTERVAL_SECONDS,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  allocateScheduleId,
  createScheduleDeliveryPendingChange,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  decodeScheduleChange,
  decodeScheduleDeliveryChange,
  foldScheduleEvents,
  isLegacyScheduleDeliveryMessage,
  isPendingScheduleDeliveryMessage,
  renderReminderFraming,
  renderEveryReminderBatchFraming,
  resolveEveryOccurrence,
  resolveScheduleDueDecision,
  renderScheduleDeliveryFraming,
  scheduleView,
} from './domain.ts'
export { registerScheduleTools } from './tools.ts'
export { ScheduleDeliveryAdmission } from './admission.ts'

/** Cordis function-plugin name. */
export const name = 'schedule'
/** Services required before future root agents can receive Schedule. */
export const inject = ['agents', 'sessions', 'tools', 'sessionPersistence']

type OwnerCleanup = () => void | Promise<void>

/** Install Schedule only for root agents published after this plugin loads. */
export function apply(ctx: Context): void {
  const runtimes = new Map<Agent, OwnerCleanup>()
  let stopping = false

  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
      const admission = ctx.get('scheduleDeliveryAdmission') ?? new ScheduleDeliveryAdmission(true)
      const runtime = new ScheduleRuntime(ctx, agent, admission)
      const cleanup: OwnerCleanup = agent.ctx.effect(() => {
        const disposeTools = registerScheduleTools(ctx, agent.ctx, agent, () => { runtime.requestDrive() })
        const stopStatus = agent.ctx.on('agent/status', ({ status }) => {
          if (status === 'idle' && agent.session.events.some(event =>
            event.type === 'schedule/change' || event.type === 'schedule/delivery')) {
            runtime.requestDrive()
          }
        })
        runtime.start()
        return async () => {
          stopStatus()
          disposeTools()
          try {
            await runtime.dispose()
          } finally {
            if (runtimes.get(agent) === cleanup) runtimes.delete(agent)
          }
        }
      }, 'schedule.runtime()')
      runtimes.set(agent, cleanup)
    })

    return async () => {
      stopping = true
      stopCreated()
      const cleanups = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(cleanups.map(cleanup => Promise.resolve(cleanup())))
    }
  }, 'schedule.lifecycle()')
}
