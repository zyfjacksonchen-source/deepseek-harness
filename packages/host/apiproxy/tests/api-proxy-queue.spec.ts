/** Host-owned queue mutation authorization and snapshot truth. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { MuxFrame, QueueAction, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`queue-${String(nextRpc++)}`), payload }
}

async function harness(): Promise<{
  readonly ctx: Context
  readonly agent: Agent
  readonly inbox: Inbox
  readonly api: ReturnType<typeof createApiProxy>
  readonly steer: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create()
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  const steer = vi.fn()
  const agent = { id: session.id, session, inbox, status: 'running', ctx, steer } as unknown as Agent
  ctx.agents.register(agent)
  return {
    ctx,
    agent,
    inbox,
    steer,
    api: createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    }),
  }
}

function queuedMessage(id: string, source: 'user' | 'schedule') {
  return freezeMessage({
    id: MessageId(id),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: id }],
    source: source === 'user'
      ? { kind: 'user' as const }
      : { kind: 'plugin' as const, plugin: 'schedule' },
  })
}

async function queueBaseline(test: Awaited<ReturnType<typeof harness>>): Promise<MuxFrame & { type: 'session/queue' }> {
  const abort = new AbortController()
  for await (const envelope of test.api.events.mux(request({}), abort.signal)) {
    if (envelope.payload.type !== 'session/queue' || envelope.payload.sessionId !== test.agent.id) continue
    abort.abort()
    return envelope.payload
  }
  throw new Error('queue baseline did not arrive')
}

describe('session.updateQueue ownership', () => {
  it('rejects every public mutation of plugin-owned pending input at the one Host entry', async () => {
    const test = await harness()
    const actions: readonly QueueAction[] = [
      { kind: 'edit', content: [{ type: 'text', text: 'forged' }] },
      { kind: 'remove' },
      { kind: 'steer' },
    ]
    for (const [index, action] of actions.entries()) {
      const item = queuedMessage(`schedule-reserved-${String(index)}`, 'schedule')
      test.inbox.append('next-turn', item)
      const response = await test.api.sessions.updateQueue(request({
        sessionId: test.agent.id,
        itemId: item.id,
        action,
      }))
      expect(response.result).toMatchObject({
        ok: false,
        error: { code: 'queue-item-read-only', details: { itemId: item.id } },
      })
    }
    expect(test.inbox.nextTurn.map(message => message.id)).toEqual([
      'schedule-reserved-0',
      'schedule-reserved-1',
      'schedule-reserved-2',
    ])
    expect(test.steer).not.toHaveBeenCalled()
  })

  it('advertises the same source-owned mutability used by the mutation entry', async () => {
    const test = await harness()
    const user = queuedMessage('user-owned', 'user')
    const schedule = queuedMessage('schedule-owned', 'schedule')
    test.inbox.append('next-turn', user)
    test.inbox.append('next-turn', schedule)

    const frame = await queueBaseline(test)
    expect(frame.items.map(item => ({ id: item.id, mutable: (item as { mutable?: unknown }).mutable })))
      .toEqual([
        { id: user.id, mutable: true },
        { id: schedule.id, mutable: false },
      ])

    const edited = await test.api.sessions.updateQueue(request({
      sessionId: test.agent.id,
      itemId: user.id,
      action: { kind: 'edit', content: [{ type: 'text', text: 'still user owned' }] },
    }))
    expect(edited.result).toMatchObject({ ok: true, value: { accepted: true } })
  })
})
