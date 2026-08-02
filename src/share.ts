import {
  validateCalculationState,
  type CalculationStateV1,
} from './domain'

export const MAX_SHARE_URL_LENGTH = 8_000
export const MAX_SERIALIZED_STATE_BYTES = 64 * 1024
export const MAX_COMPRESSED_STATE_BYTES = 48 * 1024

interface WireStateV1 {
  v: 1
  c: 'JPY'
  p: Array<[string, string]>
  e: Array<[string, string, number, string, string[]]>
  r: string | null
}

export type ShareFailureCode =
  | 'unsupported-browser'
  | 'too-large'
  | 'invalid-state'
  | 'invalid-data'
  | 'unsupported-version'

export type SharePayloadResult =
  | { success: true; payload: string }
  | { success: false; code: ShareFailureCode; message: string }

export type ShareUrlResult =
  | { success: true; url: string; payload: string }
  | { success: false; code: ShareFailureCode; message: string }

export type RestoreResult =
  | { status: 'none' }
  | { status: 'success'; state: CalculationStateV1 }
  | { status: 'invalid'; message: string }
  | { status: 'unsupported-version'; message: string }
  | { status: 'unsupported-browser'; message: string }

export function supportsStateCompression(): boolean {
  return (
    typeof globalThis.CompressionStream === 'function' &&
    typeof globalThis.DecompressionStream === 'function' &&
    typeof globalThis.TextEncoder === 'function' &&
    typeof globalThis.TextDecoder === 'function'
  )
}

export async function encodeStatePayload(state: CalculationStateV1): Promise<SharePayloadResult> {
  if (!supportsStateCompression()) {
    return {
      success: false,
      code: 'unsupported-browser',
      message: 'このブラウザは共有リンクの圧縮機能に対応していません。最新のブラウザでお試しください。',
    }
  }
  const validated = validateCalculationState(state)
  if (!validated.success) {
    return {
      success: false,
      code: 'invalid-state',
      message: '入力内容を確認してから共有リンクを作成してください。',
    }
  }

  const serialized = new TextEncoder().encode(JSON.stringify(toWireState(validated.data)))
  if (serialized.byteLength > MAX_SERIALIZED_STATE_BYTES) {
    return tooLargeFailure()
  }
  const compressed = await compress(serialized)
  if (compressed.byteLength > MAX_COMPRESSED_STATE_BYTES) {
    return tooLargeFailure()
  }
  return { success: true, payload: toBase64Url(compressed) }
}

export async function createShareUrl(
  state: CalculationStateV1,
  currentUrl: string,
): Promise<ShareUrlResult> {
  const encoded = await encodeStatePayload(state)
  if (!encoded.success) return encoded

  let url: URL
  try {
    url = new URL(currentUrl)
  } catch {
    return { success: false, code: 'invalid-data', message: '現在のURLを共有リンクに変換できません。' }
  }
  url.hash = `state=${encoded.payload}`
  const shareUrl = url.toString()
  if (shareUrl.length > MAX_SHARE_URL_LENGTH) return tooLargeFailure()
  return { success: true, url: shareUrl, payload: encoded.payload }
}

export async function restoreStateFromFragment(fragment: string): Promise<RestoreResult> {
  const parameters = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment)
  const payload = parameters.get('state')
  if (!payload) return { status: 'none' }
  if (!supportsStateCompression()) {
    return {
      status: 'unsupported-browser',
      message: 'このブラウザでは共有リンクを復元できません。最新のブラウザでお試しください。',
    }
  }

  const decoded = await decodeStatePayload(payload)
  if (decoded.success) return { status: 'success', state: decoded.state }
  if (decoded.code === 'unsupported-version') {
    return { status: 'unsupported-version', message: decoded.message }
  }
  return { status: 'invalid', message: decoded.message }
}

export async function decodeStatePayload(
  payload: string,
): Promise<
  | { success: true; state: CalculationStateV1 }
  | { success: false; code: ShareFailureCode; message: string }
> {
  if (!supportsStateCompression()) {
    return {
      success: false,
      code: 'unsupported-browser',
      message: 'このブラウザでは共有リンクを復元できません。',
    }
  }
  if (!payload || payload.length > encodedLengthLimit(MAX_COMPRESSED_STATE_BYTES)) {
    return invalidData('共有リンクのデータが空か、大きすぎます。')
  }

  try {
    const compressed = fromBase64Url(payload)
    if (compressed.byteLength > MAX_COMPRESSED_STATE_BYTES) {
      return invalidData('共有リンクのデータが大きすぎます。')
    }
    const decompressed = await decompressWithLimit(compressed, MAX_SERIALIZED_STATE_BYTES)
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decompressed))
    if (isRecord(parsed) && parsed.v !== 1) {
      return {
        success: false,
        code: 'unsupported-version',
        message: 'この共有リンクのバージョンには対応していません。作成者に新しいリンクを依頼してください。',
      }
    }
    const expanded = fromWireState(parsed)
    if (!expanded) return invalidData('共有リンクの形式が正しくありません。')
    const validated = validateCalculationState(expanded)
    if (!validated.success) return invalidData('共有リンクの計算データを検証できませんでした。')
    return { success: true, state: validated.data }
  } catch {
    return invalidData('共有リンクが壊れているか、正しい形式ではありません。')
  }
}

function toWireState(state: CalculationStateV1): WireStateV1 {
  return {
    v: 1,
    c: 'JPY',
    p: state.participants.map(({ id, name }) => [id, name]),
    e: state.expenses.map(
      ({ id, description, amount, payerId, burdenParticipantIds }) => [
        id,
        description,
        amount,
        payerId,
        burdenParticipantIds,
      ],
    ),
    r: state.roundingAssigneeId,
  }
}

function fromWireState(input: unknown): unknown | null {
  if (!isRecord(input) || input.v !== 1 || input.c !== 'JPY') return null
  if (!Array.isArray(input.p) || !Array.isArray(input.e)) return null
  return {
    version: input.v,
    currency: input.c,
    participants: input.p.map((participant) =>
      Array.isArray(participant) && participant.length === 2
        ? { id: participant[0], name: participant[1] }
        : null,
    ),
    expenses: input.e.map((expense) =>
      Array.isArray(expense) && expense.length === 5
        ? {
            id: expense[0],
            description: expense[1],
            amount: expense[2],
            payerId: expense[3],
            burdenParticipantIds: expense[4],
          }
        : null,
    ),
    roundingAssigneeId: input.r,
  }
}

async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'))
  return collectStream(stream, MAX_COMPRESSED_STATE_BYTES)
}

async function decompressWithLimit(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return collectStream(stream, limit)
}

async function collectStream(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel()
      throw new RangeError('状態データがサイズ上限を超えています。')
    }
    chunks.push(value)
  }
  const output = new Uint8Array(length)
  let offset = 0
  chunks.forEach((chunk) => {
    output.set(chunk, offset)
    offset += chunk.byteLength
  })
  return output
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url(payload: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(payload) || payload.length % 4 === 1) {
    throw new TypeError('base64url形式ではありません。')
  }
  const base64 = payload.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function encodedLengthLimit(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

function tooLargeFailure(): { success: false; code: 'too-large'; message: string } {
  return {
    success: false,
    code: 'too-large',
    message: '共有リンクが8,000文字の上限を超えます。支払い件数や説明を減らしてから再度お試しください。',
  }
}

function invalidData(
  message: string,
): { success: false; code: 'invalid-data'; message: string } {
  return { success: false, code: 'invalid-data', message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
