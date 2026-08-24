import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate as settleImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as toolSchedule from '../../src/index.ts'
import { foldScheduleEvents } from '../../src/domain.ts'

type Phase = 'old-initial' | 'current-upgrade' | 'old-final'
  | 'forced-old-crash' | 'forced-old-recover' | 'forced-current-upgrade' | 'forced-old-final'

interface Scenario {
  readonly id: string
  readonly cut: 'pending-only' | 'partial-dispatch-no-user' | 'dispatch-no-user' | 'dispatch-user'
    | 'user-before-dispatch' | 'complete'
  readonly oldInitialScheduleRequests: number
  readonly currentUpgradeScheduleRequests: number
}

interface GateMetadata {
  readonly anchorAt: string
  readonly nextAt: string
  readonly everySeconds: number
  readonly prompts: readonly string[]
  readonly scenarios: readonly Scenario[]
  readonly forcedScenario: {
    readonly id: string
    readonly prompts: readonly string[]
  }
}

interface CompatFold {
  readonly active: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly prompt: string
    readonly everySeconds: number
    readonly scheduledAt: string
  }>
  readonly pendingDelivery?: {
    readonly admitted: boolean
    readonly admittedOccurrenceIds?: readonly string[]
  }
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'compat response' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function eventType(event: SessionEvent): string {
  return (event as { readonly type: string }).type
}

function deliveryEvents(events: readonly SessionEvent[]): Array<{
  readonly ignorable?: true
  readonly data: { readonly version?: number; readonly operation?: string }
}> {
  return events
    .filter(event => eventType(event) === 'schedule/delivery')
    .map(event => event as unknown as {
      readonly ignorable?: true
      readonly data: { readonly version?: number; readonly operation?: string }
    })
}

function scheduleRequestTexts(requests: readonly GenerateOptions[]): string[] {
  return requests.flatMap((request) => {
    const user = request.messages.findLast(message => message.role === 'user')
    const text = user?.content.find(block => block.type === 'text')?.text
    return text?.startsWith('[SCHEDULE REMINDER') === true ? [text] : []
  })
}

function scheduleRequests(requests: readonly GenerateOptions[]): number {
  return scheduleRequestTexts(requests).length
}

function promptCounts(texts: readonly string[], prompts: readonly string[]): number[] {
  return prompts.map(prompt => texts.filter(text => text.includes(JSON.stringify(prompt))).length)
}

function expectedPromptIndexes(phase: Phase, cut: Scenario['cut']): readonly number[] {
  if (phase === 'old-initial') {
    if (cut === 'pending-only') return [0, 1]
    if (cut === 'partial-dispatch-no-user') return [1]
  }
  if (phase === 'current-upgrade') {
    if (cut === 'partial-dispatch-no-user') return [0]
    if (cut === 'dispatch-no-user') return [0, 1]
  }
  return []
}

function durableScheduleInputs(events: readonly SessionEvent[]): Array<{
  readonly id: string
  readonly text: string
}> {
  return events.flatMap((event) => {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== 'schedule') return []
    const text = event.data.content.find(block => block.type === 'text')?.text
    return text === undefined ? [] : [{ id: event.data.id, text }]
  })
}

function folded(events: readonly SessionEvent[], seedLength = 0): CompatFold {
  return foldScheduleEvents(events, seedLength) as unknown as CompatFold
}

function assertEveryRecords(
  state: CompatFold,
  metadata: GateMetadata,
  prompts: readonly string[],
  scheduledAt: readonly string[],
): void {
  assert.deepEqual(state.active, prompts.map((prompt, index) => ({
    id: `schedule-${index + 1}`,
    kind: 'every',
    prompt,
    everySeconds: metadata.everySeconds,
    scheduledAt: scheduledAt[index],
  })))
}

function assertEveryState(state: CompatFold, metadata: GateMetadata, scheduledAt: readonly string[]): void {
  assertEveryRecords(state, metadata, metadata.prompts, scheduledAt)
}

function waitForSessionEvent(
  ctx: Context,
  sessionId: SessionId,
  matches: (event: SessionEvent) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`timed out waiting for a compatibility event in ${sessionId}`))
    }, 10_000)
    const stop = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId || !matches(event)) return
      clearTimeout(timer)
      stop()
      resolve()
    })
  })
}

async function scheduleList(ctx: Context, agent: Agent) {
  return await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`downgrade-list-${agent.id}`),
    name: 'schedule_list',
    arguments: {},
    agent,
  }))
}

