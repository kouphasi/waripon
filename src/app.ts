import { calculateSettlement, formatSignedYen, formatYen } from './calculate'
import {
  CSV_HEADERS,
  CSV_TEMPLATE,
  csvTemplateDataUrl,
  parseExpenseCsv,
  type CsvImportResult,
} from './csv'
import {
  addParticipant,
  createEmptyState,
  removeExpense,
  removeParticipant,
  renameParticipant,
  saveExpense,
  setRoundingAssignee,
  type CalculationStateV1,
  type IdFactory,
  type StateMutationResult,
} from './domain'
import {
  createShareUrl,
  restoreStateFromFragment,
  type ShareUrlResult,
} from './share'

interface UiMessage {
  tone: 'success' | 'error' | 'info'
  text: string
  field?: string
}

interface AppOptions {
  initialState?: CalculationStateV1
  idFactory?: IdFactory
  baseUrl?: string
  clipboard?: { writeText(value: string): Promise<void> } | null
  restoreProblem?: string | null
  onClearFragment?: () => void
}

export class WariponApp {
  private state: CalculationStateV1
  private readonly idFactory?: IdFactory
  private message: UiMessage | null = null
  private expenseEditorId: string | null | undefined
  private csvDialogOpen = false
  private csvResult: CsvImportResult | null = null
  private csvFileName = ''
  private shareDialogOpen = false
  private shareLoading = false
  private shareResult: ShareUrlResult | null = null
  private shareCopyMessage = ''
  private restoreProblem: string | null
  private readonly baseUrl: string
  private readonly clipboard: { writeText(value: string): Promise<void> } | null
  private readonly onClearFragment: () => void

  constructor(
    private readonly root: HTMLElement,
    options: AppOptions = {},
  ) {
    this.state = options.initialState ?? createEmptyState()
    this.idFactory = options.idFactory
    this.baseUrl = options.baseUrl ?? browserUrl()
    this.clipboard = options.clipboard === undefined ? browserClipboard() : options.clipboard
    this.restoreProblem = options.restoreProblem ?? null
    this.onClearFragment = options.onClearFragment ?? clearBrowserFragment
    this.root.addEventListener('submit', this.handleSubmit)
    this.root.addEventListener('click', this.handleClick)
    this.root.addEventListener('change', this.handleChange)
    this.root.addEventListener('keydown', this.handleKeyDown)
    this.render()
  }

  getState(): CalculationStateV1 {
    return structuredClone(this.state)
  }

