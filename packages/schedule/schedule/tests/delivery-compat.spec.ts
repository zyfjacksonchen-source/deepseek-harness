import { describe, expect, it } from 'vitest'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createScheduleDeliveryPendingChange,
  decodeScheduleChange,
  decodeScheduleDeliveryChange,
  foldScheduleEvents,
  renderEveryReminderBatchFraming,
  renderReminderFraming,
  renderScheduleDeliveryFraming,
  resolveScheduleDueDecision,
  ScheduleLogError,
} from '../src/domain.ts'

const created = {
  version: 1,
  operation: 'create',
  schedule: {
    id: 'schedule-1',
    kind: 'after',
    prompt: 'downgrade reminder',
    afterSeconds: 1,
    scheduledAt: '2026-08-05T12:00:00.000Z',
  },
} as const

function management(data: unknown, seq: number): SessionEvent {
  return { type: 'schedule/change', seq, time: 1, data } as SessionEvent
}

function delivery(data: unknown, seq: number, ignorable = true): SessionEvent {
  return {
    type: 'schedule/delivery', seq, time: 1, data,
    ...(ignorable ? { ignorable: true } : {}),
  } as unknown as SessionEvent
}

function createdRecord() {
  const decoded = decodeScheduleChange(created)
  if (decoded.operation !== 'create') throw new Error('expected Schedule create')
  if (decoded.schedule.kind === 'every') throw new Error('expected one-shot Schedule create')
  return decoded.schedule
}

function pending() {
  const record = createdRecord()
  const decision = resolveScheduleDueDecision(
    [record],
    Date.parse('2026-08-05T12:00:00.000Z'),
  )
  if (decision.kind === 'wait') throw new Error('expected due Schedule decision')
  return createScheduleDeliveryPendingChange(decision, 1)
}

