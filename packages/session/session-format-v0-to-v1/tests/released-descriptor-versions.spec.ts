import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import { RELEASED_V0_DESCRIPTOR_VERSIONS } from '../src/validation-helpers.ts'
import { restoreV0ToV1 } from '../src/testing/restore.ts'

/**
 * The descriptor version the shipped 2.0.16/2.0.17 generation stamped into its
 * released v0 artifacts. Every descriptor found in the released v0 store on the
 * reporting machine (104 of 104) carries version 2; version 3 appears only in
 * post-upgrade v3 artifacts. Removing this value from the accepted set makes
 * that recorded user history unreadable again.
 */
const SHIPPED_V0_DESCRIPTOR_VERSION = 2

const header = {
  type: 'session', version: 0, id: 'released-v0-descriptor', createdAt: 1, delegationDepth: 0,
} as const

function descriptor(version: unknown): Record<string, unknown> {
  return {
    type: 'subagent/descriptor',
    seq: 0,
    time: 1,
    data: {
      version, mode: 'continuable', provider: 'spawn', label: 'child', agentProvider: 'p', agentModel: 'm',
    },
  }
}

describe('released v0 subagent descriptor versions', () => {
  it.each([...RELEASED_V0_DESCRIPTOR_VERSIONS])('restores released descriptor version %i', (version) => {
    const restored = restoreV0ToV1(header, [descriptor(version)])
    expect(restored.events[0]).toMatchObject({ type: 'subagent/descriptor', data: { version } })
  })

  it.each([1, 4])('refuses descriptor version %i outside the released enumeration', (version) => {
    expect(() => restoreV0ToV1(header, [descriptor(version)]))
      .toThrow(SessionFormatUnsupportedMigrationError)
  })

  it('keeps covering the descriptor version the shipped 2.0.16/2.0.17 generation wrote', () => {
    expect(RELEASED_V0_DESCRIPTOR_VERSIONS.has(SHIPPED_V0_DESCRIPTOR_VERSION)).toBe(true)
  })

  it('restores the recorded released artifact rows verbatim', () => {
    const source = readFileSync(
      new URL('./fixtures/released-v0-subagent-descriptor-v2.jsonl', import.meta.url),
      'utf8',
    )
    const rows = source.split('\n').filter(line => line.length > 0)
    const restored = restoreV0ToV1(
      JSON.parse(rows[0] as string) as unknown,
      rows.slice(1).map(line => JSON.parse(line) as unknown),
    )
    expect(restored.events).toHaveLength(1)
    expect(restored.events[0]).toMatchObject({
      type: 'subagent/descriptor',
      data: { version: 2, mode: 'continuable', provider: 'spawn' },
    })
  })
})
