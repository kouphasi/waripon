import { describe, expect, it } from 'vitest'
import { calculateSettlement } from './calculate'
import type { CalculationStateV1 } from './domain'
import {
  MAX_COMPRESSED_STATE_BYTES,
  createShareUrl,
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
      expect(restored.state).toEqual(state)
      expect(calculateSettlement(restored.state)).toEqual(calculateSettlement(state))
      expect(Object.keys(restored.state).sort()).toEqual(
        ['currency', 'expenses', 'participants', 'roundingAssigneeId', 'version'].sort(),
      )
    }
  })

  it('名前を変更しても安定IDによる参照を維持する', async () => {
    const renamed = {
      ...state,
      participants: state.participants.map((participant) =>
        participant.id === 'p1' ? { ...participant, name: 'あお' } : participant,
      ),
    }
    const encoded = await encodeStatePayload(renamed)
    if (!encoded.success) throw new Error(encoded.message)
    const decoded = await decodeStatePayload(encoded.payload)
    expect(decoded.success).toBe(true)
    if (decoded.success) expect(decoded.state.expenses[0]?.payerId).toBe('p1')
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
    const invalidStatePayload = await compressJson({
      v: 1,
      c: 'JPY',
      p: [['p1', 'あおい']],
      e: [['e1', '夕食', 0, 'p1', ['p1']]],
      r: 'p1',
    })
    await expect(decodeStatePayload(invalidStatePayload)).resolves.toMatchObject({
      success: false,
      code: 'invalid-data',
    })
  })

  it('未対応バージョンを専用結果として返す', async () => {
    const payload = await compressJson({ v: 2, c: 'JPY', p: [], e: [], r: null })
    await expect(restoreStateFromFragment(`#state=${payload}`)).resolves.toMatchObject({
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

async function compressJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  compressed.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
