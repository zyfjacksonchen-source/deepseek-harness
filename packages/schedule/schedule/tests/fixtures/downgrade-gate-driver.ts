import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { setImmediate as settleImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createUserMessage, freezeMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as toolSchedule from '@deepseek-ai/dsh-schedule'

type Phase = 'candidate-seed' | 'old-initial' | 'current-upgrade' | 'old-final'
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
  readonly policyBypassScenario: {
    readonly id: string
    readonly prompts: readonly string[]
    readonly originalAt: string
    readonly bypassAt: string
    readonly finalAt: string
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
    readonly deliveryId: string
    readonly messageId: string
    readonly admitted: boolean
    readonly admittedOccurrenceIds?: readonly string[]
    readonly managementDispatches: readonly unknown[]
  }
}

const scenarios = [
  { id: 'downgrade-pending-only', cut: 'pending-only', oldInitialScheduleRequests: 1, currentUpgradeScheduleRequests: 0 },
  { id: 'downgrade-partial-dispatch-no-user', cut: 'partial-dispatch-no-user', oldInitialScheduleRequests: 1, currentUpgradeScheduleRequests: 1 },
  { id: 'downgrade-dispatch-no-user', cut: 'dispatch-no-user', oldInitialScheduleRequests: 0, currentUpgradeScheduleRequests: 1 },
  { id: 'downgrade-dispatch-user', cut: 'dispatch-user', oldInitialScheduleRequests: 0, currentUpgradeScheduleRequests: 0 },
  { id: 'downgrade-user-before-dispatch', cut: 'user-before-dispatch', oldInitialScheduleRequests: 0, currentUpgradeScheduleRequests: 0 },
  { id: 'downgrade-complete', cut: 'complete', oldInitialScheduleRequests: 0, currentUpgradeScheduleRequests: 0 },
] as const satisfies readonly Scenario[]

function appendLegacyPrefix(session: Session, message: ReturnType<typeof createUserMessage>): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
}

