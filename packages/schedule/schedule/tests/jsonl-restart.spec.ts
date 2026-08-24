/** Production JSONL restart evidence through the real Agent resume lifecycle. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { freezeMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as toolSchedule from '../src/index.ts'
import {
  ScheduleId,
  createAfterScheduleRecord,
  createScheduleDeliveryPendingChange,
  foldScheduleEvents,
  renderScheduleDeliveryFraming,
  resolveScheduleDueDecision,
} from '../src/domain.ts'
import type { PendingScheduleDelivery } from '../src/domain.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Reminder acknowledged.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    for (const chunk of response) yield chunk
  }
}

async function mountPersistence(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

async function mountRuntime(root: string, adapter: RecordingAdapter): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(toolSchedule)
  return ctx
}

async function disposeContext(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
  await ctx.fiber.dispose()
}

function waitForCompletion(ctx: Context, sessionId: SessionId): Promise<void> {
  return new Promise((resolve) => {
    const stop = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId
        || event.type !== 'schedule/change'
        || event.data.operation !== 'delivery-complete') return
      stop()
      resolve()
    })
  })
}

async function settleCurrentTasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

function appendPendingDelivery(session: Session): PendingScheduleDelivery {
  const record = createAfterScheduleRecord(
    ScheduleId('schedule-1'), 'restart reminder', 1, Date.now() - 60_000,
  )
  session.append('schedule/change', { version: 1, operation: 'create', schedule: record })
  const decision = resolveScheduleDueDecision([record], Date.now())
  if (decision.kind === 'wait') throw new Error('expected overdue Schedule decision')
  session.append(
    'schedule/change',
    createScheduleDeliveryPendingChange(decision, session.seq),
  )
  const pending = foldScheduleEvents(session.events).pendingDelivery
  if (pending === undefined) throw new Error('expected pending Schedule delivery')
  return pending
}

function deliveryMessage(pending: PendingScheduleDelivery) {
  return freezeMessage({
    id: pending.messageId,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: renderScheduleDeliveryFraming(pending) }],
    source: { kind: 'plugin' as const, plugin: 'schedule' },
  })
}

function appendCrashCut(
  session: Session,
  cut: 'pending' | 'next-turn' | 'claimed' | 'admitted',
): PendingScheduleDelivery {
  const pending = appendPendingDelivery(session)
  if (cut === 'pending') return pending
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  const message = deliveryMessage(pending)
  inbox.append('next-turn', message)
  if (cut === 'next-turn') return pending
  session.append('turn/start', { turn: 1 })
  const [claimed] = inbox.claim('next-turn', 1)
  if (claimed === undefined) throw new Error('expected claimed Schedule message')
  if (cut === 'admitted') {
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', claimed, { surfaceOp: 'append' })
  }
  return pending
}

describe('Schedule production JSONL restart', () => {
  it.each([
    ['pending barrier → followup', 'pending', 1],
    ['Inbox append → claim', 'next-turn', 1],
    ['Inbox claim → user/message', 'claimed', 1],
    ['user/message → delivery complete', 'admitted', 0],
  ] as const)('recovers the %s crash cut with one durable user message', async (_label, cut, requests) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-schedule-${cut}-`))
    roots.push(root)
    const sessionId = SessionId(`schedule-jsonl-${cut}`)
    const first = await mountPersistence(root)
    const session = first.sessions.create(sessionId, { meta: { cwd: '/tmp' } })
    const pending = appendCrashCut(session, cut)
    await expect(first.sessions.flush(session)).resolves.toBe(true)
    await disposeContext(first)

    const adapter = new RecordingAdapter()
    const restarted = await mountRuntime(root, adapter)
    const completed = waitForCompletion(restarted, sessionId)
    const handle = await restarted.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await completed
    await handle.agent.whenIdle()
    await expect(restarted.sessions.flush(handle.agent.session)).resolves.toBe(true)

    const stored = await restarted.sessionPersistence.inspect(sessionId)
    expect(adapter.requests).toHaveLength(requests)
    expect(stored.events.filter(event =>
      event.type === 'user/message' && event.data.id === pending.messageId)).toHaveLength(1)
    expect(stored.events.filter(event => event.type === 'schedule/change'
      && event.data.operation === 'delivery-pending')).toHaveLength(1)
    expect(stored.events.filter(event => event.type === 'schedule/change'
      && event.data.operation === 'delivery-complete')).toHaveLength(1)
    expect(foldScheduleEvents(stored.events, stored.meta.seedLength ?? 0)).toEqual({
      active: [],
      seenIds: ['schedule-1'],
    })
    await handle.dispose()
    await disposeContext(restarted)
  })

  it('retains one durable Schedule user message across fresh runtime mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-jsonl-'))
    roots.push(root)
    const sessionId = SessionId('schedule-jsonl-restart')
    const first = await mountPersistence(root)

    const pending = first.sessions.create(sessionId, { meta: { cwd: '/tmp' } })
    const pendingRecord = createAfterScheduleRecord(
      ScheduleId('schedule-1'), 'restart reminder', 1, Date.now() - 60_000,
    )
    pending.append('schedule/change', { version: 1, operation: 'create', schedule: pendingRecord })
    await expect(first.sessions.flush(pending)).resolves.toBe(true)
    await disposeContext(first)

    const dispatchingAdapter = new RecordingAdapter()
    const restarted = await mountRuntime(root, dispatchingAdapter)
    const completed = waitForCompletion(restarted, sessionId)
    const handle = await restarted.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await completed
    await handle.agent.whenIdle()
    await expect(restarted.sessions.flush(handle.agent.session)).resolves.toBe(true)
    const dispatchedStored = await restarted.sessionPersistence.inspect(sessionId)
    expect(foldScheduleEvents(dispatchedStored.events, dispatchedStored.meta.seedLength ?? 0).active)
      .toEqual([])
    const deliveries = dispatchedStored.events.flatMap((event) => {
      if (event.type !== 'schedule/change'
        || (event.data.operation !== 'delivery-pending' && event.data.operation !== 'delivery-complete')) return []
      return [event.data]
    })
    expect(deliveries.map(change => change.operation)).toEqual(['delivery-pending', 'delivery-complete'])
    const messageId = deliveries[0]?.operation === 'delivery-pending'
      ? deliveries[0].messageId
      : undefined
    expect(dispatchedStored.events.filter(event =>
      event.type === 'user/message' && event.data.id === messageId)).toHaveLength(1)
    expect(dispatchingAdapter.requests).toHaveLength(1)
    await handle.dispose()
    await disposeContext(restarted)

    const replayAdapter = new RecordingAdapter()
    const replayed = await mountRuntime(root, replayAdapter)
    const replayHandle = await replayed.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await replayed.sessions.flush(replayHandle.agent.session)
    await replayHandle.agent.whenIdle()
    await settleCurrentTasks()
    await replayed.sessions.flush(replayHandle.agent.session)

    expect(replayAdapter.requests).toEqual([])
    expect(replayHandle.agent.session.events.filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'delivery-complete')).toHaveLength(1)
    const replayedStored = await replayed.sessionPersistence.inspect(sessionId)
    expect(replayedStored.events.filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'delivery-complete')).toHaveLength(1)
    await replayHandle.dispose()
    await disposeContext(replayed)
  })
})
