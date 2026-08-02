// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountApp, mountAppFromUrl } from './app'
import type { CalculationStateV1 } from './domain'
import { encodeStatePayload } from './share'

const initialState: CalculationStateV1 = {
  version: 1,
  currency: 'JPY',
  participants: [
    { id: 'old-p1', name: '既存さん' },
    { id: 'old-p2', name: 'そのほか' },
  ],
  expenses: [
    {
      id: 'old-e1',
      description: '既存の支払い',
      amount: 500,
      payerId: 'old-p1',
      burdenParticipantIds: ['old-p1', 'old-p2'],
    },
  ],
  roundingAssigneeId: 'old-p1',
}

let root: HTMLDivElement
let idIndex: number
const idFactory = (kind: 'participant' | 'expense') => `${kind}-${++idIndex}`

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  root = document.querySelector<HTMLDivElement>('#app')!
  idIndex = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('manual expense flow', () => {
  it('手入力から精算し、端数担当radioの変更を即時反映する', async () => {
    const app = mountApp(root, { idFactory })
    addParticipantThroughUi('あおい')
    addParticipantThroughUi('はる')

    click('[data-action="open-expense"]')
    expect(document.activeElement).not.toBe(qs('#expense-description'))
    await flushUi()
    expect(document.activeElement).toBe(qs('#expense-description'))
    setValue('#expense-description', '夕食')
    setValue('#expense-amount', '1001')
    submit('[data-form="expense"]')

    expect(app.getState().expenses).toHaveLength(1)
    expect(root.textContent).toContain('はる から あおい へ')
    expect(root.textContent).toContain('501円')

    const secondRadio = qs<HTMLInputElement>('input[name="roundingAssigneeId"][value="participant-2"]')
    secondRadio.checked = true
    secondRadio.dispatchEvent(new Event('change', { bubbles: true }))
    expect(app.getState().roundingAssigneeId).toBe('participant-2')
    expect(root.textContent).toContain('端数調整 +1円')
  })

  it('入力エラーを通知して対象欄へフォーカスする', async () => {
    mountApp(root, { idFactory })
    submit('[data-form="add-participant"]')
    await flushUi()
    const input = qs<HTMLInputElement>('#participant-name')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(qs('[role="alert"]').textContent).toContain('名前を入力')
  })
})

describe('CSV replacement flow', () => {
  it('キャンセルでは維持し、確定したときだけ全データを置き換える', async () => {
    const app = mountApp(root, { initialState, idFactory })
    await chooseCsv('description,amount,paid_by,split_among\n新しい夕食,1200,あおい,あおい|はる')
    expect(root.textContent).toContain('読み込み内容の確認')
    expect(app.getState()).toEqual(initialState)

    click('[data-action="close-csv"]')
    expect(app.getState()).toEqual(initialState)

    await chooseCsv('description,amount,paid_by,split_among\n新しい夕食,1200,あおい,あおい|はる')
    click('[data-action="confirm-csv"]')
    expect(app.getState().participants.map(({ name }) => name)).toEqual(['あおい', 'はる'])
    expect(app.getState().expenses[0]?.description).toBe('新しい夕食')
    expect(app.getState().roundingAssigneeId).toBe(app.getState().participants[0]?.id)
  })
})

describe('shared URL restoration', () => {
  it('共有リンクから元データを復元して計算し直す', async () => {
    const encoded = await encodeStatePayload(initialState)
    if (!encoded.success) throw new Error(encoded.message)
    const app = await mountAppFromUrl(
      root,
      { baseUrl: 'https://example.com/app' },
      `#state=${encoded.payload}`,
    )
    expect(app.getState()).toEqual(initialState)
    expect(root.textContent).toContain('既存さん')
    expect(root.textContent).toContain('250円')
  })

  it('無効なリンクでは部分復元せず、空状態から回復できる', async () => {
    const clearFragment = vi.fn()
    const app = await mountAppFromUrl(
      root,
      { onClearFragment: clearFragment },
      '#state=invalid-data',
    )
    expect(app.getState().participants).toEqual([])
    expect(qs('[role="alert"]').textContent).toContain('復元できません')
    click('[data-action="dismiss-restore"]')
    await flushUi()
    expect(clearFragment).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(qs('#participant-name'))
  })
})

describe('accessibility and responsive semantics', () => {
  it('主要入力にラベルがあり、ダイアログをEscapeで閉じて起点へ戻す', async () => {
    mountApp(root, { initialState, idFactory })
    click('[data-action="open-expense"]')
    await flushUi()

    const fields = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input:not([type="radio"]):not([type="checkbox"]), select, textarea',
    )]
    fields.forEach((field) => {
      expect(field.id).not.toBe('')
      expect(root.querySelector(`label[for="${field.id}"]`)).not.toBeNull()
    })

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushUi()
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(qs('#open-expense'))
  })

  it('日本円を桁区切りと円単位で表示する', () => {
    mountApp(root, { initialState, idFactory })
    expect(root.textContent).toContain('500円')
    expect(root.textContent).toContain('250円')
    expect(root.textContent).not.toContain('¥')
  })

})

function addParticipantThroughUi(name: string): void {
  setValue('#participant-name', name)
  submit('[data-form="add-participant"]')
}

async function chooseCsv(source: string): Promise<void> {
  click('[data-action="open-csv"]')
  const input = qs<HTMLInputElement>('#csv-file')
  const file = new File([source], 'expenses.csv', { type: 'text/csv' })
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(root.textContent).toContain('読み込み内容の確認'))
}

function setValue(selector: string, value: string): void {
  const input = qs<HTMLInputElement>(selector)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function submit(selector: string): void {
  qs<HTMLFormElement>(selector).dispatchEvent(
    new SubmitEvent('submit', { bubbles: true, cancelable: true }),
  )
}

function click(selector: string): void {
  qs<HTMLElement>(selector).click()
}

function qs<T extends Element = HTMLElement>(selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`要素が見つかりません: ${selector}`)
  return element
}

async function flushUi(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