  private readonly handleSubmit = (event: SubmitEvent): void => {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    event.preventDefault()
    const data = new FormData(form)

    if (form.dataset.form === 'add-participant') {
      const result = addParticipant(this.state, String(data.get('name') ?? ''), this.idFactory)
      this.applyMutation(result, '参加者を追加しました。')
      return
    }

    if (form.dataset.form === 'rename-participant') {
      const participantId = form.dataset.participantId
      if (!participantId) return
      const result = renameParticipant(this.state, participantId, String(data.get('name') ?? ''))
      this.applyMutation(result, '名前を変更しました。')
      return
    }

    if (form.dataset.form === 'expense') {
      const rawAmount = String(data.get('amount') ?? '').trim()
      const amount = /^\d+$/.test(rawAmount) ? Number(rawAmount) : Number.NaN
      const editing = typeof this.expenseEditorId === 'string'
      const result = saveExpense(
        this.state,
        {
          description: String(data.get('description') ?? ''),
          amount,
          payerId: String(data.get('payerId') ?? ''),
          burdenParticipantIds: data.getAll('burdenParticipantIds').map(String),
        },
        this.expenseEditorId ?? undefined,
        this.idFactory,
      )
      if (result.ok) this.expenseEditorId = undefined
      this.applyMutation(result, editing ? '支払いを変更しました。' : '支払いを保存しました。')
    }
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLButtonElement>('[data-action]')
    if (!button) return
    const action = button.dataset.action

    if (action === 'delete-participant' && button.dataset.participantId) {
      const participant = this.state.participants.find(({ id }) => id === button.dataset.participantId)
      if (!participant) return
      const result = removeParticipant(this.state, participant.id)
      this.applyMutation(result, `${participant.name}さんを削除しました。`)
      return
    }

    if (action === 'open-expense') {
      this.expenseEditorId = null
      this.message = null
      this.renderAndFocus('expense-description')
      return
    }

    if (action === 'edit-expense' && button.dataset.expenseId) {
      this.expenseEditorId = button.dataset.expenseId
      this.message = null
      this.renderAndFocus('expense-description')
      return
    }

    if (action === 'delete-expense' && button.dataset.expenseId) {
      const expense = this.state.expenses.find(({ id }) => id === button.dataset.expenseId)
      if (!expense) return
      this.applyMutation(removeExpense(this.state, expense.id), `${expense.description}を削除しました。`)
      return
    }

    if (action === 'close-expense') {
      this.expenseEditorId = undefined
      this.message = null
      this.renderAndFocus('open-expense')
      return
    }

    if (action === 'open-csv') {
      this.csvDialogOpen = true
      this.csvResult = null
      this.csvFileName = ''
      this.message = null
      this.renderAndFocus('csv-file')
      return
    }

    if (action === 'close-csv') {
      this.csvDialogOpen = false
      this.csvResult = null
      this.csvFileName = ''
      this.renderAndFocus('open-csv')
      return
    }

    if (action === 'confirm-csv' && this.csvResult?.success) {
      this.state = this.csvResult.candidate
      this.csvDialogOpen = false
      this.csvResult = null
      this.message = { tone: 'success', text: 'CSVの参加者と支払いに置き換えました。' }
      this.render()
      return
    }

    if (action === 'open-share') {
      this.shareDialogOpen = true
      this.shareLoading = true
      this.shareResult = null
      this.shareCopyMessage = ''
      this.render()
      void this.prepareShareUrl()
      return
    }

    if (action === 'close-share') {
      this.shareDialogOpen = false
      this.shareResult = null
      this.shareCopyMessage = ''
      this.renderAndFocus('open-share')
      return
    }

    if (action === 'copy-share') {
      void this.copyShareUrl()
      return
    }

    if (action === 'dismiss-restore') {
      this.restoreProblem = null
      this.onClearFragment()
      this.message = { tone: 'info', text: '空の計算から始めます。' }
      this.renderAndFocus('participant-name')
    }
  }