async function runScenario(
  ctx: Context,
  adapter: RecordingAdapter,
  metadata: GateMetadata,
  scenario: Scenario,
  phase: Phase,
): Promise<void> {
  const sessionId = SessionId(scenario.id)
  const inspected = await ctx.sessionPersistence.inspect(sessionId)
  const inputIdsBefore = new Set(durableScheduleInputs(inspected.events).map(input => input.id))
  const before = folded(inspected.events, inspected.meta.seedLength ?? 0)
  const expectedBefore = phase !== 'old-initial'
    ? metadata.prompts.map(() => metadata.nextAt)
    : scenario.cut === 'pending-only'
      ? metadata.prompts.map(() => metadata.anchorAt)
      : scenario.cut === 'partial-dispatch-no-user'
        ? [metadata.nextAt, metadata.anchorAt]
        : metadata.prompts.map(() => metadata.nextAt)
  assertEveryState(before, metadata, expectedBefore)
  if (phase === 'old-initial'
    && (scenario.cut === 'pending-only' || scenario.cut === 'partial-dispatch-no-user')) {
    assert(Date.now() >= Date.parse(metadata.anchorAt), 'remaining Every records must be due for the old pin')
  }

  const deliveriesBefore = deliveryEvents(inspected.events)
  assert.equal(deliveriesBefore.length, phase === 'old-final' || scenario.cut === 'complete' ? 2 : 1)
  for (const event of deliveriesBefore) {
    assert.equal(event.ignorable, true)
    assert.equal(event.data.version, 2)
  }

  if (phase === 'current-upgrade') {
    if (scenario.cut === 'complete') assert.equal(before.pendingDelivery, undefined)
    else assert.equal(
      before.pendingDelivery?.admitted,
      scenario.cut !== 'dispatch-no-user' && scenario.cut !== 'partial-dispatch-no-user',
    )
  }

  const expectedScheduleRequests = phase === 'old-initial'
    ? scenario.oldInitialScheduleRequests
    : phase === 'current-upgrade'
      ? scenario.currentUpgradeScheduleRequests
      : 0
  const completion = phase === 'current-upgrade' && before.pendingDelivery !== undefined
    ? waitForSessionEvent(ctx, sessionId, event => eventType(event) === 'schedule/delivery'
      && (event as unknown as { data: { operation?: string } }).data.operation === 'delivery-complete')
    : undefined
  const dispatch = phase === 'old-initial' && scenario.cut === 'pending-only'
    ? waitForSessionEvent(ctx, sessionId, event => eventType(event) === 'schedule/change'
      && (event as unknown as { data: { operation?: string } }).data.operation === 'dispatch')
    : undefined

  const requestStart = adapter.requests.length
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  if (dispatch !== undefined) await dispatch
  if (completion !== undefined) await completion
  await handle.agent.whenIdle()
  await settleImmediate()

  const listed = await scheduleList(ctx, handle.agent)
  assert.equal(listed.isError, false)
  assert.deepEqual(listed.value, [{
    id: 'schedule-1',
    kind: 'every',
    prompt: metadata.prompts[0],
    everySeconds: metadata.everySeconds,
    scheduledAt: metadata.nextAt,
    state: 'scheduled',
    deliveryMode: 'session-local',
  }, {
    id: 'schedule-2',
    kind: 'every',
    prompt: metadata.prompts[1],
    everySeconds: metadata.everySeconds,
    scheduledAt: metadata.nextAt,
    state: 'scheduled',
    deliveryMode: 'session-local',
  }])
  const reminderTexts = scheduleRequestTexts(adapter.requests.slice(requestStart))
  assert.equal(reminderTexts.length, expectedScheduleRequests)
  const promptIndexes = expectedPromptIndexes(phase, scenario.cut)
  for (const text of reminderTexts) {
    for (const [index, prompt] of metadata.prompts.entries()) {
      assert.equal(text.includes(JSON.stringify(prompt)), promptIndexes.includes(index))
    }
  }

  const chatText = `compat ordinary ${phase} ${scenario.id}`
  const beforeChat = adapter.requests.length
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: chatText }],
    source: { kind: 'user' },
  }))
  await handle.agent.whenIdle()
  assert.equal(adapter.requests.length, beforeChat + 1)
  assert.equal(scheduleRequests(adapter.requests.slice(beforeChat)), 0)
  assert.equal(await ctx.sessions.flush(handle.agent.session), true)

  const stored = await ctx.sessionPersistence.inspect(sessionId)
  assertEveryState(
    folded(stored.events, stored.meta.seedLength ?? 0),
    metadata,
    metadata.prompts.map(() => metadata.nextAt),
  )
  assert.equal(stored.events.filter(event => event.type === 'schedule/change'
    && event.data.operation === 'dispatch').length, metadata.prompts.length)
  assert.equal(stored.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && event.data.content.some(block => block.type === 'text' && block.text === chatText)).length, 1)
  if (phase === 'current-upgrade' || phase === 'old-final') {
    const finalDeliveries = deliveryEvents(stored.events)
    assert.deepEqual(finalDeliveries.map(event => event.data.operation), [
      'delivery-pending',
      'delivery-complete',
    ])
  }
  if (phase === 'old-final') {
    const texts = durableScheduleInputs(stored.events).map(input => input.text)
    for (const prompt of metadata.prompts) {
      assert.equal(
        texts.filter(text => text.includes(JSON.stringify(prompt))).length,
        1,
        `Schedule occurrence ${JSON.stringify(prompt)} must be delivered exactly once`,
      )
    }
  }
  const phaseInputs = durableScheduleInputs(stored.events)
    .filter(input => !inputIdsBefore.has(input.id))
  assert.equal(phaseInputs.length, expectedScheduleRequests)
  for (const input of phaseInputs) {
    for (const [index, prompt] of metadata.prompts.entries()) {
      assert.equal(input.text.includes(JSON.stringify(prompt)), promptIndexes.includes(index))
    }
  }
  await handle.dispose()
  const label = phase === 'old-initial' && scenario.cut !== 'complete'
    ? 'POLICY-BYPASS containment probe old-initial'
    : phase
  process.stdout.write(
    `${label} ${scenario.cut}: inspect/resume/list/due/chat; Schedule requests=${expectedScheduleRequests}; Every=${metadata.nextAt}`
      + (phase === 'old-final' ? '; occurrences A=1,B=1' : '')
      + `; new inputs=${JSON.stringify(phaseInputs)}\n`,
  )
}

