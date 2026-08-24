import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  createEveryScheduleRecord,
  createScheduleDeliveryPendingChange,
  foldScheduleEvents,
  renderScheduleDeliveryFraming,
  resolveScheduleDueDecision,
  ScheduleId,
} from '../packages/schedule/schedule/src/domain.ts'

/**
 * Real cross-build Schedule downgrade gate. The all-dispatches/no-user cut is
 * also the durable form of a legacy Inbox message claimed before user/message:
 * Inbox claim has no Session event of its own.
 */
const OLD_COMMIT = '2bc16230975f6cf02aa1b283b1f86de44007b059'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const driver = join(repoRoot, 'packages/schedule/schedule/tests/fixtures/downgrade-gate-driver.ts')

const scenarios = [
  { id: 'downgrade-pending-only', cut: 'pending-only', oldInitialScheduleRequests: 1, currentUpgradeScheduleRequests: 0 },
  { id: 'downgrade-partial-dispatch-no-user', cut: 'partial-dispatch-no-user', oldInitialScheduleRequests: 1, currentUpgradeScheduleRequests: 1 },
  { id: 'downgrade-dispatch-no-user', cut: 'dispatch-no-user', oldInitialScheduleRequests: 0, currentUpgradeScheduleRequests: 1 },
  { id: 'downgrade-dispatch-user', cut: 'dispatch-user', oldInitialScheduleRequests: 0, currentUpgradeScheduleRequests: 0 },
  { id: 'downgrade-user-before-dispatch', cut: 'user-before-dispatch', oldInitialScheduleRequests: 0, currentUpgradeScheduleRequests: 0 },
  { id: 'downgrade-complete', cut: 'complete', oldInitialScheduleRequests: 0, currentUpgradeScheduleRequests: 0 },
] as const

async function run(command: string, args: readonly string[], cwd = repoRoot): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`))
    })
  })
}

async function capture(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', chunk => chunks.push(chunk as Buffer))
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks).toString('utf8').trim())
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`))
    })
  })
}

function appendLegacyPrefix(
  session: Session,
  message: UserMessage,
): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
}

