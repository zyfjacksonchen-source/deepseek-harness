import { describe, expect, it } from 'vitest'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createScheduleDeliveryPendingChange,
  foldScheduleEvents,
  renderEveryReminderBatchFraming,
  resolveScheduleDueDecision,
  ScheduleId,
} from '../src/domain.ts'
import type { EveryScheduleRecord } from '../src/types.ts'

describe('Schedule replay performance gate', () => {
  it('folds an exact 5000-event high-frequency v2 stream within 750ms', () => {
    const events: SessionEvent[] = []
    let record: EveryScheduleRecord = {
      id: ScheduleId('schedule-hot'),
      kind: 'every',
      prompt: 'high-frequency gate',
      everySeconds: 300,
      scheduledAt: '2026-08-05T12:05:00.000Z',
    }
    events.push({
      type: 'schedule/change', seq: 0, time: 1,
      data: { version: 1, operation: 'create', schedule: record },
    })

    for (let cycle = 0; cycle < 1_249; cycle += 1) {
      const acceptedAt = record.scheduledAt
      const decision = resolveScheduleDueDecision([record], Date.parse(acceptedAt))
      if (decision.kind !== 'every') throw new Error('expected due Every decision')
      const pending = createScheduleDeliveryPendingChange(decision, events.length)
      events.push({
        type: 'schedule/delivery', seq: events.length, time: 1,
        data: pending, ignorable: true,
      } as unknown as SessionEvent)
      events.push({
        type: 'schedule/change', seq: events.length, time: 1,
        data: { version: 1, operation: 'dispatch', id: record.id, acceptedAt },
      })
      events.push({
        type: 'user/message', seq: events.length, time: 1, surfaceOp: 'append',
        data: freezeMessage({
          id: pending.messageId,
          role: 'user' as const,
          content: [{ type: 'text' as const, text: renderEveryReminderBatchFraming(decision.reminders) }],
          source: { kind: 'plugin' as const, plugin: 'schedule' },
        }),
      })
      events.push({
        type: 'schedule/delivery', seq: events.length, time: 1, ignorable: true,
        data: {
          version: 2,
          operation: 'delivery-complete',
          deliveryId: pending.deliveryId,
          messageId: pending.messageId,
        },
      } as unknown as SessionEvent)
      record = { ...record, scheduledAt: new Date(Date.parse(acceptedAt) + 300_000).toISOString() }
    }

    const future = {
      id: ScheduleId('schedule-future'), kind: 'after' as const, prompt: 'future',
      afterSeconds: 1, scheduledAt: '9999-12-31T23:59:59.999Z',
    }
    events.push({ type: 'schedule/change', seq: events.length, time: 1, data: {
      version: 1, operation: 'create', schedule: future,
    } })
    events.push({ type: 'schedule/change', seq: events.length, time: 1, data: {
      version: 1, operation: 'delete', id: future.id,
    } })
    events.push({ type: 'schedule/change', seq: events.length, time: 1, data: {
      version: 1, operation: 'create', schedule: { ...future, id: ScheduleId('schedule-retained') },
    } })

    expect(events).toHaveLength(5_000)
    const started = performance.now()
    const folded = foldScheduleEvents(events)
    const elapsed = performance.now() - started
    expect(folded.pendingDelivery).toBeUndefined()
    expect(folded.active.map(item => item.id)).toEqual(['schedule-hot', 'schedule-retained'])
    expect(elapsed).toBeLessThan(750)
  })
})
