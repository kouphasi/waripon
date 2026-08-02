export const STATE_VERSION = 1 as const
export const STATE_CURRENCY = 'JPY' as const

export interface Participant {
  id: string
  name: string
}

export interface Expense {
  id: string
  description: string
  amount: number
  payerId: string
  burdenParticipantIds: string[]
}

export interface CalculationStateV1 {
  version: typeof STATE_VERSION
  currency: typeof STATE_CURRENCY
  participants: Participant[]
  expenses: Expense[]
  roundingAssigneeId: string | null
}

export interface ValidationIssue {
  path: string
  message: string
}

export type ValidationResult<T> =
  | { success: true; data: T; issues: [] }
  | { success: false; issues: ValidationIssue[] }

export type IdFactory = (kind: 'participant' | 'expense') => string

export type StateMutationResult =
  | { ok: true; state: CalculationStateV1 }
  | { ok: false; message: string; field?: string }

export interface ExpenseInput {
  description: string
  amount: number
  payerId: string
  burdenParticipantIds: string[]
}

export function createEmptyState(): CalculationStateV1 {
  return {
    version: STATE_VERSION,
    currency: STATE_CURRENCY,
    participants: [],
    expenses: [],
    roundingAssigneeId: null,
  }
}

export function createStableId(kind: 'participant' | 'expense'): string {
  const cryptoApi = globalThis.crypto
  const randomPart =
    typeof cryptoApi?.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : Array.from(cryptoApi?.getRandomValues(new Uint8Array(16)) ?? [], (value) =>
          value.toString(16).padStart(2, '0'),
        ).join('') || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  return `${kind}_${randomPart}`
}

export function normalizeName(value: string): string {
  return value.trim()
}

export function validateCalculationState(input: unknown): ValidationResult<CalculationStateV1> {
  const issues: ValidationIssue[] = []
  if (!isRecord(input)) {
    return failure('', '計算データはオブジェクトである必要があります。')
  }

  if (input.version !== STATE_VERSION) {
    issues.push({ path: 'version', message: '対応していない状態バージョンです。' })
  }
  if (input.currency !== STATE_CURRENCY) {
    issues.push({ path: 'currency', message: '通貨はJPYである必要があります。' })
  }

  const participants = parseParticipants(input.participants, issues)
  const participantIds = new Set(participants.map(({ id }) => id))
  const expenses = parseExpenses(input.expenses, participantIds, issues)

  let roundingAssigneeId: string | null = null
  if (input.roundingAssigneeId !== null && typeof input.roundingAssigneeId !== 'string') {
    issues.push({
      path: 'roundingAssigneeId',
      message: '端数調整担当者は参加者IDまたはnullである必要があります。',
    })
  } else {
    roundingAssigneeId =
      typeof input.roundingAssigneeId === 'string' ? input.roundingAssigneeId.trim() : null
  }

  if (participants.length === 0 && roundingAssigneeId !== null) {
    issues.push({
      path: 'roundingAssigneeId',
      message: '参加者がいない場合、端数調整担当者は選択できません。',
    })
  }
  if (participants.length > 0 && !roundingAssigneeId) {
    issues.push({
      path: 'roundingAssigneeId',
      message: '端数調整担当者を1人選択してください。',
    })
  } else if (roundingAssigneeId && !participantIds.has(roundingAssigneeId)) {
    issues.push({
      path: 'roundingAssigneeId',
      message: '端数調整担当者が参加者一覧に存在しません。',
    })
  }

  if (issues.length > 0) {
    return { success: false, issues }
  }

  return {
    success: true,
    data: {
      version: STATE_VERSION,
      currency: STATE_CURRENCY,
      participants,
      expenses,
      roundingAssigneeId,
    },
    issues: [],
  }
}