async function seedCandidate(root: string, metadataPath: string): Promise<void> {
  const everySeconds = 3_600
  const now = Date.now()
  const creationNow = now - everySeconds * 1_000 - 5_000
  const metadata = {
    anchorAt: new Date(now - 5_000).toISOString(),
    nextAt: new Date(now - 5_000 + everySeconds * 1_000).toISOString(),
    everySeconds,
    prompts: ['downgrade Every A', 'downgrade Every B'],
    scenarios,
    forcedScenario: {
      id: 'downgrade-forced-old-crash',
      prompts: ['forced downgrade Every A', 'forced downgrade Every B', 'forced downgrade Every C'],
    },
  }
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    for (const scenario of scenarios) {
      const session = ctx.sessions.create(SessionId(scenario.id), { meta: { cwd: '/tmp' } })
      const records = metadata.prompts.map((prompt, index) => createEveryScheduleRecord(
        ScheduleId(`schedule-${index + 1}`), prompt, everySeconds, creationNow,
      ))
      for (const record of records) {
        assert.equal(record.scheduledAt, metadata.anchorAt)
        session.append('schedule/change', { version: 1, operation: 'create', schedule: record })
      }
      const decision = resolveScheduleDueDecision(records, now)
      if (decision.kind !== 'every') throw new Error('expected a due Every decision')
      const pending = createScheduleDeliveryPendingChange(decision, session.seq)
      session.append('schedule/delivery', pending, { ignorable: true })
      const dispatches = foldScheduleEvents(session.events).pendingDelivery?.managementDispatches
      if (dispatches?.length !== records.length) throw new Error('expected every management dispatch')
      const pendingState = foldScheduleEvents(session.events).pendingDelivery
      assert(pendingState !== undefined)
      const legacy = createUserMessage({
        content: [{ type: 'text', text: renderScheduleDeliveryFraming(pendingState) }],
        source: { kind: 'plugin', plugin: 'schedule' },
      })
      const deterministic = freezeMessage({
        id: pendingState.messageId,
        role: 'user' as const,
        content: [{ type: 'text' as const, text: renderScheduleDeliveryFraming(pendingState) }],
        source: { kind: 'plugin' as const, plugin: 'schedule' },
      })

      switch (scenario.cut) {
        case 'pending-only':
          break
        case 'partial-dispatch-no-user': {
          const first = dispatches[0]
          if (first === undefined) throw new Error('expected first Every management dispatch')
          session.append('schedule/change', first)
          break
        }
        case 'dispatch-no-user':
          for (const dispatch of dispatches) session.append('schedule/change', dispatch)
          break
        case 'dispatch-user':
          for (const dispatch of dispatches) session.append('schedule/change', dispatch)
          appendLegacyPrefix(session, legacy)
          break
        case 'user-before-dispatch':
          appendLegacyPrefix(session, legacy)
          for (const dispatch of dispatches) session.append('schedule/change', dispatch)
          break
        case 'complete':
          for (const dispatch of dispatches) session.append('schedule/change', dispatch)
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
      const seededInputs = session.events.flatMap((event) => {
        if (event.type !== 'user/message'
          || event.data.source.kind !== 'plugin'
          || event.data.source.plugin !== 'schedule') return []
        const text = event.data.content.find(block => block.type === 'text')?.text
        return text === undefined ? [] : [{ id: event.data.id, text }]
      })
      process.stdout.write(
        `candidate-seed ${scenario.cut}: admission=${scenario.cut === 'complete' ? 'ready' : 'blocked'}; pending=${pending.messageId}; inputs=${JSON.stringify(seededInputs)}\n`,
      )
    }
    {
      const scenario = metadata.forcedScenario
      const session = ctx.sessions.create(SessionId(scenario.id), { meta: { cwd: '/tmp' } })
      const records = scenario.prompts.map((prompt, index) => createEveryScheduleRecord(
        ScheduleId(`schedule-${index + 1}`), prompt, everySeconds, creationNow,
      ))
      for (const record of records) {
        assert.equal(record.scheduledAt, metadata.anchorAt)
        session.append('schedule/change', { version: 1, operation: 'create', schedule: record })
      }
      const decision = resolveScheduleDueDecision(records, now)
      if (decision.kind !== 'every') throw new Error('expected a due forced Every decision')
      const pending = createScheduleDeliveryPendingChange(decision, session.seq)
      session.append('schedule/delivery', pending, { ignorable: true })
      const dispatches = foldScheduleEvents(session.events).pendingDelivery?.managementDispatches
      if (dispatches?.length !== records.length) throw new Error('expected forced Every management dispatches')
      const first = dispatches[0]
      if (first === undefined) throw new Error('expected first forced Every management dispatch')
      session.append('schedule/change', first)
      assert.equal(await ctx.sessions.flush(session), true)
      const projected = foldScheduleEvents(session.events)
      assert(projected.pendingDelivery !== undefined)
      process.stdout.write(
        `candidate-seed forced-old-crash: admission=blocked; pending=${pending.messageId}; mirror=A only\n`,
      )
    }
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  } finally {
    await ctx.fiber.dispose()
  }
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-schedule-downgrade-'))
  let complete = false
  try {
    const stateRoot = join(scratch, 'state')
    const oldRoot = join(scratch, 'old-source')
    const archive = join(scratch, 'old-source.tar')
    const metadata = join(scratch, 'gate.json')
    await mkdir(oldRoot)

    const [candidateCommit, candidateTree, candidateStatus, oldCommit, oldTree, pnpmVersion] = await Promise.all([
      capture('git', ['rev-parse', 'HEAD']),
      capture('git', ['rev-parse', 'HEAD^{tree}']),
      capture('git', ['status', '--porcelain']),
      capture('git', ['rev-parse', OLD_COMMIT]),
      capture('git', ['rev-parse', `${OLD_COMMIT}^{tree}`]),
      capture('pnpm', ['--version']),
    ])
    process.stdout.write([
      `candidate commit: ${candidateCommit}`,
      `candidate tree: ${candidateTree}`,
      `candidate worktree: ${candidateStatus.length === 0 ? 'clean' : 'dirty (payload includes uncommitted changes)'}`,
      `old commit: ${oldCommit}`,
      `old tree: ${oldTree}`,
      `node: ${process.version}`,
      `pnpm: ${pnpmVersion}`,
      '',
    ].join('\n'))

    await seedCandidate(stateRoot, metadata)
    await run('git', ['archive', '--format=tar', '--output', archive, oldCommit])
    await run('tar', ['-xf', archive, '-C', oldRoot])
    await run('pnpm', [
      'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline', '--dir', oldRoot,
    ])
    const oldDriver = join(oldRoot, 'packages/schedule/schedule/tests/fixtures/downgrade-gate-driver.ts')
    await mkdir(dirname(oldDriver), { recursive: true })
    await copyFile(driver, oldDriver)

    await run('pnpm', ['exec', 'tsx', oldDriver, 'old-initial', stateRoot, metadata], oldRoot)
    await run('pnpm', ['exec', 'tsx', driver, 'current-upgrade', stateRoot, metadata])
    await run('pnpm', ['exec', 'tsx', oldDriver, 'old-final', stateRoot, metadata], oldRoot)
    await run('pnpm', ['exec', 'tsx', oldDriver, 'forced-old-crash', stateRoot, metadata], oldRoot)
    await run('pnpm', ['exec', 'tsx', oldDriver, 'forced-old-recover', stateRoot, metadata], oldRoot)
    await run('pnpm', ['exec', 'tsx', driver, 'forced-current-upgrade', stateRoot, metadata])
    await run('pnpm', ['exec', 'tsx', oldDriver, 'forced-old-final', stateRoot, metadata], oldRoot)
    complete = true
    process.stdout.write(
      'Schedule rollback gate passed: admission-ready old-pin loads stayed exact; policy-bypass pending probes validated containment only; forced old→old crash produced NEGATIVE evidence and remains an expected blocker.\n',
    )
  } finally {
    if (complete) await rm(scratch, { recursive: true, force: true })
    else process.stderr.write(`Schedule downgrade gate failed; preserved evidence at ${scratch}\n`)
  }
}

await main()
