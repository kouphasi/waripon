import Papa from 'papaparse'
import {
  STATE_CURRENCY,
  STATE_VERSION,
  createStableId,
  validateCalculationState,
  type CalculationStateV1,
  type IdFactory,
} from './domain'

export const CSV_HEADERS = ['description', 'amount', 'paid_by', 'split_among'] as const
export const CSV_TEMPLATE = `description,amount,paid_by,split_among
夕食,6000,あおい,あおい|はる|なつ
"タクシー, 深夜",2400,はる,あおい|はる|なつ
`

export interface CsvImportError {
  line: number | null
  message: string
}

export type CsvImportResult =
  | { success: true; candidate: CalculationStateV1; errors: [] }
  | { success: false; errors: CsvImportError[] }

interface NormalizedCsvRow {
  line: number
  description: string
  amount: number
  payerName: string
  burdenNames: string[]
}

export function parseExpenseCsv(
  source: string,
  idFactory: IdFactory = createStableId,
): CsvImportResult {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  if (text.includes('\uFFFD')) {
    return csvFailure(1, 'UTF-8として読み取れない文字が含まれています。')
  }

  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
  })
  const errors: CsvImportError[] = parsed.errors.map((error) => ({
    line: typeof error.row === 'number' ? error.row + 1 : null,
    message: `CSVの構文が正しくありません（${error.message}）。`,
  }))
  const rows = parsed.data
  const rawHeader = rows[0]
  if (!rawHeader || rawHeader.length === 0) {
    return csvFailure(1, 'CSVヘッダーがありません。')
  }

  const header = rawHeader.map((value) => value.trim())
  const duplicateHeaders = header.filter((value, index) => value && header.indexOf(value) !== index)
  if (duplicateHeaders.length > 0) {
    errors.push({
      line: 1,
      message: `ヘッダーが重複しています：${[...new Set(duplicateHeaders)].join('、')}`,
    })
  }
  const missingHeaders = CSV_HEADERS.filter((required) => !header.includes(required))
  if (missingHeaders.length > 0) {
    errors.push({
      line: 1,
      message: `必須ヘッダーがありません：${missingHeaders.join('、')}`,
    })
  }

  if (rows.length < 2) {
    errors.push({ line: 2, message: '支払い行を1行以上入力してください。' })
  }
  if (errors.some(({ line }) => line === 1)) {
    return { success: false, errors }
  }

  const indexes = Object.fromEntries(
    CSV_HEADERS.map((name) => [name, header.indexOf(name)]),
  ) as Record<(typeof CSV_HEADERS)[number], number>
  const normalizedRows: NormalizedCsvRow[] = []

  rows.slice(1).forEach((row, rowIndex) => {
    const line = rowIndex + 2
    const description = (row[indexes.description] ?? '').trim()
    const rawAmount = (row[indexes.amount] ?? '').trim()
    const payerName = (row[indexes.paid_by] ?? '').trim()
    const rawBurdenNames = (row[indexes.split_among] ?? '').split('|').map((name) => name.trim())
    let valid = true

    if (!description) {
      errors.push({ line, message: 'descriptionを入力してください。' })
      valid = false
    }
    if (!/^\d+$/.test(rawAmount)) {
      errors.push({ line, message: 'amountは正の整数円で入力してください。' })
      valid = false
    }
    const amount = Number(rawAmount)
    if (/^\d+$/.test(rawAmount) && (!Number.isSafeInteger(amount) || amount <= 0)) {
      errors.push({ line, message: 'amountは正の安全な整数円で入力してください。' })
      valid = false
    }
    if (!payerName) {
      errors.push({ line, message: 'paid_byを入力してください。' })
      valid = false
    }
    if (rawBurdenNames.length === 0 || rawBurdenNames.some((name) => !name)) {
      errors.push({ line, message: 'split_amongには1人以上の名前を入力してください。' })
      valid = false
    }
    if (new Set(rawBurdenNames).size !== rawBurdenNames.length) {
      errors.push({ line, message: 'split_amongに同じ名前を重複して指定できません。' })
      valid = false
    }

    if (valid) {
      normalizedRows.push({
        line,
        description,
        amount,
        payerName,
        burdenNames: rawBurdenNames,
      })
    }
  })

  if (errors.length > 0) return { success: false, errors }

  const participantNames: string[] = []
  normalizedRows.forEach(({ payerName, burdenNames }) => {
    ;[payerName, ...burdenNames].forEach((name) => {
      if (!participantNames.includes(name)) participantNames.push(name)
    })
  })
  const usedIds = new Set<string>()
  const nextId = (kind: 'participant' | 'expense'): string => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = idFactory(kind).trim()
      if (id && !usedIds.has(id)) {
        usedIds.add(id)
        return id
      }
    }
    throw new Error('CSVインポート用の一意なIDを生成できませんでした。')
  }
  const participants = participantNames.map((name) => ({ id: nextId('participant'), name }))
  const participantIdByName = new Map(participants.map(({ id, name }) => [name, id]))
  const candidate: CalculationStateV1 = {
    version: STATE_VERSION,
    currency: STATE_CURRENCY,
    participants,
    expenses: normalizedRows.map(({ description, amount, payerName, burdenNames }) => ({
      id: nextId('expense'),
      description,
      amount,
      payerId: participantIdByName.get(payerName) ?? '',
      burdenParticipantIds: burdenNames.map((name) => participantIdByName.get(name) ?? ''),
    })),
    roundingAssigneeId: participants[0]?.id ?? null,
  }
  const validated = validateCalculationState(candidate)
  if (!validated.success) {
    return {
      success: false,
      errors: validated.issues.map(({ message }) => ({ line: null, message })),
    }
  }
  return { success: true, candidate: validated.data, errors: [] }
}

export function csvTemplateDataUrl(): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${CSV_TEMPLATE}`)}`
}

function csvFailure(line: number | null, message: string): CsvImportResult {
  return { success: false, errors: [{ line, message }] }
}