async function runForcedOldCrash(
  ctx: Context,
  adapter: RecordingAdapter,
  metadata: GateMetadata,
): Promise<never> {
  const scenario = metadata.forcedScenario
  const sessionId = SessionId(scenario.id)
  const inspected = await ctx.sessionPersistence.inspect(sessionId)
  const before = folded(inspected.events, inspected.meta.seedLength ?? 0)
  assertEveryRecords(before, metadata, scenario.prompts, [
    metadata.nextAt, metadata.anchorAt, metadata.anchorAt,
  ])
  const reminders = before.active.slice(1).map(record => ({
    record,
    occurrenceAt: metadata.anchorAt,
  })) as unknown as Parameters<typeof toolSchedule.renderEveryReminderBatchFraming>[0]
  const message = createUserMessage({
    content: [{ type: 'text', text: toolSchedule.renderEveryReminderBatchFraming(reminders) }],
    source: { kind: 'plugin', plugin: 'schedule' },
  })
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  await handle.agent.runMaintenance(async () => {
    handle.agent.followup(message)
    handle.agent.session.append('schedule/change', {
      version: 1,
      operation: 'dispatch',
      id: 'schedule-2' as never,
      acceptedAt: new Date().toISOString(),
    })
    assert.equal(await ctx.sessions.flush(handle.agent.session), true)
    assert.equal(scheduleRequests(adapter.requests), 0)
    assert.deepEqual(handle.agent.inbox.nextTurn.map(candidate => candidate.id), [message.id])
    const stored = await ctx.sessionPersistence.inspect(sessionId)
    assertEveryRecords(folded(stored.events, stored.meta.seedLength ?? 0), metadata, scenario.prompts, [
      metadata.nextAt, metadata.nextAt, metadata.anchorAt,
    ])
    process.stdout.write(
      'NEGATIVE setup forced-old-crash: exact old Agent followup B+C and only v1 dispatch B are durable; requests=0\n',
    )
    process.exit(0)
  })
  throw new Error('forced old crash failpoint returned instead of exiting')
}

