import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as toolSchedule from '../src/index.ts'

class PersistenceProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('Schedule plugin composition', () => {
  it('has the Loader-safe function-plugin export shape', () => {
    expect('default' in toolSchedule).toBe(false)
    expect(toolSchedule.name).toBe('schedule')
    expect(toolSchedule.inject).toEqual(['agents', 'sessions', 'tools', 'sessionPersistence'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(toolSchedule)).toBe(toolSchedule)
  })

  it('installs only on future root agents and unwinds on plugin disposal', async () => {
    const ctx = await harness()
    const existing = await ctx.agents.create({ sessionId: SessionId('schedule-existing') })
    const plugin = await ctx.plugin(toolSchedule)
    expect(ctx.tools.get('schedule_create', existing.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_create')).toBeUndefined()

    const root = await ctx.agents.create({ sessionId: SessionId('schedule-root') })
    expect(ctx.tools.get('schedule_create', root.agent)?.name).toBe('schedule_create')
    expect(ctx.tools.get('schedule_list', root.agent)?.name).toBe('schedule_list')
    expect(ctx.tools.get('schedule_delete', root.agent)?.name).toBe('schedule_delete')
    expect(ctx.tools.get('schedule_create')).toBeUndefined()

    const created = await ctx.agents.withInitiator(root.agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('schedule-plugin-create'),
      name: 'schedule_create',
      arguments: { prompt: 'future reminder', after_seconds: 3_600 },
      agent: root.agent,
    }))
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error('expected Schedule create value')
    expect(created.value).toMatchObject({ id: 'schedule-1', deliveryMode: 'session-local' })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'running' })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'idle' })

    const child = await root.agent.ctx.agents.create({ sessionId: SessionId('schedule-child') })
    expect(ctx.agents.roots()).toEqual([existing.agent, root.agent])
    expect(ctx.tools.get('schedule_create', child.agent)).toBeUndefined()

    const departing = await ctx.agents.create({ sessionId: SessionId('schedule-departing') })
    expect(ctx.tools.get('schedule_create', departing.agent)).toBeDefined()
    await departing.dispose()
    expect(ctx.tools.get('schedule_create', departing.agent)).toBeUndefined()

    await plugin.dispose()
    expect(ctx.tools.get('schedule_create', root.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_list', root.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_delete', root.agent)).toBeUndefined()

    await child.dispose()
    await root.dispose()
    await existing.dispose()
    await ctx.fiber.dispose()
  })

  it('does not checkpoint unrelated idle sessions', async () => {
    const ctx = await harness()
    const plugin = await ctx.plugin(toolSchedule)
    const root = await ctx.agents.create({ sessionId: SessionId('schedule-unrelated-idle') })
    await settle()
    let flushes = 0
    const stopFlush = ctx.on('session/flush', (session) => {
      if (session === root.agent.session) flushes += 1
    })

    agentEvents(ctx, root.agent).emit('agent/status', { status: 'running' })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'idle' })
    await settle()
    expect(flushes).toBe(0)

    stopFlush()
    await root.dispose()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('holds a due delivery behind a launcher-provided closed admission', async () => {
    const ctx = await harness()
    const plugin = await ctx.plugin(toolSchedule)
    const admission = new toolSchedule.ScheduleDeliveryAdmission(false)
    ctx.provide('scheduleDeliveryAdmission', admission)
    const root = await ctx.agents.create({ sessionId: SessionId('schedule-probation') })
    root.agent.session.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: toolSchedule.createAfterScheduleRecord(
        toolSchedule.ScheduleId('schedule-1'),
        'probation reminder',
        1,
        Date.now() - 2_000,
      ),
    })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'idle' })
    const managed = await ctx.agents.withInitiator(root.agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('schedule-probation-create'),
      name: 'schedule_create',
      arguments: { prompt: 'managed while closed', after_seconds: 3_600 },
      agent: root.agent,
    }))
    await settle()

    expect(managed.isError).toBe(false)
    expect(managed.value).toMatchObject({ id: 'schedule-2', deliveryMode: 'session-local' })
    expect(root.agent.session.events.filter(event => event.type === 'schedule/delivery')).toEqual([])
    expect(root.agent.inbox.nextStep).toEqual([])
    expect(root.agent.inbox.nextTurn).toEqual([])

    admission.open()
    await settle()
    await root.agent.whenIdle()
    await settle()
    expect(root.agent.session.events.filter(event =>
      event.type === 'schedule/delivery' && event.data.operation === 'delivery-pending')).toHaveLength(1)
    expect(root.agent.session.events.filter(event =>
      event.type === 'schedule/delivery' && event.data.operation === 'delivery-complete')).toHaveLength(1)

    await root.dispose()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('admits delivery by default when no launcher controller is provided', async () => {
    const ctx = await harness()
    const plugin = await ctx.plugin(toolSchedule)
    const root = await ctx.agents.create({ sessionId: SessionId('schedule-default-admission') })
    root.agent.session.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: toolSchedule.createAfterScheduleRecord(
        toolSchedule.ScheduleId('schedule-1'),
        'ordinary reminder',
        1,
        Date.now() - 2_000,
      ),
    })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'idle' })
    await settle()
    await root.agent.whenIdle()
    await settle()

    expect(root.agent.session.events.filter(event =>
      event.type === 'schedule/delivery' && event.data.operation === 'delivery-pending')).toHaveLength(1)
    expect(root.agent.session.events.filter(event =>
      event.type === 'schedule/delivery' && event.data.operation === 'delivery-complete')).toHaveLength(1)

    await root.dispose()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })
})
