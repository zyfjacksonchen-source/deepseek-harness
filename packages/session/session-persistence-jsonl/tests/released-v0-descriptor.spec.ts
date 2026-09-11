import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath, logPath } from '../src/format.ts'

/**
 * The recorded released artifact is the first two rows of a real
 * 2.0.16/2.0.17 subagent Session: its version-0 header and the
 * `subagent/descriptor` row carrying payload version 2. Version 3 appears only
 * in post-upgrade v3 artifacts, so a released-v0 reader must admit version 2 or
 * this recorded user history becomes unreadable.
 */
const RECORDED_ARTIFACT = 'packages/session/session-format-v0-to-v1/tests/fixtures/released-v0-subagent-descriptor-v2.jsonl'

let root: string
let ctx: Context & { sessionPersistence: SessionPersistence }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'released-v0-descriptor-'))
  ctx = new Context() as Context & { sessionPersistence: SessionPersistence }
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/** Read every event through a fresh handle. */
async function readAll(id: ReturnType<typeof SessionId>) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return await handle.read()
  } finally {
    await handle.close()
  }
}

describe('recorded released v0 subagent descriptor', () => {
  it.each(['read', 'write'] as const)('loads on %s open and preserves the released generation', async (access) => {
    const source = await readFile(resolve(RECORDED_ARTIFACT))
    const header = JSON.parse(source.toString('utf8').split('\n')[0] as string) as { id: string; cwd: string }
    const id = SessionId(header.id)
    const sourcePath = generationLogPath(root, header.cwd, id, 0, 'none')
    const currentPath = logPath(root, header.cwd, id, 'none')
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, source)
    const before = await stat(sourcePath, { bigint: true })

    const handle = await ctx.sessionPersistence.open(id, access)
    let events
    try {
      events = (await handle.read()).events
    } finally {
      await handle.close()
    }
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'subagent/descriptor',
      data: { version: 2, mode: 'continuable', provider: 'spawn' },
    })

    await ctx.sessionPersistence.flush()
    // A released generation is never moved, overwritten, or deleted.
    const after = await stat(sourcePath, { bigint: true })
    expect({ dev: after.dev, ino: after.ino, size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs })
      .toEqual({ dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs })
    expect(await readFile(sourcePath)).toEqual(source)

    if (access === 'read') {
      // Observation alone publishes no successor.
      await expect(readFile(currentPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(dirname(sourcePath))).filter(name => name !== 'session.lock'))
        .toEqual(['session.jsonl'])
      return
    }

    // A write open publishes a successor that the current reader accepts.
    expect((await readdir(dirname(sourcePath))).includes('session.v3.jsonl')).toBe(true)
    expect((await readAll(id)).events).toMatchObject([{
      type: 'subagent/descriptor',
      data: { version: 2, mode: 'continuable', provider: 'spawn' },
    }])
  })
})
