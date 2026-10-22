import { describe, expect, it } from 'vitest'
import { calculateSettlement } from './calculate'
import type { CalculationStateV1 } from './domain'
import {
  MAX_COMPRESSED_STATE_BYTES,
  createShareUrl,
  decodeLegacyStatePayload,
  decodeStatePayload,
  encodeStatePayload,
  restoreStateFromFragment,
} from './share'

const state: CalculationStateV1 = {
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
      amount: 1001,
      payerId: 'p1',
      burdenParticipantIds: ['p1', 'p2'],
    },
  ],
  roundingAssigneeId: 'p2',
}

/** 共有URLにはIDを含めないため、復元後は位置に基づくIDへ振り直される。 */
const restoredState: CalculationStateV1 = {
  version: 1,
  currency: 'JPY',
  participants: [
    { id: 'participant_1', name: 'あおい' },
    { id: 'participant_2', name: 'はる' },
  ],
  expenses: [
    {
      id: 'expense_1',
      description: '夕食',
      amount: 1001,
      payerId: 'participant_1',
      burdenParticipantIds: ['participant_1', 'participant_2'],
    },
  ],
  roundingAssigneeId: 'participant_2',
}

describe('state URL sharing', () => {
  it('決定的に往復変換し、計算結果を復元する', async () => {
    const first = await encodeStatePayload(state)
    const second = await encodeStatePayload(state)
    expect(first).toEqual(second)
    expect(first.success).toBe(true)
    if (!first.success) return

    const restored = await decodeStatePayload(first.payload)
    expect(restored.success).toBe(true)
    if (restored.success) {
      expect(restored.state).toEqual(restoredState)
      expect(calculateSettlement(restored.state).transfers.map(({ amount }) => amount)).toEqual(
        calculateSettlement(state).transfers.map(({ amount }) => amount),
      )
      expect(Object.keys(restored.state).sort()).toEqual(
        ['currency', 'expenses', 'participants', 'roundingAssigneeId', 'version'].sort(),
      )
    }
  })

  it('参加者の位置で支払者・負担者・端数担当を復元する', async () => {
    const sameNames: CalculationStateV1 = {
      ...state,
      participants: [
        { id: 'p1', name: 'あお' },
        { id: 'p2', name: 'そら' },
        { id: 'p3', name: 'みな' },
      ],
      expenses: [
        { id: 'e1', description: '昼食', amount: 900, payerId: 'p2', burdenParticipantIds: ['p3', 'p1'] },
      ],
      roundingAssigneeId: 'p3',
    }
    const encoded = await encodeStatePayload(sameNames)
    if (!encoded.success) throw new Error(encoded.message)
    const decoded = await decodeStatePayload(encoded.payload)
    expect(decoded.success).toBe(true)
    if (!decoded.success) return
    expect(decoded.state.expenses[0]).toMatchObject({
      payerId: 'participant_2',
      burdenParticipantIds: ['participant_3', 'participant_1'],
    })
    expect(decoded.state.roundingAssigneeId).toBe('participant_3')
  })

  it('乱数IDを含めず短い共有URLを作る', async () => {
    const withLongIds: CalculationStateV1 = {
      ...state,
      participants: state.participants.map((participant) => ({
        ...participant,
        id: `participant_${'0'.repeat(8)}-${participant.id}-4000-8000-${'f'.repeat(12)}`,
      })),
    }
    withLongIds.expenses = [
      {
        ...state.expenses[0]!,
        payerId: withLongIds.participants[0]!.id,
        burdenParticipantIds: withLongIds.participants.map(({ id }) => id),
      },
    ]
    withLongIds.roundingAssigneeId = withLongIds.participants[1]!.id
    const result = await createShareUrl(withLongIds, 'https://example.com/')
    if (!result.success) throw new Error(result.message)
    expect(result.url).toMatch(/^https:\/\/example\.com\/#s=[\w-]+$/u)
    expect(result.url).not.toContain('participant')
    expect(result.url.length).toBeLessThan(100)
  })

  it('旧形式（#state=）の共有リンクも復元できる', async () => {
    const legacyPayload = await compressJson({
      v: 1,
      c: 'JPY',
      p: [['p1', 'あおい'], ['p2', 'はる']],
      e: [['e1', '夕食', 1001, 'p1', ['p1', 'p2']]],
      r: 'p2',
    })
    await expect(restoreStateFromFragment(`#state=${legacyPayload}`)).resolves.toEqual({
      status: 'success',
      state,
    })
    await expect(decodeLegacyStatePayload(legacyPayload)).resolves.toEqual({ success: true, state })
  })

  it('不正なbase64url、圧縮データ、検証失敗を区別せず安全に拒否する', async () => {
    await expect(decodeStatePayload('not+base64')).resolves.toMatchObject({
      success: false,
      code: 'invalid-data',
    })
    await expect(decodeStatePayload('bm90LWRlZmxhdGU')).resolves.toMatchObject({
      success: false,
      code: 'invalid-data',
    })
    const invalidStatePayload = await compressJson([2, ['あおい'], [['夕食', 0, 0, []]], 0], 'deflate-raw')
    await expect(decodeStatePayload(invalidStatePayload)).resolves.toMatchObject({
      success: false,
      code: 'invalid-data',
    })
    const outOfRangePayload = await compressJson([2, ['あおい'], [['夕食', 100, 1, []]], 0], 'deflate-raw')
    await expect(decodeStatePayload(outOfRangePayload)).resolves.toMatchObject({
      success: false,
      code: 'invalid-data',
    })
  })

  it('未対応バージョンを専用結果として返す', async () => {
    const payload = await compressJson([3, [], [], -1], 'deflate-raw')
    await expect(restoreStateFromFragment(`#s=${payload}`)).resolves.toMatchObject({
      status: 'unsupported-version',
    })
    const legacyPayload = await compressJson({ v: 2, c: 'JPY', p: [], e: [], r: null })
    await expect(restoreStateFromFragment(`#state=${legacyPayload}`)).resolves.toMatchObject({
      status: 'unsupported-version',
    })
  })

  it('過大なエンコード前データとデコード前データを拒否する', async () => {
    const hugeState: CalculationStateV1 = {
      ...state,
      participants: [{ id: 'p1', name: 'あ'.repeat(70_000) }],
      expenses: [],
      roundingAssigneeId: 'p1',
    }
    await expect(encodeStatePayload(hugeState)).resolves.toMatchObject({
      success: false,
      code: 'too-large',
    })
    await expect(decodeStatePayload('a'.repeat(MAX_COMPRESSED_STATE_BYTES * 2))).resolves.toMatchObject({
      success: false,
      code: 'invalid-data',
    })
  })

  it('8,000文字を超える共有URLを提示しない', async () => {
    await expect(createShareUrl(state, `https://example.com/${'x'.repeat(8_000)}`)).resolves.toMatchObject({
      success: false,
      code: 'too-large',
    })
  })

  it('stateのないフラグメントでは復元を行わない', async () => {
    await expect(restoreStateFromFragment('#section=help')).resolves.toEqual({ status: 'none' })
  })
})

async function compressJson(
  value: unknown,
  format: 'deflate' | 'deflate-raw' = 'deflate',
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format))
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  compressed.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
