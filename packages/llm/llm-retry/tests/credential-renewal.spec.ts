import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import type { MockLlmBehavior, MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import type { CredentialRef, ResolvedCredential } from '../../../credentials/credentials/src/index.ts'
import * as Retry from '../src/index.ts'

/**
 * A provider whose stored value rotates, standing in for any reference whose
 * value has its own lifetime (an OAuth access token, a gateway session token).
 * The stored value is the seed; every resolution for use issues the next value,
 * so an attempt that renewed is distinguishable on the wire from one that did
 * not.
 */
class RotatingCredentials extends MemoryCredentials {
  readonly issued: string[] = []

  private readonly options = ROTATING

  override resolveCurrent(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.options.values[Math.min(this.issued.length, this.options.values.length - 1)]!
    this.issued.push(value)
    return this.set(ref, value).then(() => ({ value, source: 'memory' }))
  }
}

/** A provider whose renewal fails, standing in for an unreachable refresh endpoint. */
class FailingRenewalCredentials extends MemoryCredentials {
  override resolveCurrent(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.reject(new Error('credential renewal is unavailable'))
  }
}

const REF = 'ROTATING_MODEL_TOKEN'
const ROTATING: { ref: string; values: readonly string[] } = { ref: REF, values: ['token-1', 'token-2'] }
const STATIC = { [REF]: 'token-1' }

let context: Context | undefined
const servers: MockLlmServer[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(servers.splice(0).map(server => server.close()))
})

async function start(
  sequence: readonly MockLlmBehavior[],
  options: Omit<Parameters<typeof startMockLlmServer>[0], 'sequence'> = {},
): Promise<MockLlmServer> {
  const server = await startMockLlmServer({ sequence, ...options })
  servers.push(server)
  return server
}

async function harness(
  baseURL: string,
  provider: typeof MemoryCredentials,
  config: Record<string, string> | undefined,
): Promise<{ ctx: Context; credentials: RotatingCredentials }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(provider, config)
  await ctx.plugin(LlmDeepSeek, {
    baseURL,
    apiKeyEnv: REF,
    retryPolicy: {
      mode: 'normal',
      maxRetries: 2,
      backoff: { initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
    },
  })
  await ctx.plugin(Retry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, credentials: ctx.credentials as RotatingCredentials }
}

function sendAndWait(_ctx: Context, agent: Agent): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'authenticate through the provider boundary' }],
    source: { kind: 'user' },
  }))
  return agent.whenIdle()
}

function finalAssistantText(agent: Agent): string | undefined {
  const message = agent.session.deriveMessages().at(-1)
  if (message?.role !== 'assistant') return undefined
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function authorizationHeaders(server: MockLlmServer): (string | undefined)[] {
  return server.requests.map(record => record.headers.authorization)
}

describe('the model path authenticates each attempt with the credential issued for it', () => {
  it('sends the value the provider made current, not the stored one', async () => {
    const server = await start(['success'], { successText: 'renewed before the request' })
    const { ctx, credentials } = await harness(server.baseURL, RotatingCredentials, STATIC)
    const agent = await ctx.agentLoop.create(SessionId('renew-before-request'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await sendAndWait(ctx, agent)

    expect(credentials.issued).toEqual(['token-1'])
    expect(authorizationHeaders(server)).toEqual(['Bearer token-1'])
    expect(finalAssistantText(agent)).toBe('renewed before the request')
  })

  it('authenticates a retried attempt with the credential renewed for it', async () => {
    const server = await start(['stream_disconnect', 'success'], {
      partialText: 'discard me',
      chunkSize: 100,
      disconnectDelayMs: 20,
      successText: 'recovered under a renewed credential',
    })
    const { ctx, credentials } = await harness(server.baseURL, RotatingCredentials, STATIC)
    const agent = await ctx.agentLoop.create(SessionId('renew-per-attempt'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await sendAndWait(ctx, agent)

    expect(credentials.issued).toEqual(['token-1', 'token-2'])
    expect(authorizationHeaders(server)).toEqual(['Bearer token-1', 'Bearer token-2'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
      .map(event => event.data.failure.code)).toEqual(['TRANSPORT'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      .map(event => [event.data.turn, event.data.step])).toEqual([[1, 1]])
    expect(finalAssistantText(agent)).toBe('recovered under a renewed credential')
  })

  it('keeps the stored value for a provider that renews nothing', async () => {
    const server = await start(['success'], { successText: 'static credential' })
    const { ctx } = await harness(server.baseURL, MemoryCredentials, STATIC)
    const agent = await ctx.agentLoop.create(SessionId('no-renewal'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await sendAndWait(ctx, agent)

    // The seam default delegates to the stored value, so a provider holding no
    // rotating credential authenticates exactly as it did before.
    expect(authorizationHeaders(server)).toEqual(['Bearer token-1'])
    expect(finalAssistantText(agent)).toBe('static credential')
  })

  it('fails the attempt instead of falling back when renewal is unavailable', async () => {
    const server = await start(['success'], { successText: 'never reached' })
    const { ctx } = await harness(server.baseURL, FailingRenewalCredentials, STATIC)
    const agent = await ctx.agentLoop.create(SessionId('renewal-unavailable'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await sendAndWait(ctx, agent)

    expect(server.requests).toHaveLength(0)
    const end = agent.session.snapshotEvents().at(-1)
    expect(end).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
    if (end?.type === 'turn/end' && end.data.reason.kind === 'error') {
      expect(end.data.reason.error.message).toBe('credential renewal is unavailable')
    }
  })
})
