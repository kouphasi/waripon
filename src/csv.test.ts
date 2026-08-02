import { describe, expect, it } from 'vitest'
import { CSV_TEMPLATE, parseExpenseCsv } from './csv'

function sequentialIds() {
  let index = 0
  return (kind: 'participant' | 'expense') => `${kind}-${++index}`
}

describe('parseExpenseCsv', () => {
  it('有効なCSVを初出順の参加者と支払い候補へ変換する', () => {
    const result = parseExpenseCsv(CSV_TEMPLATE, sequentialIds())
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.candidate.participants.map(({ name }) => name)).toEqual(['あおい', 'はる', 'なつ'])
    expect(result.candidate.expenses).toHaveLength(2)
    expect(result.candidate.roundingAssigneeId).toBe(result.candidate.participants[0]?.id)
  })

  it('引用符付きのカンマと引用符、BOMを保持して解析する', () => {
    const result = parseExpenseCsv(
      '\uFEFFdescription,amount,paid_by,split_among\n"夕食, \"\"特別\"\"",1200,あおい,あおい|はる',
      sequentialIds(),
    )
    expect(result.success).toBe(true)
    if (result.success) expect(result.candidate.expenses[0]?.description).toBe('夕食, "特別"')
  })

  it('参照名の前後の空白を除去する', () => {
    const result = parseExpenseCsv(
      'description,amount,paid_by,split_among\n昼食,1000, あおい , あおい | はる ',
      sequentialIds(),
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.candidate.participants.map(({ name }) => name)).toEqual(['あおい', 'はる'])
    }
  })

  it.each([
    [
      'ヘッダー不足',
      'description,amount,paid_by\n昼食,1000,あおい',
      '必須ヘッダー',
    ],
    [
      'ヘッダー重複',
      'description,amount,paid_by,split_among,amount\n昼食,1000,あおい,あおい,1000',
      '重複',
    ],
    [
      '無効な金額',
      'description,amount,paid_by,split_among\n昼食,10.5,あおい,あおい',
      '正の整数',
    ],
    [
      '空の負担者',
      'description,amount,paid_by,split_among\n昼食,1000,あおい,',
      '1人以上',
    ],
    [
      '負担者重複',
      'description,amount,paid_by,split_among\n昼食,1000,あおい,あおい|あおい',
      '重複',
    ],
  ])('%sを行番号付きで拒否する', (_, csv, expectedMessage) => {
    const result = parseExpenseCsv(csv, sequentialIds())
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors.some(({ line, message }) => line !== null && message.includes(expectedMessage))).toBe(
        true,
      )
    }
  })

  it('不正な引用符を構文エラーとして拒否する', () => {
    const result = parseExpenseCsv(
      'description,amount,paid_by,split_among\n"閉じない,1000,あおい,あおい',
      sequentialIds(),
    )
    expect(result.success).toBe(false)
    if (!result.success) expect(result.errors.some(({ message }) => message.includes('構文'))).toBe(true)
  })

  it('複数行のエラーを一括で返し、部分候補を返さない', () => {
    const result = parseExpenseCsv(
      'description,amount,paid_by,split_among\n,0,,\n夕食,-1,あおい,あおい|あおい',
      sequentialIds(),
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(new Set(result.errors.map(({ line }) => line))).toEqual(new Set([2, 3]))
      expect('candidate' in result).toBe(false)
    }
  })
})
