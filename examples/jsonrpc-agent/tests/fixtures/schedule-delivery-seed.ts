/** Seed one valid Schedule delivery crash prefix after the SDK prompt receipt. */

import type { Context } from '@deepseek-ai/cordis'
import {
  createAfterScheduleRecord,
  createScheduleDeliveryPendingChange,
  resolveScheduleDueDecision,
  ScheduleId,
} from '@deepseek-ai/dsh-schedule'

/** Fixture plugin name. */
export const name = 'schedule-delivery-seed'

/** Append one real v1-management/v2-delivery prefix to each root SDK interval. */
export function apply(ctx: Context): void {
  const seeded = new WeakSet<object>()
  ctx.effect(() => {
    const dispose = ctx.root.on('session/event', (session, event) => {
      if (event.type !== 'turn/start' || session.header.parentSession !== undefined || seeded.has(session)) return
      seeded.add(session)
      queueMicrotask(() => {
        const record = createAfterScheduleRecord(
          ScheduleId('sdk-snapshot-schedule'),
          'SDK snapshot Schedule delivery',
          1,
          Date.parse('2026-08-05T11:59:59.000Z'),
        )
        session.append('schedule/change', { version: 1, operation: 'create', schedule: record })
        const decision = resolveScheduleDueDecision([record], Date.parse(record.scheduledAt))
        if (decision.kind === 'wait') throw new Error('Schedule SDK fixture expected a due decision')
        const pending = createScheduleDeliveryPendingChange(decision, session.seq)
        session.append('schedule/delivery', pending, { ignorable: true })
        session.append('schedule/change', { version: 1, operation: 'dispatch', id: record.id })
      })
    }, { global: true })
    return () => { dispose() }
  }, 'schedule-delivery-seed.listener')
}
