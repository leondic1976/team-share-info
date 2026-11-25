import { describe, it, expect } from 'vitest'
import { byPresence, PRESENCE_ORDER } from '../../src/shared/presence'
import type { Presence } from '../../src/shared/schemas/auth'

describe('presence order', () => {
  it('ranks online, away, absent, offline', () => {
    const states: Presence[] = ['offline', 'absent', 'away', 'online']
    expect([...states].sort((a, b) => PRESENCE_ORDER[a] - PRESENCE_ORDER[b])).toEqual(['online', 'away', 'absent', 'offline'])
  })

  it('lists people here first and keeps the given order within a state', () => {
    const list: { name: string; presence: Presence }[] = [
      { name: '가', presence: 'offline' },
      { name: '나', presence: 'online' },
      { name: '다', presence: 'away' },
      { name: '라', presence: 'offline' },
      { name: '마', presence: 'online' },
      { name: '바', presence: 'absent' }
    ]
    expect([...list].sort(byPresence).map((m) => m.name)).toEqual(['나', '마', '다', '바', '가', '라'])
  })

  it('leaves the input untouched when everyone is in the same state', () => {
    const list = ['가', '나', '다'].map((name) => ({ name, presence: 'offline' as Presence }))
    expect([...list].sort(byPresence).map((m) => m.name)).toEqual(['가', '나', '다'])
  })
})
