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
  type Expense,
  type IdFactory,
  type Participant,
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

export type TabId = 'settlement' | 'expenses' | 'participants'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'settlement', label: '精算' },
  { id: 'expenses', label: '支払い' },
  { id: 'participants', label: '参加者' },
]

const AVATAR_CLASS_COUNT = 5

function avatarClassIndex(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  }
  return hash % AVATAR_CLASS_COUNT
}

function renderAvatarSpan(name: string, id: string, extraClass = ''): string {
  const initial = [...name][0] ?? '?'
  return `<span class="avatar ${extraClass} avatar--${avatarClassIndex(id)}" aria-hidden="true">${escapeHtml(initial)}</span>`
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
  private activeTab: TabId = 'settlement'
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

    if (action === 'switch-tab') {
      const tab = TABS.find(({ id }) => id === button.dataset.tab)
      if (tab) {
        this.activeTab = tab.id
        this.message = null
        this.render()
      }
      return
    }

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
      this.activeTab = 'participants'
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
            <strong>わりぽん</strong>
          </a>
          ${this.renderTabNav('tab-nav', 'tab-nav__button')}
          <button id="open-share" class="button button--glass" type="button" data-action="open-share">共有URLを作る</button>
        </div>
      </header>
      <main class="app-layout" id="main-content">
        ${this.renderRestoreProblem()}
        ${this.renderMessage()}
        ${this.renderActiveTab()}
      </main>
      ${this.renderTabNav('tab-dock', 'tab-dock__button')}
      <footer class="site-footer">わりぽんは入力データをサーバーへ保存しません。</footer>
      ${this.expenseEditorId !== undefined ? this.renderExpenseDialog() : ''}
      ${this.csvDialogOpen ? this.renderCsvDialog() : ''}
      ${this.shareDialogOpen ? this.renderShareDialog() : ''}
    `
  }

  private renderTabNav(navClass: string, buttonClass: string): string {
    return `
      <nav class="${navClass}" aria-label="画面切り替え">
        ${TABS.map(
          (tab) => `
            <button
              class="${buttonClass}"
              type="button"
              data-action="switch-tab"
              data-tab="${tab.id}"
              ${this.activeTab === tab.id ? 'aria-current="page"' : ''}
            >${tab.label}</button>
          `,
        ).join('')}
      </nav>
    `
  }

  private renderActiveTab(): string {
    if (this.activeTab === 'expenses') return this.renderExpensesTab()
    if (this.activeTab === 'participants') return this.renderParticipantsTab()
    return this.renderSettlementTab()
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

  private renderParticipantsTab(): string {
    const content =
      this.state.participants.length === 0
        ? '<p class="empty-state">参加者はまだいません。</p>'
        : `
          <fieldset class="participant-fieldset">
            <legend>端数調整担当者を1人選択</legend>
            <p class="field-help">割り切れない端数は、選択した人がまとめて調整します。</p>
            <div class="participant-list">
              ${this.state.participants.map((participant) => this.renderParticipant(participant)).join('')}
            </div>
          </fieldset>
        `

    return `
      <section class="panel-glass" aria-labelledby="participants-title">
        <div class="section-heading">
          <h2 id="participants-title">参加者</h2>
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

  private renderParticipant(participant: Participant): string {
    const inputId = `participant-name-${participant.id}`
    const errorId = `participant-error-${participant.id}`
    return `
      <div class="participant-row">
        <div class="participant-row__lead">
          ${renderAvatarSpan(participant.name, participant.id, 'avatar--sm')}
          <label class="rounding-choice" title="端数調整担当にする">
            <input
              type="radio"
              name="roundingAssigneeId"
              value="${escapeAttribute(participant.id)}"
              ${this.state.roundingAssigneeId === participant.id ? 'checked' : ''}
            />
            <span>端数担当</span>
          </label>
        </div>
        <form class="participant-name-form" data-form="rename-participant" data-participant-id="${escapeAttribute(participant.id)}">
          <label class="sr-only" for="${escapeAttribute(inputId)}">${escapeHtml(participant.name)}さんの名前</label>
          <input
            id="${escapeAttribute(inputId)}"
            name="name"
            value="${escapeAttribute(participant.name)}"
            autocomplete="off"
            ${this.fieldInvalidAttribute(inputId, errorId)}
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

  private renderExpensesTab(): string {
    const names = this.participantNames()
    const emptyText = this.state.participants.length
      ? '「支払いを追加」から記録を始めましょう。'
      : '参加者を追加すると、支払いを記録できます。'
    return `
      <section class="panel-glass" aria-labelledby="expenses-title">
        <div class="section-heading">
          <h2 id="expenses-title">支払い</h2>
          <span class="tag">${this.state.expenses.length}件</span>
        </div>
        ${this.renderExpenseList(emptyText, (expense) =>
          this.renderExpenseRow(
            expense,
            names,
            `${escapeHtml(nameOf(names, expense.payerId))}が支払い・${escapeHtml(expense.burdenParticipantIds.map((id) => nameOf(names, id)).join('、'))}で負担`,
            `
              <div class="actions">
                <button class="button button--secondary button--small" type="button" data-action="edit-expense" data-expense-id="${escapeAttribute(expense.id)}">編集</button>
                <button class="button button--ghost button--small" type="button" data-action="delete-expense" data-expense-id="${escapeAttribute(expense.id)}">削除</button>
              </div>
            `,
          ),
        )}
        ${this.renderAddExpenseButton()}
        ${renderCsvRow()}
      </section>
    `
  }

  private renderExpenseList(emptyText: string, renderRow: (expense: Expense) => string): string {
    if (this.state.expenses.length === 0) return `<p class="empty-state">${emptyText}</p>`
    return `<ul class="expense-list">${this.state.expenses.map(renderRow).join('')}</ul>`
  }

  private renderExpenseRow(expense: Expense, names: Map<string, string>, meta: string, actions = ''): string {
    return `
      <li class="expense-row">
        ${renderAvatarSpan(nameOf(names, expense.payerId), expense.payerId, 'avatar--sm')}
        <span class="expense-row__body">
          <strong>${escapeHtml(expense.description)}</strong>
          <small class="expense-row__meta">${meta}</small>
        </span>
        <span class="expense-row__trailing">
          <strong class="money">${formatYen(BigInt(expense.amount))}</strong>
          ${actions}
        </span>
      </li>
    `
  }

  private renderAddExpenseButton(): string {
    return `<button id="open-expense" class="button button--primary button--block" type="button" data-action="open-expense" ${this.state.participants.length === 0 ? 'disabled' : ''}>＋ 支払いを追加</button>`
  }

  private participantNames(): Map<string, string> {
    return new Map(this.state.participants.map(({ id, name }) => [id, name]))
  }

  private renderSettlementTab(): string {
    if (this.state.participants.length === 0) {
      return `
        <section class="panel-glass" aria-labelledby="settlement-title">
          <span class="eyebrow" id="settlement-title">SETTLEMENT</span>
          <p class="empty-state">参加者を追加すると、結果がここに表示されます。</p>
        </section>
      `
    }

    const result = calculateSettlement(this.state)
    const names = this.participantNames()
    const roundingName = this.state.roundingAssigneeId ? names.get(this.state.roundingAssigneeId) : undefined

    const transferContent =
      this.state.expenses.length === 0
        ? '<p class="empty-state">支払いを追加すると送金額を計算します。</p>'
        : result.transfers.length === 0
          ? '<p class="settled-message"><span aria-hidden="true">✓</span>精算済みです。送金は必要ありません。</p>'
          : `
            <ol class="transfer-list">
              ${result.transfers
                .map(
                  ({ fromParticipantId, toParticipantId, amount }) => `
                    <li class="transfer-card">
                      ${renderAvatarSpan(nameOf(names, fromParticipantId), fromParticipantId, 'avatar--lg')}
                      <div class="transfer-card__body">
                        <div class="transfer-card__label">${escapeHtml(nameOf(names, fromParticipantId))} から ${escapeHtml(nameOf(names, toParticipantId))} へ</div>
                        <div class="transfer-card__amount">${formatYen(amount)}</div>
                      </div>
                    </li>
                  `,
                )
                .join('')}
            </ol>
          `

    const balanceCards = result.participants
      .map(({ participantId, paid, assignedBurden, balance, roundingAdjustment }) => {
        const adjustment =
          participantId === this.state.roundingAssigneeId
            ? `<small class="balance-card__adjustment">端数調整 ${formatSignedYen(roundingAdjustment)}</small>`
            : ''
        const balanceClass = balance > 0n ? 'money--positive' : balance < 0n ? 'money--negative' : ''
        return `
          <div class="balance-card">
            <div class="balance-card__name">${escapeHtml(nameOf(names, participantId))}${adjustment}</div>
            <div class="balance-card__amount ${balanceClass}">${formatSignedYen(balance)}</div>
            <div class="balance-card__detail">支払 ${formatYen(paid)} / 負担 ${formatYen(assignedBurden)}</div>
          </div>
        `
      })
      .join('')

    return `
      <div class="settlement-grid">
        <div>
          <div class="summary-line">
            <span class="eyebrow" id="settlement-title">SETTLEMENT</span>
            <span class="summary-line__total">合計 ${formatYen(result.totalPaid)} ／ ${this.state.participants.length}人${roundingName ? ` ／ 端数調整 ${escapeHtml(roundingName)}` : ''}</span>
          </div>
          ${transferContent}
          <div class="balance-grid">${balanceCards}</div>
        </div>
        ${this.renderExpensesPreviewPanel(names, roundingName)}
      </div>
    `
  }

  private renderExpensesPreviewPanel(names: Map<string, string>, roundingName: string | undefined): string {
    return `
      <div class="panel-glass">
        <div class="section-heading">
          <h2>支払い</h2>
          <span class="tag">${this.state.expenses.length}件</span>
        </div>
        ${this.renderExpenseList('「支払いを追加」から記録を始めましょう。', (expense) =>
          this.renderExpenseRow(expense, names, `${expense.burdenParticipantIds.length}人で負担`),
        )}
        ${this.renderAddExpenseButton()}
        <div class="participants-footer">
          <div><strong>参加者 ${this.state.participants.length}人</strong><div class="participants-footer__note">端数調整：${escapeHtml(roundingName ?? 'なし')}</div></div>
          <div class="avatar-stack">${this.state.participants.map((participant) => renderAvatarSpan(participant.name, participant.id, 'avatar--sm avatar--round')).join('')}</div>
        </div>
        ${renderCsvRow()}
      </div>
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

function nameOf(names: Map<string, string>, participantId: string): string {
  return names.get(participantId) ?? '不明'
}

function renderCsvRow(): string {
  return `
    <button id="open-csv" class="csv-row" type="button" data-action="open-csv">
      <span class="csv-row__label">CSVからまとめて読み込む</span>
      <span class="csv-row__action">選ぶ</span>
    </button>
  `
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