function parseParticipants(input: unknown, issues: ValidationIssue[]): Participant[] {
  if (!Array.isArray(input)) {
    issues.push({ path: 'participants', message: '参加者一覧が必要です。' })
    return []
  }

  const participants: Participant[] = []
  const ids = new Set<string>()
  const names = new Set<string>()

  input.forEach((candidate, index) => {
    const path = `participants[${index}]`
    if (!isRecord(candidate)) {
      issues.push({ path, message: '参加者の形式が正しくありません。' })
      return
    }

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const name = typeof candidate.name === 'string' ? normalizeName(candidate.name) : ''
    let valid = true

    if (!id) {
      issues.push({ path: `${path}.id`, message: '参加者IDは空にできません。' })
      valid = false
    } else if (ids.has(id)) {
      issues.push({ path: `${path}.id`, message: '参加者IDが重複しています。' })
      valid = false
    }
    if (!name) {
      issues.push({ path: `${path}.name`, message: '参加者名は空にできません。' })
      valid = false
    } else if (names.has(name)) {
      issues.push({ path: `${path}.name`, message: '参加者名が重複しています。' })
      valid = false
    }

    if (id) ids.add(id)
    if (name) names.add(name)
    if (valid) participants.push({ id, name })
  })

  return participants
}

function parseExpenses(
  input: unknown,
  participantIds: Set<string>,
  issues: ValidationIssue[],
): Expense[] {
  if (!Array.isArray(input)) {
    issues.push({ path: 'expenses', message: '支払い一覧が必要です。' })
    return []
  }

  const expenses: Expense[] = []
  const expenseIds = new Set<string>()

  input.forEach((candidate, index) => {
    const path = `expenses[${index}]`
    if (!isRecord(candidate)) {
      issues.push({ path, message: '支払いの形式が正しくありません。' })
      return
    }

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const description =
      typeof candidate.description === 'string' ? candidate.description.trim() : ''
    const payerId = typeof candidate.payerId === 'string' ? candidate.payerId.trim() : ''
    const amount = candidate.amount
    const burdenParticipantIds = Array.isArray(candidate.burdenParticipantIds)
      ? candidate.burdenParticipantIds.map((value) =>
          typeof value === 'string' ? value.trim() : '',
        )
      : []
    let valid = true

    if (!id) {
      issues.push({ path: `${path}.id`, message: '支払いIDは空にできません。' })
      valid = false
    } else if (expenseIds.has(id)) {
      issues.push({ path: `${path}.id`, message: '支払いIDが重複しています。' })
      valid = false
    }
    if (!description) {
      issues.push({ path: `${path}.description`, message: '支払いの説明を入力してください。' })
      valid = false
    }
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      issues.push({
        path: `${path}.amount`,
        message: '金額は正の安全な整数円で入力してください。',
      })
      valid = false
    }
    if (!payerId || !participantIds.has(payerId)) {
      issues.push({ path: `${path}.payerId`, message: '支払者が参加者一覧に存在しません。' })
      valid = false
    }
    if (!Array.isArray(candidate.burdenParticipantIds) || burdenParticipantIds.length === 0) {
      issues.push({
        path: `${path}.burdenParticipantIds`,
        message: '負担者を1人以上選択してください。',
      })
      valid = false
    } else {
      const seen = new Set<string>()
      burdenParticipantIds.forEach((participantId, burdenIndex) => {
        if (!participantId || !participantIds.has(participantId)) {
          issues.push({
            path: `${path}.burdenParticipantIds[${burdenIndex}]`,
            message: '負担者が参加者一覧に存在しません。',
          })
          valid = false
        } else if (seen.has(participantId)) {
          issues.push({
            path: `${path}.burdenParticipantIds[${burdenIndex}]`,
            message: '同じ負担者を重複して選択できません。',
          })
          valid = false
        }
        seen.add(participantId)
      })
    }

    if (id) expenseIds.add(id)
    if (valid && typeof amount === 'number') {
      expenses.push({ id, description, amount, payerId, burdenParticipantIds })
    }
  })

  return expenses
}

export function addParticipant(
  state: CalculationStateV1,
  rawName: string,
  idFactory: IdFactory = createStableId,
): StateMutationResult {
  const name = normalizeName(rawName)
  if (!name) return mutationFailure('名前を入力してください。', 'participant-name')
  if (state.participants.some((participant) => participant.name === name)) {
    return mutationFailure('同じ名前の参加者は追加できません。', 'participant-name')
  }

  const id = uniqueId(state, 'participant', idFactory)
  const participants = [...state.participants, { id, name }]
  return {
    ok: true,
    state: {
      ...state,
      participants,
      roundingAssigneeId: state.roundingAssigneeId ?? id,
    },
  }
}