describe('Schedule delivery downgrade reconciliation', () => {
  it('keeps delivery outside the v1 management decoder and requires an ignorable envelope', () => {
    const change = pending()
    expect(() => decodeScheduleChange(change)).toThrow(ScheduleLogError)
    expect(decodeScheduleDeliveryChange(change)).toEqual(change)
    expect(() => foldScheduleEvents([
      management(created, 0),
      delivery(change, 1, false),
    ])).toThrow(/ignorable/)
  })

  it('keeps pending-only active state identical to a v1 reader', () => {
    const prefix = [management(created, 0), delivery(pending(), 1)]

    expect(foldScheduleEvents(prefix).active).toEqual([created.schedule])
    expect(foldScheduleEvents(prefix.filter(event => event.type === 'schedule/change')).active)
      .toEqual([created.schedule])
  })

  it('retains a pending delivery after an old-pin dispatch until its random message is admitted', () => {
    const change = pending()
    const record = createdRecord()
    const legacy = createUserMessage({
      content: [{ type: 'text', text: renderReminderFraming(record) }],
      source: { kind: 'plugin', plugin: 'schedule' },
    })
    const prefix = [
      management(created, 0),
      delivery(change, 1),
      management({ version: 1, operation: 'dispatch', id: created.schedule.id }, 2),
    ]

    expect(foldScheduleEvents(prefix)).toMatchObject({
      active: [],
      pendingDelivery: {
        deliveryId: change.deliveryId,
        admitted: false,
        legacyMessages: [{ text: renderReminderFraming(record) }],
      },
    })
    expect(foldScheduleEvents([
      ...prefix,
      { type: 'user/message', seq: 3, time: 1, data: legacy, surfaceOp: 'append' },
    ]).pendingDelivery).toMatchObject({
      admitted: true,
    })

    expect(foldScheduleEvents([
      ...prefix,
      { type: 'user/message', seq: 3, time: 1, data: legacy, surfaceOp: 'append' },
      delivery({
        version: 2,
        operation: 'delivery-complete',
        deliveryId: change.deliveryId,
        messageId: change.messageId,
      }, 4),
    ])).toEqual({ active: [], seenIds: ['schedule-1'] })
  })

  it('retroactively unions exact old-pin messages durable before their later dispatch', () => {
    const change = pending()
    const record = createdRecord()
    const legacy = createUserMessage({
      content: [{ type: 'text', text: renderReminderFraming(record) }],
      source: { kind: 'plugin', plugin: 'schedule' },
    })
    const prefix = [management(created, 0), delivery(change, 1)]
    const user = { type: 'user/message', seq: 2, time: 1, data: legacy, surfaceOp: 'append' } as SessionEvent
    const dispatch = management({ version: 1, operation: 'dispatch', id: created.schedule.id }, 3)

    expect(foldScheduleEvents([...prefix, user]).pendingDelivery).toMatchObject({ admitted: false })
    expect(foldScheduleEvents([...prefix, user, dispatch]).pendingDelivery).toMatchObject({
      admitted: true,
      managementDispatches: [],
    })

    const duplicate = {
      type: 'user/message', seq: 3, time: 1,
      data: createUserMessage({
        content: legacy.content,
        source: { kind: 'plugin', plugin: 'schedule' },
      }),
      surfaceOp: 'append',
    } as SessionEvent
    expect(foldScheduleEvents([
      ...prefix,
      user,
      duplicate,
      management({ version: 1, operation: 'dispatch', id: created.schedule.id }, 4),
    ]).pendingDelivery).toMatchObject({ admitted: true })

    const forged = {
      type: 'user/message', seq: 2, time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'not the reconstructed reminder' }],
        source: { kind: 'plugin', plugin: 'schedule' },
      }),
      surfaceOp: 'append',
    } as SessionEvent
    expect(() => foldScheduleEvents([...prefix, forged, dispatch])).toThrow(/conflicting old-pin/)
  })

  it('recovers every torn prefix after zero, one, or all old-pin batch dispatches', () => {
    const creates = [
      {
        version: 1, operation: 'create',
        schedule: {
          id: 'every-a', kind: 'every', prompt: 'A', everySeconds: 300,
          scheduledAt: '2026-08-05T12:05:00.000Z',
        },
      },
      {
        version: 1, operation: 'create',
        schedule: {
          id: 'every-b', kind: 'every', prompt: 'B', everySeconds: 600,
          scheduledAt: '2026-08-05T12:10:00.000Z',
        },
      },
    ] as const
    const records = creates.map((change) => {
      const decoded = decodeScheduleChange(change)
      if (decoded.operation !== 'create') throw new Error('expected Schedule create')
      return decoded.schedule
    })
    const acceptedAt = '2026-08-05T12:17:34.000Z'
    const decision = resolveScheduleDueDecision(records, Date.parse(acceptedAt))
    if (decision.kind !== 'every') throw new Error('expected Every batch')
    const change = createScheduleDeliveryPendingChange(decision, 2)
    const base = [management(creates[0], 0), management(creates[1], 1), delivery(change, 2)]
    const dispatches = records.map(record => ({
      version: 1 as const,
      operation: 'dispatch' as const,
      id: record.id,
      acceptedAt,
    }))
    const legacyText = renderEveryReminderBatchFraming(decision.reminders)

    expect(foldScheduleEvents(base).pendingDelivery?.managementDispatches).toHaveLength(2)
    const partial = foldScheduleEvents([...base, management(dispatches[0], 3)]).pendingDelivery
    expect(partial).toMatchObject({ legacyMessages: [{ text: legacyText }] })
    expect(partial?.managementDispatches).toEqual([dispatches[1]])
    const partialText = renderEveryReminderBatchFraming([decision.reminders[1]!])
    const partialMessage = createUserMessage({
      content: [{ type: 'text', text: partialText }],
      source: { kind: 'plugin', plugin: 'schedule' },
    })
    const partialUser = {
      type: 'user/message', seq: 4, time: 1, data: partialMessage, surfaceOp: 'append',
    } as SessionEvent
    expect(foldScheduleEvents([
      ...base,
      management(dispatches[0], 3),
      partialUser,
    ]).pendingDelivery).toMatchObject({ admitted: false })
    const mirrored = foldScheduleEvents([
      ...base,
      management(dispatches[0], 3),
      partialUser,
      management(dispatches[1], 5),
    ]).pendingDelivery
    expect(mirrored?.managementDispatches).toEqual([])
    expect(mirrored).toMatchObject({
      admitted: false,
      legacyMessages: [{ text: legacyText }, { text: partialText }],
    })
    expect(mirrored?.admittedOccurrenceIds).toEqual([change.occurrences[1]?.occurrenceId])
    expect(renderScheduleDeliveryFraming(mirrored!)).toContain('"schedule_id":"every-a"')
    expect(renderScheduleDeliveryFraming(mirrored!)).not.toContain('"schedule_id":"every-b"')
  })

  it('unions overlapping exact carriers after two forced old-pin crash recoveries', () => {
    const creates = ['a', 'b', 'c'].map(suffix => ({
      version: 1 as const,
      operation: 'create' as const,
      schedule: {
        id: `every-${suffix}`,
        kind: 'every' as const,
        prompt: suffix.toUpperCase(),
        everySeconds: 300,
        scheduledAt: '2026-08-05T12:05:00.000Z',
      },
    }))
    const records = creates.map((change) => {
      const decoded = decodeScheduleChange(change)
      if (decoded.operation !== 'create') throw new Error('expected Schedule create')
      return decoded.schedule
    })
    const acceptedAt = '2026-08-05T12:17:34.000Z'
    const decision = resolveScheduleDueDecision(records, Date.parse(acceptedAt))
    if (decision.kind !== 'every') throw new Error('expected Every batch')
    const change = createScheduleDeliveryPendingChange(decision, 3)
    const dispatches = records.map(record => ({
      version: 1 as const,
      operation: 'dispatch' as const,
      id: record.id,
      acceptedAt,
    }))
    const legacy = (indexes: readonly number[]) => createUserMessage({
      content: [{
        type: 'text',
        text: renderEveryReminderBatchFraming(indexes.map(index => decision.reminders[index]!)),
      }],
      source: { kind: 'plugin', plugin: 'schedule' },
    })
    const legacyBC = legacy([1, 2])
    const legacyC = legacy([2])
    const events = [
      ...creates.map((create, seq) => management(create, seq)),
      delivery(change, 3),
      management(dispatches[0], 4),
      management(dispatches[1], 5),
      { type: 'user/message', seq: 6, time: 1, data: legacyBC, surfaceOp: 'append' } as SessionEvent,
      management(dispatches[2], 7),
      { type: 'user/message', seq: 8, time: 1, data: legacyC, surfaceOp: 'append' } as SessionEvent,
    ]

    const reconciled = foldScheduleEvents(events).pendingDelivery
    expect(reconciled).toMatchObject({ admitted: false })
    expect(reconciled?.admittedOccurrenceIds).toEqual([
      change.occurrences[1]?.occurrenceId,
      change.occurrences[2]?.occurrenceId,
    ])
    expect(renderScheduleDeliveryFraming(reconciled!)).toContain('"schedule_id":"every-a"')
    expect(renderScheduleDeliveryFraming(reconciled!)).not.toContain('"schedule_id":"every-b"')
    expect(renderScheduleDeliveryFraming(reconciled!)).not.toContain('"schedule_id":"every-c"')
  })

  it('keeps a reserved occurrence after delete while deduplicating the old remainder', () => {
    const creates = [
      {
        version: 1, operation: 'create',
        schedule: {
          id: 'every-a', kind: 'every', prompt: 'A', everySeconds: 300,
          scheduledAt: '2026-08-05T12:05:00.000Z',
        },
      },
      {
        version: 1, operation: 'create',
        schedule: {
          id: 'every-b', kind: 'every', prompt: 'B', everySeconds: 600,
          scheduledAt: '2026-08-05T12:10:00.000Z',
        },
      },
    ] as const
    const records = creates.map((change) => {
      const decoded = decodeScheduleChange(change)
      if (decoded.operation !== 'create') throw new Error('expected Schedule create')
      return decoded.schedule
    })
    const acceptedAt = '2026-08-05T12:17:34.000Z'
    const decision = resolveScheduleDueDecision(records, Date.parse(acceptedAt))
    if (decision.kind !== 'every') throw new Error('expected Every batch')
    const change = createScheduleDeliveryPendingChange(decision, 2)
    const bText = renderEveryReminderBatchFraming([decision.reminders[1]!])
    const legacyB = createUserMessage({
      content: [{ type: 'text', text: bText }],
      source: { kind: 'plugin', plugin: 'schedule' },
    })
    const prefix = [
      management(creates[0], 0),
      management(creates[1], 1),
      delivery(change, 2),
      management({ version: 1, operation: 'delete', id: 'every-a' }, 3),
      { type: 'user/message', seq: 4, time: 1, data: legacyB, surfaceOp: 'append' } as SessionEvent,
      management({ version: 1, operation: 'dispatch', id: 'every-b', acceptedAt }, 5),
    ]
    const reconciled = foldScheduleEvents(prefix).pendingDelivery
    if (reconciled === undefined) throw new Error('expected pending delivery')
    expect(reconciled).toMatchObject({ admitted: false })
    expect(renderScheduleDeliveryFraming(reconciled)).toContain('"schedule_id":"every-a"')
    expect(renderScheduleDeliveryFraming(reconciled)).not.toContain('"schedule_id":"every-b"')

    const deterministicA = freezeMessage({
      id: reconciled.messageId,
      role: 'user' as const,
      content: [{ type: 'text' as const, text: renderScheduleDeliveryFraming(reconciled) }],
      source: { kind: 'plugin' as const, plugin: 'schedule' },
    })
    expect(foldScheduleEvents([
      ...prefix,
      { type: 'user/message', seq: 6, time: 1, data: deterministicA, surfaceOp: 'append' },
      delivery({
        version: 2,
        operation: 'delivery-complete',
        deliveryId: change.deliveryId,
        messageId: change.messageId,
      }, 7),
    ])).toEqual({
      active: [expect.objectContaining({ id: 'every-b', scheduledAt: '2026-08-05T12:20:00.000Z' })],
      seenIds: ['every-a', 'every-b'],
    })
  })
})
