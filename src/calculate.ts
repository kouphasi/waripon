import type { CalculationStateV1 } from './domain'
import { addRational, floorRational, rational, type Rational } from './rational'

export interface ParticipantBalance {
  participantId: string
  paid: bigint
  exactBurden: Rational
  assignedBurden: bigint
  balance: bigint
  roundingAdjustment: bigint
}

export interface Transfer {
  fromParticipantId: string
  toParticipantId: string
  amount: bigint
}

export interface CalculationResult {
  totalPaid: bigint
  participants: ParticipantBalance[]
  transfers: Transfer[]
}

export function calculateSettlement(state: CalculationStateV1): CalculationResult {
  const paid = new Map(state.participants.map(({ id }) => [id, 0n]))
  const exactBurden = new Map(
    state.participants.map(({ id }) => [id, rational(0n)]),
  )
  let totalPaid = 0n

  state.expenses.forEach((expense) => {
    const amount = BigInt(expense.amount)
    totalPaid += amount
    paid.set(expense.payerId, (paid.get(expense.payerId) ?? 0n) + amount)
    const share = rational(amount, BigInt(expense.burdenParticipantIds.length))
    expense.burdenParticipantIds.forEach((participantId) => {
      exactBurden.set(
        participantId,
        addRational(exactBurden.get(participantId) ?? rational(0n), share),
      )
    })
  })

  const assignedBurden = new Map<string, bigint>()
  let nonAssigneeTotal = 0n
  state.participants.forEach(({ id }) => {
    if (id === state.roundingAssigneeId) return
    const assigned = floorRational(exactBurden.get(id) ?? rational(0n))
    assignedBurden.set(id, assigned)
    nonAssigneeTotal += assigned
  })
  if (state.roundingAssigneeId) {
    assignedBurden.set(state.roundingAssigneeId, totalPaid - nonAssigneeTotal)
  }

  const participants = state.participants.map(({ id }): ParticipantBalance => {
    const exact = exactBurden.get(id) ?? rational(0n)
    const assigned = assignedBurden.get(id) ?? 0n
    const participantPaid = paid.get(id) ?? 0n
    return {
      participantId: id,
      paid: participantPaid,
      exactBurden: exact,
      assignedBurden: assigned,
      balance: participantPaid - assigned,
      roundingAdjustment:
        id === state.roundingAssigneeId ? assigned - floorRational(exact) : 0n,
    }
  })

  return {
    totalPaid,
    participants,
    transfers: createTransfers(participants),
  }
}

export function createTransfers(participants: ParticipantBalance[]): Transfer[] {
  const debtors = participants
    .filter(({ balance }) => balance < 0n)
    .map(({ participantId, balance }) => ({ participantId, remaining: -balance }))
  const creditors = participants
    .filter(({ balance }) => balance > 0n)
    .map(({ participantId, balance }) => ({ participantId, remaining: balance }))
  const transfers: Transfer[] = []
  let debtorIndex = 0
  let creditorIndex = 0

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex]
    const creditor = creditors[creditorIndex]
    if (!debtor || !creditor) break
    const amount = debtor.remaining < creditor.remaining ? debtor.remaining : creditor.remaining
    if (amount > 0n) {
      transfers.push({
        fromParticipantId: debtor.participantId,
        toParticipantId: creditor.participantId,
        amount,
      })
    }
    debtor.remaining -= amount
    creditor.remaining -= amount
    if (debtor.remaining === 0n) debtorIndex += 1
    if (creditor.remaining === 0n) creditorIndex += 1
  }

  return transfers
}

export function formatYen(amount: bigint): string {
  return `${new Intl.NumberFormat('ja-JP').format(amount)}円`
}

export function formatSignedYen(amount: bigint): string {
  if (amount === 0n) return formatYen(0n)
  return `${amount > 0n ? '+' : '−'}${formatYen(amount > 0n ? amount : -amount)}`
}