  private readonly handleChange = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    if (target.name === 'csvFile') {
      const file = target.files?.[0]
      if (file) void this.loadCsvFile(file)
      return
    }
    if (target.name === 'roundingAssigneeId' && target.checked) {
      const participant = this.state.participants.find(({ id }) => id === target.value)
      this.applyMutation(
        setRoundingAssignee(this.state, target.value),
        participant ? `端数調整担当を${participant.name}さんに変更しました。` : '',
      )
    }
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (this.expenseEditorId !== undefined) {
        event.preventDefault()
        this.expenseEditorId = undefined
        this.message = null
        this.renderAndFocus('open-expense')
      } else if (this.csvDialogOpen) {
        event.preventDefault()
        this.csvDialogOpen = false
        this.csvResult = null
        this.renderAndFocus('open-csv')
      } else if (this.shareDialogOpen) {
        event.preventDefault()
        this.shareDialogOpen = false
        this.shareResult = null
        this.renderAndFocus('open-share')
      }
      return
    }

    if (event.key !== 'Tab') return
    const dialog = this.root.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )]
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  private async loadCsvFile(file: File): Promise<void> {
    this.csvFileName = file.name
    try {
      this.csvResult = parseExpenseCsv(await file.text(), this.idFactory)
    } catch {
      this.csvResult = {
        success: false,
        errors: [{ line: null, message: 'ファイルを読み取れませんでした。' }],
      }
    }
    this.render()
    queueMicrotask(() =>
      this.root
        .querySelector<HTMLElement>(this.csvResult?.success ? '#csv-preview-title' : '#csv-errors-title')
        ?.focus(),
    )
  }

  private async prepareShareUrl(): Promise<void> {
    this.shareResult = await createShareUrl(this.state, this.baseUrl)
    this.shareLoading = false
    if (this.shareDialogOpen) this.renderAndFocus(this.shareResult.success ? 'share-url' : 'share-error')
  }

  private async copyShareUrl(): Promise<void> {
    if (!this.shareResult?.success) return
    if (!this.clipboard) {
      this.shareCopyMessage = 'このブラウザでは自動コピーできません。URL欄を選択してコピーしてください。'
      this.renderAndFocus('share-url')
      return
    }
    try {
      await this.clipboard.writeText(this.shareResult.url)
      this.shareCopyMessage = '共有URLをコピーしました。'
    } catch {
      this.shareCopyMessage = 'コピーできませんでした。URL欄を選択してコピーしてください。'
    }
    this.renderAndFocus('share-url')
  }

  private applyMutation(result: StateMutationResult, successMessage: string): void {
    if (result.ok) {
      this.state = result.state
      this.message = successMessage ? { tone: 'success', text: successMessage } : null
      this.render()
      return
    }

    this.message = { tone: 'error', text: result.message, field: result.field }
    this.renderAndFocus(result.field)
  }

  private renderAndFocus(id?: string): void {
    this.render()
    if (id) queueMicrotask(() => this.root.querySelector<HTMLElement>(`#${cssEscape(id)}`)?.focus())
  }

  private render(): void {
    this.root.innerHTML = `
      <a class="skip-link" href="#main-content">本文へ移動</a>
      <header class="site-header">
        <div class="site-header__inner">
          <a class="brand" href="/" aria-label="わりぽん ホーム">
            <span class="brand__mark" aria-hidden="true">割</span>
            <span><strong>わりぽん</strong><small>登録なしのかんたん割り勘</small></span>
          </a>
          <span class="privacy-chip">データはこの端末だけ</span>
        </div>
      </header>
      <main class="app-layout" id="main-content">
        <section class="hero" aria-labelledby="page-title">
          <p class="eyebrow">みんなの支払いを、すっきり一本化</p>
          <h1 id="page-title">誰が誰に、いくら払う？</h1>
          <p>参加者と支払いを入力すると、必要な送金額を円単位で計算します。</p>
        </section>
        ${this.renderRestoreProblem()}
        ${this.renderMessage()}
        <div class="workspace-grid">
          <div class="workspace-main">
            ${this.renderParticipants()}
            ${this.renderExpenses()}
            ${this.renderCsvPanel()}
            ${this.renderSharePanel()}
          </div>
          <aside class="workspace-side">
            ${this.renderResults()}
          </aside>
        </div>
      </main>
      <footer class="site-footer">わりぽんは入力データをサーバーへ保存しません。</footer>
      ${this.expenseEditorId !== undefined ? this.renderExpenseDialog() : ''}
      ${this.csvDialogOpen ? this.renderCsvDialog() : ''}
      ${this.shareDialogOpen ? this.renderShareDialog() : ''}
    `
  }

  private renderMessage(): string {
    if (!this.message) return '<div class="live-region" aria-live="polite"></div>'
    const error = this.message.tone === 'error'
    return `
      <div class="notice ${error ? 'notice--error' : ''}" role="${error ? 'alert' : 'status'}">
        <span aria-hidden="true">${error ? '!' : '✓'}</span>
        <p>${escapeHtml(this.message.text)}</p>
      </div>
    `
  }

  private renderRestoreProblem(): string {
    if (!this.restoreProblem) return ''
    return `
      <div class="notice notice--error restore-notice" role="alert">
        <span aria-hidden="true">!</span>
        <div>
          <strong>共有リンクを復元できませんでした</strong>
          <p>${escapeHtml(this.restoreProblem)}</p>
          <button class="button button--danger button--small" type="button" data-action="dismiss-restore">空の計算から始める</button>
        </div>
      </div>
    `
  }

  private renderParticipants(): string {
    const content =
      this.state.participants.length === 0
        ? '<p class="empty-state">参加者はまだいません。</p>'
        : `
          <fieldset class="participant-fieldset">
            <legend>端数調整担当者を1人選択</legend>
            <p class="field-help">割り切れない端数は、選択した人がまとめて調整します。</p>
            <div class="participant-list">
              ${this.state.participants.map((participant) => this.renderParticipant(participant.id)).join('')}
            </div>
          </fieldset>
        `

    return `
      <section class="panel" aria-labelledby="participants-title">
        <div class="section-heading">
          <div><span class="step">1</span><h2 id="participants-title">参加者</h2></div>
          <span class="tag">${this.state.participants.length}人</span>
        </div>
        <form class="inline-form" data-form="add-participant" novalidate>
          <div class="field field--grow">
            <label for="participant-name">名前</label>
            <input
              id="participant-name"
              name="name"
              placeholder="例：あおい"
              autocomplete="off"
              ${this.message?.field === 'participant-name' ? 'aria-invalid="true" aria-describedby="participant-error"' : ''}
            />
            ${this.renderFieldError('participant-name', 'participant-error')}
          </div>
          <button class="button button--primary" type="submit">追加する</button>
        </form>
        ${content}
      </section>
    `
  }

  private renderParticipant(participantId: string): string {
    const participant = this.state.participants.find(({ id }) => id === participantId)
    if (!participant) return ''
    const inputId = `participant-name-${participant.id}`
    const errorId = `participant-error-${participant.id}`
    return `
      <div class="participant-row">
        <label class="rounding-choice" title="端数調整担当にする">
          <input
            type="radio"
            name="roundingAssigneeId"
            value="${escapeAttribute(participant.id)}"
            ${this.state.roundingAssigneeId === participant.id ? 'checked' : ''}
          />
          <span>端数担当</span>
        </label>
        <form class="participant-name-form" data-form="rename-participant" data-participant-id="${escapeAttribute(participant.id)}">
          <label class="sr-only" for="${escapeAttribute(inputId)}">${escapeHtml(participant.name)}さんの名前</label>
          <input
            id="${escapeAttribute(inputId)}"
            name="name"
            value="${escapeAttribute(participant.name)}"
            autocomplete="off"
            ${this.message?.field === inputId ? `aria-invalid="true" aria-describedby="${escapeAttribute(errorId)}"` : ''}
          />
          <button class="button button--secondary button--small" type="submit">変更</button>
          ${this.renderFieldError(inputId, errorId)}
        </form>
        <button
          class="button button--ghost button--small"
          type="button"
          data-action="delete-participant"
          data-participant-id="${escapeAttribute(participant.id)}"
          aria-label="${escapeAttribute(participant.name)}さんを削除"
        >削除</button>
      </div>
    `
  }

  private renderExpenses(): string {
    const participantNames = new Map(this.state.participants.map(({ id, name }) => [id, name]))
    const content =
      this.state.expenses.length === 0
        ? `<p class="empty-state">${this.state.participants.length ? '「支払いを追加」から記録を始めましょう。' : '参加者を追加すると、支払いを記録できます。'}</p>`
        : `
          <div class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>内容</th><th>支払者</th><th>負担者</th><th class="money">金額</th><th><span class="sr-only">操作</span></th></tr></thead>
              <tbody>
                ${this.state.expenses
                  .map(
                    (expense) => `
                      <tr>
                        <td>${escapeHtml(expense.description)}</td>
                        <td>${escapeHtml(participantNames.get(expense.payerId) ?? '不明')}</td>
                        <td>${escapeHtml(expense.burdenParticipantIds.map((id) => participantNames.get(id) ?? '不明').join('、'))}</td>
                        <td class="money">${formatYen(BigInt(expense.amount))}</td>
                        <td><div class="actions">
                          <button class="button button--secondary button--small" type="button" data-action="edit-expense" data-expense-id="${escapeAttribute(expense.id)}">編集</button>
                          <button class="button button--ghost button--small" type="button" data-action="delete-expense" data-expense-id="${escapeAttribute(expense.id)}">削除</button>
                        </div></td>
                      </tr>
                    `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        `

    return `
      <section class="panel" aria-labelledby="expenses-title">
        <div class="section-heading">
          <div><span class="step">2</span><h2 id="expenses-title">支払い</h2></div>
          <button id="open-expense" class="button button--secondary" type="button" data-action="open-expense" ${this.state.participants.length === 0 ? 'disabled' : ''}>支払いを追加</button>
        </div>
        ${content}
      </section>
    `
  }

  private renderResults(): string {
    if (this.state.participants.length === 0) {
      return `
        <section class="panel panel--accent" aria-labelledby="results-title">
          <div class="section-heading"><div><span class="step">3</span><h2 id="results-title">精算結果</h2></div></div>
          <p class="empty-state">参加者を追加すると、結果がここに表示されます。</p>
        </section>
      `
    }

    const result = calculateSettlement(this.state)
    const names = new Map(this.state.participants.map(({ id, name }) => [id, name]))
    const transferContent =
      this.state.expenses.length === 0
        ? '<p class="empty-state">支払いを追加すると送金額を計算します。</p>'
        : result.transfers.length === 0
          ? '<p class="settled-message"><span aria-hidden="true">✓</span>精算済みです。送金は必要ありません。</p>'
          : `<ol class="transfer-list">${result.transfers
              .map(
                ({ fromParticipantId, toParticipantId, amount }) => `
                  <li><span><strong>${escapeHtml(names.get(fromParticipantId) ?? '不明')}</strong> から <strong>${escapeHtml(names.get(toParticipantId) ?? '不明')}</strong> へ</span><strong class="money">${formatYen(amount)}</strong></li>
                `,
              )
              .join('')}</ol>`

    return `
      <section class="panel panel--accent" aria-labelledby="results-title">
        <div class="section-heading"><div><span class="step">3</span><h2 id="results-title">精算結果</h2></div><span class="tag">合計 ${formatYen(result.totalPaid)}</span></div>
        <div class="data-table-wrap result-table-wrap">
          <table class="data-table result-table">
            <thead><tr><th>参加者</th><th class="money">支払</th><th class="money">負担</th><th class="money">差額</th></tr></thead>
            <tbody>
              ${result.participants
                .map(({ participantId, paid, assignedBurden, balance, roundingAdjustment }) => {
                  const participant = this.state.participants.find(({ id }) => id === participantId)
                  const adjustment =
                    participantId === this.state.roundingAssigneeId
                      ? `<small class="adjustment">端数調整 ${formatSignedYen(roundingAdjustment)}</small>`
                      : ''
                  return `
                    <tr>
                      <td><strong>${escapeHtml(participant?.name ?? '不明')}</strong>${adjustment}</td>
                      <td class="money">${formatYen(paid)}</td>
                      <td class="money">${formatYen(assignedBurden)}</td>
                      <td class="money ${balance > 0n ? 'money--positive' : balance < 0n ? 'money--negative' : ''}">${formatSignedYen(balance)}</td>
                    </tr>
                  `
                })
                .join('')}
            </tbody>
          </table>
        </div>
        <h3 class="subheading">送金する金額</h3>
        ${transferContent}
      </section>
    `
  }

  private renderCsvPanel(): string {
    return `
      <section class="panel utility-panel" aria-labelledby="csv-title">
        <div>
          <p class="eyebrow">まとめて入力</p>
          <h2 id="csv-title">CSVから読み込む</h2>
          <p>参加者と支払いをプレビューしてから、現在の内容を一括で置き換えます。</p>
        </div>
        <button id="open-csv" class="button button--secondary" type="button" data-action="open-csv">CSVを選ぶ</button>
      </section>
    `
  }

  private renderSharePanel(): string {
    return `
      <section class="panel utility-panel utility-panel--share" aria-labelledby="share-title">
        <div>
          <p class="eyebrow">サーバー保存なし</p>
          <h2 id="share-title">この計算をURLで共有</h2>
          <p>参加者と支払いを圧縮して、共有URLの中だけに保存します。</p>
        </div>
        <button id="open-share" class="button button--primary" type="button" data-action="open-share">共有URLを作る</button>
      </section>
    `
  }

  private renderExpenseDialog(): string {
    const expense =
      typeof this.expenseEditorId === 'string'
        ? this.state.expenses.find(({ id }) => id === this.expenseEditorId)
        : undefined
    const selectedBurdens = new Set(
      expense?.burdenParticipantIds ?? this.state.participants.map(({ id }) => id),
    )
    const payerId = expense?.payerId ?? this.state.participants[0]?.id ?? ''
    return `
      <div class="dialog-layer" role="presentation">
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="expense-dialog-title">
          <div class="dialog__heading">
            <h2 id="expense-dialog-title">${expense ? '支払いを編集' : '支払いを追加'}</h2>
            <p>金額は小数を使わず、円単位で入力してください。</p>
          </div>
          <form class="form-grid" data-form="expense" novalidate>
            <div class="field field--full">
              <label for="expense-description">内容</label>
              <input id="expense-description" name="description" value="${escapeAttribute(expense?.description ?? '')}" placeholder="例：夕食" ${this.fieldInvalidAttribute('expense-description', 'expense-description-error')} />
              ${this.renderFieldError('expense-description', 'expense-description-error')}
            </div>
            <div class="field">
              <label for="expense-amount">金額（円）</label>
              <input id="expense-amount" name="amount" type="text" inputmode="numeric" value="${expense?.amount ?? ''}" placeholder="3000" ${this.fieldInvalidAttribute('expense-amount', 'expense-amount-error')} />
              ${this.renderFieldError('expense-amount', 'expense-amount-error')}
            </div>
            <div class="field">
              <label for="expense-payer">支払った人</label>
              <select id="expense-payer" name="payerId" ${this.fieldInvalidAttribute('expense-payer', 'expense-payer-error')}>
                ${this.state.participants.map(({ id, name }) => `<option value="${escapeAttribute(id)}" ${id === payerId ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
              </select>
              ${this.renderFieldError('expense-payer', 'expense-payer-error')}
            </div>
            <fieldset class="fieldset" id="expense-burdens" ${this.message?.field === 'expense-burdens' ? 'aria-describedby="expense-burdens-error"' : ''}>
              <legend>負担する人（1人以上）</legend>
              <div class="choice-grid">
                ${this.state.participants.map(({ id, name }) => `<label class="choice"><input type="checkbox" name="burdenParticipantIds" value="${escapeAttribute(id)}" ${selectedBurdens.has(id) ? 'checked' : ''} /><span>${escapeHtml(name)}</span></label>`).join('')}
              </div>
              ${this.renderFieldError('expense-burdens', 'expense-burdens-error')}
            </fieldset>
            <div class="dialog__actions field--full">
              <button class="button button--ghost" type="button" data-action="close-expense">キャンセル</button>
              <button class="button button--primary" type="submit">${expense ? '変更を保存' : '支払いを保存'}</button>
            </div>
          </form>
        </section>
      </div>
    `
  }

  private renderCsvDialog(): string {
    const result = this.csvResult
    const resultContent = !result
      ? ''
      : result.success
        ? this.renderCsvPreview(result.candidate)
        : `
          <section class="csv-errors" aria-labelledby="csv-errors-title">
            <h3 id="csv-errors-title" tabindex="-1">読み込めない箇所があります</h3>
            <p>現在の計算内容は変更されていません。次の箇所を修正してください。</p>
            <ul>
              ${result.errors.map(({ line, message }) => `<li>${line === null ? '' : `${line}行目：`}${escapeHtml(message)}</li>`).join('')}
            </ul>
          </section>
        `
    return `
      <div class="dialog-layer" role="presentation">
        <section class="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="csv-dialog-title">
          <div class="dialog__heading">
            <h2 id="csv-dialog-title">CSVから支払いを読み込む</h2>
            <p>確認を押すまで、現在の参加者と支払いは変更されません。</p>
          </div>
          <div class="field">
            <label for="csv-file">UTF-8のCSVファイル</label>
            <input id="csv-file" name="csvFile" type="file" accept=".csv,text/csv" />
            ${this.csvFileName ? `<small class="field-help">選択中：${escapeHtml(this.csvFileName)}</small>` : ''}
          </div>
          <details class="csv-help" ${result ? '' : 'open'}>
            <summary>CSV形式とテンプレート</summary>
            <p>必須ヘッダーは <code>${CSV_HEADERS.join(', ')}</code> です。<code>split_among</code> は名前を <code>|</code> で区切ります。</p>
            <pre><code>${escapeHtml(CSV_TEMPLATE.trim())}</code></pre>
            <a class="button button--secondary button--small" href="${csvTemplateDataUrl()}" download="waripon-template.csv">テンプレートをダウンロード</a>
          </details>
          ${resultContent}
          <div class="dialog__actions">
            <button class="button button--ghost" type="button" data-action="close-csv">キャンセル</button>
            ${result?.success ? '<button class="button button--primary" type="button" data-action="confirm-csv">この内容に置き換える</button>' : ''}
          </div>
        </section>
      </div>
    `
  }

  private renderCsvPreview(candidate: CalculationStateV1): string {
    const names = new Map(candidate.participants.map(({ id, name }) => [id, name]))
    return `
      <section class="csv-preview" aria-labelledby="csv-preview-title">
        <h3 id="csv-preview-title" tabindex="-1">読み込み内容の確認</h3>
        <p><strong>${candidate.participants.length}人</strong>、<strong>${candidate.expenses.length}件</strong>の支払いを読み込みます。端数担当は${escapeHtml(candidate.participants[0]?.name ?? 'なし')}さんです。</p>
        <div class="preview-participants" aria-label="参加者">${candidate.participants.map(({ name }) => `<span class="tag">${escapeHtml(name)}</span>`).join('')}</div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>内容</th><th>支払者</th><th>負担者</th><th class="money">金額</th></tr></thead>
            <tbody>${candidate.expenses
              .map(
                (expense) => `<tr><td>${escapeHtml(expense.description)}</td><td>${escapeHtml(names.get(expense.payerId) ?? '')}</td><td>${escapeHtml(expense.burdenParticipantIds.map((id) => names.get(id) ?? '').join('、'))}</td><td class="money">${formatYen(BigInt(expense.amount))}</td></tr>`,
              )
              .join('')}</tbody>
          </table>
        </div>
      </section>
    `
  }

  private renderShareDialog(): string {
    const resultContent = this.shareLoading
      ? '<p class="loading-message" role="status">共有URLを作成しています…</p>'
      : this.shareResult?.success
        ? `
          <div class="field">
            <label for="share-url">共有URL（${this.shareResult.url.length.toLocaleString('ja-JP')}文字）</label>
            <textarea id="share-url" class="copy-field" rows="4" readonly>${escapeHtml(this.shareResult.url)}</textarea>
          </div>
          <div class="copy-actions">
            <button class="button button--primary" type="button" data-action="copy-share">URLをコピー</button>
          </div>
          ${this.shareCopyMessage ? `<p class="copy-message" role="status">${escapeHtml(this.shareCopyMessage)}</p>` : ''}
        `
        : `
          <div id="share-error" class="notice notice--error" role="alert" tabindex="-1">
            <span aria-hidden="true">!</span>
            <p>${escapeHtml(this.shareResult?.message ?? '共有URLを作成できませんでした。')}</p>
          </div>
        `
    return `
      <div class="dialog-layer" role="presentation">
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
          <div class="dialog__heading">
            <h2 id="share-dialog-title">計算をURLで共有</h2>
            <p>URLを開くだけで、同じ参加者・支払い・端数担当を復元できます。</p>
          </div>
          <div class="privacy-warning">
            <strong>共有前にご確認ください</strong>
            <p>このURLを知っている人は、参加者名と支払い内容を読めます。URLはブラウザ履歴やメッセージに残るため、機密情報には使用しないでください。</p>
          </div>
          ${resultContent}
          <div class="dialog__actions">
            <button class="button button--ghost" type="button" data-action="close-share">閉じる</button>
          </div>
        </section>
      </div>
    `
  }

  private renderFieldError(field: string, errorId: string): string {
    return this.message?.tone === 'error' && this.message.field === field
      ? `<p class="validation-message" id="${escapeAttribute(errorId)}">${escapeHtml(this.message.text)}</p>`
      : ''
  }

  private fieldInvalidAttribute(field: string, errorId: string): string {
    return this.message?.tone === 'error' && this.message.field === field
      ? `aria-invalid="true" aria-describedby="${escapeAttribute(errorId)}"`
      : ''
  }
}

export function mountApp(root: HTMLElement, options: AppOptions = {}): WariponApp {
  return new WariponApp(root, options)
}

export async function mountAppFromUrl(
  root: HTMLElement,
  options: AppOptions = {},
  fragment = typeof location === 'undefined' ? '' : location.hash,
): Promise<WariponApp> {
  root.innerHTML = '<p class="app-loading" role="status">共有データを確認しています…</p>'
  const restored = await restoreStateFromFragment(fragment)
  if (restored.status === 'success') {
    return mountApp(root, { ...options, initialState: restored.state })
  }
  if (restored.status === 'none') return mountApp(root, options)
  return mountApp(root, {
    ...options,
    initialState: createEmptyState(),
    restoreProblem: restored.message,
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replaceAll(/[^a-zA-Z0-9_-]/g, '\\$&')
}

function browserUrl(): string {
  return typeof location === 'undefined' ? 'https://waripon.local/' : location.href
}

function browserClipboard(): { writeText(value: string): Promise<void> } | null {
  return typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null
}

function clearBrowserFragment(): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return
  history.replaceState(null, '', `${location.pathname}${location.search}`)
}