async function runForcedOldRecovery(
  ctx: Context,
  adapter: RecordingAdapter,
  metadata: GateMetadata,
): Promise<void> {
  const scenario = metadata.forcedScenario
  const sessionId = SessionId(scenario.id)
  const requestStart = adapter.requests.length
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const deadline = Date.now() + 10_000
  for (;;) {
    await handle.agent.whenIdle()
    await settleImmediate()
    const texts = scheduleRequestTexts(adapter.requests.slice(requestStart))
    const state = folded(handle.agent.session.events, handle.agent.session.header.seedLength ?? 0)
    if (texts.length >= 2
      && state.active.every(record => record.scheduledAt === metadata.nextAt)
      && !handle.agent.inbox.hasPending) break
    if (Date.now() >= deadline) throw new Error('timed out waiting for forced old-pin duplicate evidence')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const texts = scheduleRequestTexts(adapter.requests.slice(requestStart))
  assert.equal(texts.length, 2)
  assert.deepEqual(promptCounts(texts, scenario.prompts), [0, 1, 2])
  assert.equal(await ctx.sessions.flush(handle.agent.session), true)
  const stored = await ctx.sessionPersistence.inspect(sessionId)
  assert.deepEqual(promptCounts(
    durableScheduleInputs(stored.events).map(input => input.text),
    scenario.prompts,
  ), [0, 1, 2])
  assertEveryRecords(folded(stored.events, stored.meta.seedLength ?? 0), metadata, scenario.prompts, [
    metadata.nextAt, metadata.nextAt, metadata.nextAt,
  ])
  await handle.dispose()
  process.stdout.write(
    'NEGATIVE evidence forced-old-recover: old provider occurrences A=0,B=1,C=2; old protocol already duplicated C.\n',
  )
}

async function runForcedCurrentUpgrade(
  ctx: Context,
  adapter: RecordingAdapter,
  metadata: GateMetadata,
): Promise<void> {
  const scenario = metadata.forcedScenario
  const sessionId = SessionId(scenario.id)
  const inspected = await ctx.sessionPersistence.inspect(sessionId)
  const before = folded(inspected.events, inspected.meta.seedLength ?? 0)
  assert.equal(before.pendingDelivery?.admitted, false)
  const requestStart = adapter.requests.length
  const completion = waitForSessionEvent(ctx, sessionId, event => eventType(event) === 'schedule/delivery'
    && (event as unknown as { data: { operation?: string } }).data.operation === 'delivery-complete')
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  await completion
  await handle.agent.whenIdle()
  await settleImmediate()
  const texts = scheduleRequestTexts(adapter.requests.slice(requestStart))
  assert.equal(texts.length, 1)
  assert.deepEqual(promptCounts(texts, scenario.prompts), [1, 0, 0])
  assert.equal(await ctx.sessions.flush(handle.agent.session), true)
  const stored = await ctx.sessionPersistence.inspect(sessionId)
  const final = folded(stored.events, stored.meta.seedLength ?? 0)
  assert.equal(final.pendingDelivery, undefined)
  assertEveryRecords(final, metadata, scenario.prompts, [
    metadata.nextAt, metadata.nextAt, metadata.nextAt,
  ])
  assert.deepEqual(promptCounts(
    durableScheduleInputs(stored.events).map(input => input.text),
    scenario.prompts,
  ), [1, 1, 2])
  await handle.dispose()
  process.stdout.write(
    'forced-current-upgrade containment: current requests A=1,B=0,C=0; historical duplicate remains A=1,B=1,C=2; admission=ready.\n',
  )
}

async function runForcedOldFinal(
  ctx: Context,
  adapter: RecordingAdapter,
  metadata: GateMetadata,
): Promise<void> {
  const scenario = metadata.forcedScenario
  const sessionId = SessionId(scenario.id)
  const requestStart = adapter.requests.length
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  await handle.agent.whenIdle()
  await settleImmediate()
  assert.equal(scheduleRequests(adapter.requests.slice(requestStart)), 0)
  assertEveryRecords(
    folded(handle.agent.session.events, handle.agent.session.header.seedLength ?? 0),
    metadata,
    scenario.prompts,
    [metadata.nextAt, metadata.nextAt, metadata.nextAt],
  )
  await handle.dispose()
  process.stdout.write('forced-old-final: admission-ready state loads with no further Schedule request.\n')
}

async function main(): Promise<void> {
  const phase = process.argv[2] as Phase | undefined
  const root = process.argv[3]
  const metadataPath = process.argv[4]
  assert(phase === 'old-initial' || phase === 'current-upgrade' || phase === 'old-final'
    || phase === 'forced-old-crash' || phase === 'forced-old-recover'
    || phase === 'forced-current-upgrade' || phase === 'forced-old-final')
  assert(root !== undefined && metadataPath !== undefined)
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as GateMetadata
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    if (phase === 'forced-old-crash') await runForcedOldCrash(ctx, adapter, metadata)
    await ctx.plugin(toolSchedule)
    if (phase === 'forced-old-recover') await runForcedOldRecovery(ctx, adapter, metadata)
    else if (phase === 'forced-current-upgrade') await runForcedCurrentUpgrade(ctx, adapter, metadata)
    else if (phase === 'forced-old-final') await runForcedOldFinal(ctx, adapter, metadata)
    else {
      for (const scenario of metadata.scenarios) {
        await runScenario(ctx, adapter, metadata, scenario, phase)
      }
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

await main()