async function seedCandidate(root: string, metadataPath: string): Promise<void> {
  const everySeconds = 3_600
  const now = Date.now()
  const creationNow = now - everySeconds * 1_000 - 5_000
  const metadata: GateMetadata = {
    anchorAt: new Date(now - 5_000).toISOString(),
    nextAt: new Date(now - 5_000 + everySeconds * 1_000).toISOString(),
    everySeconds,
    prompts: ['downgrade Every A', 'downgrade Every B'],
    scenarios,
    forcedScenario: {
      id: 'downgrade-forced-old-crash',
      prompts: ['forced downgrade Every A', 'forced downgrade Every B', 'forced downgrade Every C'],
    },
    policyBypassScenario: {
      id: 'downgrade-policy-bypass-next-occurrence',
      prompts: ['policy bypass Every A', 'policy bypass Every B'],
      originalAt: new Date(now - everySeconds * 2_000 - 5_000).toISOString(),
      bypassAt: new Date(now - 5_000).toISOString(),
      finalAt: new Date(now + everySeconds * 1_000 - 5_000).toISOString(),
    },
  }
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    for (const scenario of scenarios) {
      const session = ctx.sessions.create(SessionId(scenario.id), { meta: { cwd: '/tmp' } })
      const records = metadata.prompts.map((prompt, index) => toolSchedule.createEveryScheduleRecord(
        toolSchedule.ScheduleId(`schedule-${index + 1}`), prompt, everySeconds, creationNow,
      ))
      for (const record of records) {
        assert.equal(record.scheduledAt, metadata.anchorAt)
        session.append('schedule/change', { version: 1, operation: 'create', schedule: record })
      }
      const decision = toolSchedule.resolveScheduleDueDecision(records, now)
      if (decision.kind !== 'every') throw new Error('expected a due Every decision')
      const pending = toolSchedule.createScheduleDeliveryPendingChange(decision, session.seq)
      session.append('schedule/delivery', pending, { ignorable: true })
      const dispatches = folded(session.events).pendingDelivery?.managementDispatches
      if (dispatches?.length !== records.length) throw new Error('expected every management dispatch')
      const pendingState = folded(session.events).pendingDelivery
      assert(pendingState !== undefined)
      const legacy = createUserMessage({
        content: [{ type: 'text', text: toolSchedule.renderScheduleDeliveryFraming(pendingState as never) }],
        source: { kind: 'plugin', plugin: 'schedule' },
      })
      const deterministic = freezeMessage({
        id: pendingState.messageId as never,
        role: 'user' as const,
        content: [{
          type: 'text' as const,
          text: toolSchedule.renderScheduleDeliveryFraming(pendingState as never),
        }],
        source: { kind: 'plugin' as const, plugin: 'schedule' },
      })

      switch (scenario.cut) {
        case 'pending-only':
          break
        case 'partial-dispatch-no-user': {
          const first = dispatches[0]
          if (first === undefined) throw new Error('expected first Every management dispatch')
          session.append('schedule/change', first as never)
          break
        }
        case 'dispatch-no-user':
          for (const dispatch of dispatches) session.append('schedule/change', dispatch as never)
          break
        case 'dispatch-user':
          for (const dispatch of dispatches) session.append('schedule/change', dispatch as never)
          appendLegacyPrefix(session, legacy)
          break
        case 'user-before-dispatch':
          appendLegacyPrefix(session, legacy)
          for (const dispatch of dispatches) session.append('schedule/change', dispatch as never)
          break
        case 'complete':
          for (const dispatch of dispatches) session.append('schedule/change', dispatch as never)
          appendLegacyPrefix(session, deterministic)
          session.append('schedule/delivery', {
            version: 2,
            operation: 'delivery-complete',
            deliveryId: pending.deliveryId,
            messageId: pending.messageId,
          }, { ignorable: true })
          break
      }
      assert.equal(await ctx.sessions.flush(session), true)
      const seededInputs = durableScheduleInputs(session.events)
      process.stdout.write(
        `candidate-seed ${scenario.cut}: admission=${scenario.cut === 'complete' ? 'ready' : 'blocked'}; pending=${pending.messageId}; inputs=${JSON.stringify(seededInputs)}\n`,
      )
    }
    {
      const scenario = metadata.forcedScenario
      const session = ctx.sessions.create(SessionId(scenario.id), { meta: { cwd: '/tmp' } })
      const records = scenario.prompts.map((prompt, index) => toolSchedule.createEveryScheduleRecord(
        toolSchedule.ScheduleId(`schedule-${index + 1}`), prompt, everySeconds, creationNow,
      ))
      for (const record of records) {
        assert.equal(record.scheduledAt, metadata.anchorAt)
        session.append('schedule/change', { version: 1, operation: 'create', schedule: record })
      }
      const decision = toolSchedule.resolveScheduleDueDecision(records, now)
      if (decision.kind !== 'every') throw new Error('expected a due forced Every decision')
      const pending = toolSchedule.createScheduleDeliveryPendingChange(decision, session.seq)
      session.append('schedule/delivery', pending, { ignorable: true })
      const dispatches = folded(session.events).pendingDelivery?.managementDispatches
      if (dispatches?.length !== records.length) throw new Error('expected forced Every management dispatches')
      const first = dispatches[0]
      if (first === undefined) throw new Error('expected first forced Every management dispatch')
      session.append('schedule/change', first as never)
      assert.equal(await ctx.sessions.flush(session), true)
      assert(folded(session.events).pendingDelivery !== undefined)
      process.stdout.write(
        `candidate-seed forced-old-crash: admission=blocked; pending=${pending.messageId}; mirror=A only\n`,
      )
    }
    {
      const scenario = metadata.policyBypassScenario
      const originalAt = Date.parse(scenario.originalAt)
      const session = ctx.sessions.create(SessionId(scenario.id), { meta: { cwd: '/tmp' } })
      const records = scenario.prompts.map((prompt, index) => toolSchedule.createEveryScheduleRecord(
        toolSchedule.ScheduleId(`schedule-${index + 1}`),
        prompt,
        everySeconds,
        originalAt - everySeconds * 1_000,
      ))
      for (const record of records) {
        assert.equal(record.scheduledAt, scenario.originalAt)
        session.append('schedule/change', { version: 1, operation: 'create', schedule: record })
      }
      const decision = toolSchedule.resolveScheduleDueDecision(records, originalAt)
      if (decision.kind !== 'every') throw new Error('expected policy-bypass Every decision')
      const pending = toolSchedule.createScheduleDeliveryPendingChange(decision, session.seq)
      session.append('schedule/delivery', pending, { ignorable: true })
      const dispatches = folded(session.events).pendingDelivery?.managementDispatches
      if (dispatches?.length !== records.length) throw new Error('expected policy-bypass dispatch mirrors')
      for (const dispatch of dispatches) session.append('schedule/change', dispatch as never)
      assert.equal(await ctx.sessions.flush(session), true)
      assertEveryRecords(
        folded(session.events),
        metadata,
        scenario.prompts,
        scenario.prompts.map(() => new Date(originalAt + everySeconds * 1_000).toISOString()),
      )
      process.stdout.write(
        `candidate-seed policy-bypass: admission=blocked; pending=${pending.messageId}; mirrors=complete\n`,
      )
    }
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  } finally {
    await ctx.fiber.dispose()
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
  return toolSchedule.foldScheduleEvents(events, seedLength) as unknown as CompatFold
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

async function runPolicyBypassOld(
  ctx: Context,
  adapter: RecordingAdapter,
  metadata: GateMetadata,
): Promise<void> {
  const scenario = metadata.policyBypassScenario
  const sessionId = SessionId(scenario.id)
  const before = await ctx.sessionPersistence.inspect(sessionId)
  assertEveryRecords(
    folded(before.events, before.meta.seedLength ?? 0),
    metadata,
    scenario.prompts,
    scenario.prompts.map(() => new Date(
      Date.parse(scenario.originalAt) + metadata.everySeconds * 1_000,
    ).toISOString()),
  )
  const dispatch = waitForSessionEvent(ctx, sessionId, event => eventType(event) === 'schedule/change'
    && (event as unknown as { data: { operation?: string } }).data.operation === 'dispatch')
  const requestStart = adapter.requests.length
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  await dispatch
  await handle.agent.whenIdle()
  await settleImmediate()
  const texts = scheduleRequestTexts(adapter.requests.slice(requestStart))
  assert.equal(texts.length, 1)
  assert.deepEqual(promptCounts(texts, scenario.prompts), [1, 1])
  assert(texts[0]?.includes(scenario.bypassAt))
  assert.equal(await ctx.sessions.flush(handle.agent.session), true)
  const stored = await ctx.sessionPersistence.inspect(sessionId)
  assertEveryRecords(
    folded(stored.events, stored.meta.seedLength ?? 0),
    metadata,
    scenario.prompts,
    scenario.prompts.map(() => scenario.finalAt),
  )
  assert.equal(durableScheduleInputs(stored.events).length, 1)
  await handle.dispose()
  process.stdout.write(
    'POLICY-BYPASS next-occurrence old interval: later user/message precedes its v1 dispatches; occurrences A=1,B=1.\n',
  )
}

async function runPolicyBypassCurrent(
  ctx: Context,
  adapter: RecordingAdapter,
  metadata: GateMetadata,
): Promise<void> {
  const scenario = metadata.policyBypassScenario
  const sessionId = SessionId(scenario.id)
  const before = await ctx.sessionPersistence.inspect(sessionId)
  const projected = folded(before.events, before.meta.seedLength ?? 0)
  assert.equal(projected.pendingDelivery?.admitted, false)
  assertEveryRecords(
    projected,
    metadata,
    scenario.prompts,
    scenario.prompts.map(() => scenario.finalAt),
  )
  const completion = waitForSessionEvent(ctx, sessionId, event => eventType(event) === 'schedule/delivery'
    && (event as unknown as { data: { operation?: string } }).data.operation === 'delivery-complete')
  const requestStart = adapter.requests.length
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  await completion
  await handle.agent.whenIdle()
  await settleImmediate()
  const texts = scheduleRequestTexts(adapter.requests.slice(requestStart))
  assert.equal(texts.length, 1)
  assert.deepEqual(promptCounts(texts, scenario.prompts), [1, 1])
  assert(texts[0]?.includes(scenario.originalAt))
  assert.equal(await ctx.sessions.flush(handle.agent.session), true)
  const stored = await ctx.sessionPersistence.inspect(sessionId)
  assert.equal(folded(stored.events, stored.meta.seedLength ?? 0).pendingDelivery, undefined)
  assertEveryRecords(
    folded(stored.events, stored.meta.seedLength ?? 0),
    metadata,
    scenario.prompts,
    scenario.prompts.map(() => scenario.finalAt),
  )
  const inputs = durableScheduleInputs(stored.events)
  assert.equal(inputs.length, 2)
  assert.deepEqual(promptCounts(inputs.map(input => input.text), scenario.prompts), [2, 2])
  assert.deepEqual(inputs.map(input => [
    input.text.includes(scenario.originalAt),
    input.text.includes(scenario.bypassAt),
  ]), [[false, true], [true, false]])
  await handle.dispose()
  process.stdout.write(
    'policy-bypass current containment: original and later occurrence each have one durable carrier; no fold fault or replay duplicate.\n',
  )
}

async function runPolicyBypassOldFinal(
  ctx: Context,
  adapter: RecordingAdapter,
  metadata: GateMetadata,
): Promise<void> {
  const scenario = metadata.policyBypassScenario
  const requestStart = adapter.requests.length
  const handle = await ctx.agents.resume({
    resumeSessionId: SessionId(scenario.id),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  await handle.agent.whenIdle()
  await settleImmediate()
  assert.equal(scheduleRequests(adapter.requests.slice(requestStart)), 0)
  assertEveryRecords(
    folded(handle.agent.session.events, handle.agent.session.header.seedLength ?? 0),
    metadata,
    scenario.prompts,
    scenario.prompts.map(() => scenario.finalAt),
  )
  await handle.dispose()
  process.stdout.write('policy-bypass old-final: admission-ready state loads with no further Schedule request.\n')
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
  assert(phase === 'candidate-seed' || phase === 'old-initial' || phase === 'current-upgrade' || phase === 'old-final'
    || phase === 'forced-old-crash' || phase === 'forced-old-recover'
    || phase === 'forced-current-upgrade' || phase === 'forced-old-final')
  assert(root !== undefined && metadataPath !== undefined)
  const scheduleEntry = import.meta.resolve('@deepseek-ai/dsh-schedule')
  assert.match(scheduleEntry, /\/lib\/index\.js$/, 'Schedule driver must resolve the public built package entry')
  process.stdout.write(`${phase} Schedule entry: ${scheduleEntry}\n`)
  if (phase === 'candidate-seed') {
    await seedCandidate(root, metadataPath)
    return
  }
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
      if (phase === 'old-initial') await runPolicyBypassOld(ctx, adapter, metadata)
      else if (phase === 'current-upgrade') await runPolicyBypassCurrent(ctx, adapter, metadata)
      else await runPolicyBypassOldFinal(ctx, adapter, metadata)
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

await main()