export function renameParticipant(
  state: CalculationStateV1,
  participantId: string,
  rawName: string,
): StateMutationResult {
  const name = normalizeName(rawName)
  if (!name) return mutationFailure('名前を入力してください。', `participant-name-${participantId}`)
  if (
    state.participants.some(
      (participant) => participant.id !== participantId && participant.name === name,
    )
  ) {
    return mutationFailure(
      '同じ名前の参加者には変更できません。',
      `participant-name-${participantId}`,
    )
  }
  if (!state.participants.some((participant) => participant.id === participantId)) {
    return mutationFailure('変更する参加者が見つかりません。')
  }

  return {
    ok: true,
    state: {
      ...state,
      participants: state.participants.map((participant) =>
        participant.id === participantId ? { ...participant, name } : participant,
      ),
    },
  }
}

export function removeParticipant(
  state: CalculationStateV1,
  participantId: string,
): StateMutationResult {
  if (!state.participants.some((participant) => participant.id === participantId)) {
    return mutationFailure('削除する参加者が見つかりません。')
  }
  if (
    state.expenses.some(
      (expense) =>
        expense.payerId === participantId || expense.burdenParticipantIds.includes(participantId),
    )
  ) {
    return mutationFailure('この参加者は支払いから参照されています。先に支払いを編集してください。')
  }

  const participants = state.participants.filter((participant) => participant.id !== participantId)
  const roundingAssigneeId =
    state.roundingAssigneeId === participantId
      ? (participants[0]?.id ?? null)
      : state.roundingAssigneeId
  return { ok: true, state: { ...state, participants, roundingAssigneeId } }
}

export function setRoundingAssignee(
  state: CalculationStateV1,
  participantId: string,
): StateMutationResult {
  if (!state.participants.some((participant) => participant.id === participantId)) {
    return mutationFailure('端数調整担当者が参加者一覧に存在しません。')
  }
  return { ok: true, state: { ...state, roundingAssigneeId: participantId } }
}

export function saveExpense(
  state: CalculationStateV1,
  input: ExpenseInput,
  expenseId?: string,
  idFactory: IdFactory = createStableId,
): StateMutationResult {
  const description = input.description.trim()
  if (!description) return mutationFailure('支払いの説明を入力してください。', 'expense-description')
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    return mutationFailure('金額は正の整数円で入力してください。', 'expense-amount')
  }
  if (!state.participants.some(({ id }) => id === input.payerId)) {
    return mutationFailure('支払者を選択してください。', 'expense-payer')
  }
  const burdenIds = [...new Set(input.burdenParticipantIds)]
  if (burdenIds.length === 0) {
    return mutationFailure('負担者を1人以上選択してください。', 'expense-burdens')
  }
  if (burdenIds.some((id) => !state.participants.some((participant) => participant.id === id))) {
    return mutationFailure('選択された負担者が参加者一覧に存在しません。', 'expense-burdens')
  }
  if (expenseId && !state.expenses.some(({ id }) => id === expenseId)) {
    return mutationFailure('編集する支払いが見つかりません。')
  }

  const expense: Expense = {
    id: expenseId ?? uniqueId(state, 'expense', idFactory),
    description,
    amount: input.amount,
    payerId: input.payerId,
    burdenParticipantIds: burdenIds,
  }
  const expenses = expenseId
    ? state.expenses.map((current) => (current.id === expenseId ? expense : current))
    : [...state.expenses, expense]
  return { ok: true, state: { ...state, expenses } }
}

export function removeExpense(state: CalculationStateV1, expenseId: string): StateMutationResult {
  if (!state.expenses.some(({ id }) => id === expenseId)) {
    return mutationFailure('削除する支払いが見つかりません。')
  }
  return {
    ok: true,
    state: { ...state, expenses: state.expenses.filter(({ id }) => id !== expenseId) },
  }
}

function uniqueId(
  state: CalculationStateV1,
  kind: 'participant' | 'expense',
  idFactory: IdFactory,
): string {
  const existing = new Set([
    ...state.participants.map(({ id }) => id),
    ...state.expenses.map(({ id }) => id),
  ])
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = idFactory(kind).trim()
    if (id && !existing.has(id)) return id
  }
  throw new Error('一意なIDを生成できませんでした。')
}

function mutationFailure(message: string, field?: string): StateMutationResult {
  return field ? { ok: false, message, field } : { ok: false, message }
}

function failure(path: string, message: string): ValidationResult<never> {
  return { success: false, issues: [{ path, message }] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
