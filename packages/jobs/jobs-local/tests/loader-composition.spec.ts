import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    emateImage: 'emate-image'
  }
}

function stubAgent(ctx: Context, rawId: string): Agent {
  const id = SessionId(rawId)
  const session = Session.create(id)
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('jobs-local through a real Loader composition', () => {
  it('applies the provider-owned admission config from a Cordis row', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jobs-local-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-jobs-local'",
      '  config:',
      '    maxConcurrentJobsPerOwner: 1',
      '',
    ].join('\n'))

    context = new Context()
    await context.plugin(AgentRegistry)
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-jobs-local') return LocalJobRegistry
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.jobs).toBeInstanceOf(LocalJobRegistry)
    context.jobs.attachController('loader-test')
    let settle!: (outcome: { status: 'killed' }) => void
    context.jobs.start({
      kind: 'bash',
      label: 'hold loader slot',
      run: () => ({
        cancel: () => { settle({ status: 'killed' }) },
        done: new Promise((resolve) => { settle = resolve }),
      }),
    })
    expect(() => context!.jobs.start({
      kind: 'bash',
      label: 'blocked loader job',
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
    })).toThrow('(limit: 1)')

    const ownerA = stubAgent(context, 'loader-image-parent-a')
    const ownerB = stubAgent(context, 'loader-image-parent-b')
    context.agents.register(ownerA)
    context.agents.register(ownerB)
    const starts: string[] = []
    let settleA!: (outcome: { status: 'completed' }) => void
    let settleB!: (outcome: { status: 'completed' }) => void
    await context.jobs.startWhenAvailable({
      kind: 'emate-image',
      label: 'loader image a',
      owner: ownerA,
      run: () => {
        starts.push('a')
        return { cancel: () => {}, done: new Promise((resolve) => { settleA = resolve }) }
      },
    })
    const second = context.jobs.startWhenAvailable({
      kind: 'emate-image',
      label: 'loader image b',
      owner: ownerB,
      run: () => {
        starts.push('b')
        return { cancel: () => {}, done: new Promise((resolve) => { settleB = resolve }) }
      },
    })
    await Promise.resolve()
    expect(starts).toEqual(['a'])
    settleA({ status: 'completed' })
    await expect(second).resolves.toBe('emate-image-2')
    expect(starts).toEqual(['a', 'b'])
    settleB({ status: 'completed' })
    await Promise.resolve()
  })
})
