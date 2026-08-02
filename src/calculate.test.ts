import { describe, expect, it } from 'vitest'
import { calculateSettlement } from './calculate'
import type { CalculationStateV1, Expense } from './domain'
import { addRational, equalRational, floorRational, rational } from './rational'

const participants = [
  { id: 'p1', name: 'あおい' },
  { id: 'p2', name: 'はる' },
  { id: 'p3', name: 'なつ' },
]

function state(expenses: Expense[], roundingAssigneeId = 'p1'): CalculationStateV1 {
  return { version: 1, currency: 'JPY', participants, expenses, roundingAssigneeId }
}

describe('rational', () => {
  it('約分して正確に加算・切り捨てする', () => {
    expect(rational(6n, 9n)).toEqual({ numerator: 2n, denominator: 3n })
    expect(equalRational(addRational(rational(1n, 3n), rational(1n, 6n)), rational(1n, 2n))).toBe(
      true,
    )
    expect(floorRational(rational(5n, 2n))).toBe(2n)
    expect(floorRational(rational(-1n, 2n))).toBe(-1n)
  })
})

describe('calculateSettlement', () => {
  it('1,000円を3人に333円、333円、担当者334円で割り当てる', () => {
    const result = calculateSettlement(
      state([
        {
          id: 'e1',
          description: '昼食',
          amount: 1000,
          payerId: 'p1',
          burdenParticipantIds: ['p1', 'p2', 'p3'],
        },
      ]),
    )
    expect(result.participants.map(({ assignedBurden }) => assignedBurden)).toEqual([334n, 333n, 333n])
    expect(result.participants[0]?.roundingAdjustment).toBe(1n)
    expect(result.participants.reduce((sum, item) => sum + item.assignedBurden, 0n)).toBe(1000n)
  })

  it('支払いごとに丸めず、正確な負担を全体で集計する', () => {
    const result = calculateSettlement(
      state([
        {
          id: 'e1',
          description: '1回目',
          amount: 1,
          payerId: 'p1',
          burdenParticipantIds: ['p1', 'p2'],
        },
        {
          id: 'e2',
          description: '2回目',
          amount: 1,
          payerId: 'p2',
          burdenParticipantIds: ['p1', 'p2'],
        },
      ]),
    )
    expect(result.participants.slice(0, 2).map(({ assignedBurden }) => assignedBurden)).toEqual([1n, 1n])
  })

  it('参加者順で決定的な送金を作り、全差額を精算する', () => {
    const input = state([
      {
        id: 'e1',
        description: '宿泊',
        amount: 9000,
        payerId: 'p1',
        burdenParticipantIds: ['p1', 'p2', 'p3'],
      },
      {
        id: 'e2',
        description: '交通',
        amount: 1500,
        payerId: 'p2',
        burdenParticipantIds: ['p1', 'p2', 'p3'],
      },
    ])
    const first = calculateSettlement(input)
    const second = calculateSettlement(input)
    expect(first.transfers).toEqual(second.transfers)
    expect(first.participants.reduce((sum, item) => sum + item.balance, 0n)).toBe(0n)

    const settled = new Map(first.participants.map(({ participantId, balance }) => [participantId, balance]))
    first.transfers.forEach(({ fromParticipantId, toParticipantId, amount }) => {
      settled.set(fromParticipantId, (settled.get(fromParticipantId) ?? 0n) + amount)
      settled.set(toParticipantId, (settled.get(toParticipantId) ?? 0n) - amount)
    })
    expect([...settled.values()]).toEqual([0n, 0n, 0n])
    expect(first.transfers.every(({ amount }) => amount > 0n)).toBe(true)
  })

  it('安全な整数上限の支払いを精度を落とさず集計する', () => {
    const maximum = Number.MAX_SAFE_INTEGER
    const result = calculateSettlement(
      state([
        {
          id: 'e1',
          description: '境界1',
          amount: maximum,
          payerId: 'p1',
          burdenParticipantIds: ['p1'],
        },
        {
          id: 'e2',
          description: '境界2',
          amount: maximum,
          payerId: 'p1',
          burdenParticipantIds: ['p1'],
        },
      ]),
    )
    expect(result.totalPaid).toBe(BigInt(maximum) * 2n)
    expect(result.participants.reduce((sum, item) => sum + item.balance, 0n)).toBe(0n)
  })

  it('多数の具体例で合計維持と完全精算の不変条件を満たす', () => {
    let seed = 42
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32
      return seed / 2 ** 32
    }

    for (let example = 0; example < 80; example += 1) {
      const expenses = Array.from({ length: 1 + Math.floor(random() * 15) }, (_, index): Expense => {
        const burdenParticipantIds = participants
          .filter(() => random() > 0.35)
          .map(({ id }) => id)
        if (burdenParticipantIds.length === 0) burdenParticipantIds.push('p1')
        return {
          id: `e${index}`,
          description: `支払い${index}`,
          amount: 1 + Math.floor(random() * 100_000),
          payerId: participants[Math.floor(random() * participants.length)]?.id ?? 'p1',
          burdenParticipantIds,
        }
      })
      const result = calculateSettlement(state(expenses, participants[example % 3]?.id))
      expect(result.participants.reduce((sum, item) => sum + item.assignedBurden, 0n)).toBe(
        result.totalPaid,
      )
      expect(result.participants.reduce((sum, item) => sum + item.balance, 0n)).toBe(0n)
      expect(result.transfers.reduce((sum, item) => sum + item.amount, 0n)).toBe(
        result.participants
          .filter(({ balance }) => balance < 0n)
          .reduce((sum, item) => sum - item.balance, 0n),
      )
    }
  })
})
