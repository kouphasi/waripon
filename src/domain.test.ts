import { describe, expect, it } from 'vitest'
import {
  addParticipant,
  createEmptyState,
  removeParticipant,
  renameParticipant,
  saveExpense,
  validateCalculationState,
  type CalculationStateV1,
} from './domain'

const validState: CalculationStateV1 = {
  version: 1,
  currency: 'JPY',
  participants: [
    { id: 'p1', name: 'あおい' },
    { id: 'p2', name: 'はる' },
  ],
  expenses: [
    {
      id: 'e1',
      description: '夕食',
      amount: 3000,
      payerId: 'p1',
      burdenParticipantIds: ['p1', 'p2'],
    },
  ],
  roundingAssigneeId: 'p1',
}

describe('validateCalculationState', () => {
  it('有効な状態を正規化する', () => {
    const result = validateCalculationState({
      ...validState,
      participants: [
        { id: ' p1 ', name: ' あおい ' },
        { id: 'p2', name: 'はる' },
      ],
      expenses: [{ ...validState.expenses[0], description: ' 夕食 ' }],
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.participants[0]).toEqual({ id: 'p1', name: 'あおい' })
      expect(result.data.expenses[0]?.description).toBe('夕食')
    }
  })

  it.each([
    ['参加者名', { participants: [...validState.participants, { id: 'p3', name: 'あおい' }] }],
    ['参加者ID', { participants: [...validState.participants, { id: 'p1', name: 'なつ' }] }],
    ['支払いID', { expenses: [...validState.expenses, { ...validState.expenses[0] }] }],
  ])('%sの重複を拒否する', (_, patch) => {
    const result = validateCalculationState({ ...validState, ...patch })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.issues.some(({ message }) => message.includes('重複'))).toBe(true)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    '無効な金額 %s を拒否する',
    (amount) => {
      const result = validateCalculationState({
        ...validState,
        expenses: [{ ...validState.expenses[0], amount }],
      })
      expect(result.success).toBe(false)
    },
  )

  it('壊れた相互参照、空の負担者一覧、無効な担当者をすべて報告する', () => {
    const result = validateCalculationState({
      ...validState,
      expenses: [
        {
          ...validState.expenses[0],
          payerId: 'missing',
          burdenParticipantIds: [],
        },
      ],
      roundingAssigneeId: 'missing',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.issues.map(({ path }) => path)).toEqual(
        expect.arrayContaining([
          'expenses[0].payerId',
          'expenses[0].burdenParticipantIds',
          'roundingAssigneeId',
        ]),
      )
    }
  })
})

describe('state mutations', () => {
  it('最初の参加者を担当者にし、改名してもIDを維持する', () => {
    const added = addParticipant(createEmptyState(), ' あおい ', () => 'stable-id')
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.state.roundingAssigneeId).toBe('stable-id')

    const renamed = renameParticipant(added.state, 'stable-id', 'あお')
    expect(renamed.ok).toBe(true)
    if (renamed.ok) expect(renamed.state.participants[0]).toEqual({ id: 'stable-id', name: 'あお' })
  })

  it('参照中の参加者削除を拒否し、担当者削除時は先頭へフォールバックする', () => {
    expect(removeParticipant(validState, 'p1').ok).toBe(false)
    const withoutExpense = { ...validState, expenses: [] }
    const removed = removeParticipant(withoutExpense, 'p1')
    expect(removed.ok).toBe(true)
    if (removed.ok) expect(removed.state.roundingAssigneeId).toBe('p2')
  })

  it('新規支払いを検証して安定したIDで保存する', () => {
    const saved = saveExpense(
      { ...validState, expenses: [] },
      {
        description: ' 宿泊 ',
        amount: 9000,
        payerId: 'p2',
        burdenParticipantIds: ['p1', 'p2'],
      },
      undefined,
      () => 'expense-stable',
    )
    expect(saved.ok).toBe(true)
    if (saved.ok) {
      expect(saved.state.expenses[0]).toMatchObject({ id: 'expense-stable', description: '宿泊' })
    }
  })
})
