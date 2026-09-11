/**
 * The envelope's `ignorable` marker on the append path.
 *
 * A downstream (out-of-repo) plugin event type is outside
 * {@link KNOWN_SESSION_EVENT_TYPES} by construction, and the persistence read
 * path refuses a log containing an unknown type unless the event carries the
 * envelope marker (see packages/core/session/src/known-event-types.ts). This
 * suite pins the append-side contract that writes it: a non-surface event may
 * declare `ignorable: true`, the marker reaches the logged envelope, an invalid
 * marker is refused, and a surface event can never be ignorable because
 * omitting one would reconstruct a wrong conversation.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'

const header = { version: SESSION_FORMAT_VERSION, id: SessionId('ignorable-envelope'), createdAt: 1, isSeeded: false } as const

describe('ignorable envelope on append', () => {
  it('writes the marker for a non-surface event that declares it', () => {
    const session = Session.create(header.id)
    const event = session.append('turn/start', { turn: 1 }, { ignorable: true })
    expect(event.ignorable).toBe(true)
    expect(Object.keys(event).sort()).toEqual(['data', 'ignorable', 'seq', 'time', 'type'])
  })

  it('leaves an ordinary non-surface event without the marker', () => {
    const session = Session.create(header.id)
    const event = session.append('turn/start', { turn: 1 })
    expect(event.ignorable).toBeUndefined()
    expect(Object.hasOwn(event, 'ignorable')).toBe(false)
  })

  it('refuses an invalid marker and a surface event that claims one', () => {
    const session = Session.create(header.id)
    expect(() => session.append('turn/start', { turn: 1 }, { ignorable: false } as never))
      .toThrow('carries an invalid ignorable marker')
    expect(() => session.append('user/message', { role: 'user', content: [] } as never, { ignorable: true } as never))
      .toThrow('cannot be ignorable')
    expect(session.snapshotEvents()).toHaveLength(0)
  })
})
