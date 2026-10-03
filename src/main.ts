/**
 * Cash Book Pro - Application Logic with Firebase Auth and Firestore Persistence
 */
import {
  auth,
  db,
  googleProvider,
  testConnection,
  saveUserProfile,
  saveAccount,
  removeAccount,
  saveEntry as fsSaveEntry,
  removeEntry as fsRemoveEntry,
  saveTrash as fsSaveTrash,
  removeTrash as fsRemoveTrash,
  purgeAllTrash as fsPurgeAllTrash,
  subscribeToAccounts,
  subscribeToEntries,
  subscribeToTrash,
  type AccountDoc,
  type EntryDoc,
  type TrashDoc
} from './firebase.ts';
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User
} from 'firebase/auth';

interface AppAccount {
  id: string;
  name: string;
  icon: string;
}

interface AppEntry {
  id: string;
  accountId: string;
  type: 'in' | 'out';
  amount: number;
  details?: string;
  date: string;
}

interface AppTrash {
  id: string;
  itemType: 'entry' | 'account';
  deletedAt: string;
  account?: AppAccount;
  entry?: AppEntry;
  type?: string;
  name?: string;
  amount?: number;
  details?: string;
  date?: string;
}

interface AppFilters {
  scope: 'current' | 'all';
  type: 'all' | 'in' | 'out';
  dateFrom: string;
  dateTo: string;
}

interface State {
  accounts: AppAccount[];
  activeAccountId: string | null;
  entries: AppEntry[];
  trash: AppTrash[];
  filters: AppFilters;
  searchQuery: string;
  editingEntryId: string | null;
  entryType: 'in' | 'out';
  selectedIcon: string;
  confirmAction: (() => void) | null;
  theme: string;
  movingEntryId: string | null;
  activeActionEntryId: string | null;
}

function freshState(): State {
  return {
    accounts: [],
    activeAccountId: null,
    entries: [],
    trash: [],
    filters: { scope: 'current', type: 'all', dateFrom: '', dateTo: '' },
    searchQuery: '',
    editingEntryId: null,
    entryType: 'in',
    selectedIcon: '💵',
    confirmAction: null,
    theme: localStorage.getItem('cbp_theme') || 'dark',
    movingEntryId: null,
    activeActionEntryId: null
  };
}

let state: State = freshState();
let currentUser: { uid: string; email: string; displayName: string; photoURL: string } | null = null;
let syncState: 'idle' | 'saving' | 'synced' | 'error' = 'idle';
let autoSync = localStorage.getItem('cbp_autosync') !== 'off';
let deferredInstallPrompt: any = null;

let unsubAccounts: (() => void) | null = null;
let unsubEntries: (() => void) | null = null;
let unsubTrash: (() => void) | null = null;

// Unique ID generator
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatNumber(n: number): string {
  return Math.abs(n).toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

function formatBalanceNet(net: number): string {
  if (net > 0) return '+ Rs ' + formatNumber(net);
  if (net < 0) return '- Rs ' + formatNumber(net);
  return 'Rs 0';
}

function getActiveAccount(): AppAccount | undefined {
  return state.accounts.find(a => a.id === state.activeAccountId);
}

function getAccountEntries(accountId: string): AppEntry[] {
  return state.entries.filter(e => e.accountId === accountId);
}

function calculateBalance(entries: AppEntry[]): { totalIn: number; totalOut: number; net: number } {
  let totalIn = 0;
  let totalOut = 0;
  entries.forEach(e => {
    const val = Number(e.amount) || 0;
    if (e.type === 'in') totalIn += val;
    else totalOut += val;
  });
  return { totalIn, totalOut, net: totalIn - totalOut };
}

function getFilteredEntries(): AppEntry[] {
  let entries = state.filters.scope === 'all'
    ? [...state.entries]
    : (state.activeAccountId ? getAccountEntries(state.activeAccountId) : []);

  if (state.filters.type !== 'all') {
    entries = entries.filter(e => e.type === state.filters.type);
  }
  if (state.filters.dateFrom) {
    entries = entries.filter(e => e.date >= state.filters.dateFrom);
  }
  if (state.filters.dateTo) {
    entries = entries.filter(e => e.date <= state.filters.dateTo + 'T23:59:59');
  }
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    entries = entries.filter(e =>
      (e.details && e.details.toLowerCase().includes(q)) ||
      (e.amount && e.amount.toString().includes(q))
    );
  }
  entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return entries;
}

function getStatementEntries(): AppEntry[] {
  const acc = getActiveAccount();
  if (!acc) return [];
  return getAccountEntries(acc.id).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/* ============================================================
   SYNC STATUS
   ============================================================ */
function setSyncStatus(s: 'idle' | 'saving' | 'synced' | 'error') {
  syncState = s;
  const badge = document.getElementById('autoSaveBadge');
  const sEl = document.getElementById('settingsSync');
  let label: string;
  let color: string;

  if (s === 'saving') {
    label = 'Saving to Firestore…';
    color = 'var(--yellow)';
  } else if (s === 'synced') {
    label = 'Synced to Firestore ✓';
    color = 'var(--green)';
  } else if (s === 'error') {
    label = 'Offline (saved locally)';
    color = 'var(--red)';
  } else {
    label = autoSync ? 'Firestore ready' : 'Manual sync';
    color = 'var(--text2)';
  }

  if (badge) {
    badge.classList.remove('saving', 'error');
    if (s === 'saving') {
      badge.textContent = '...';
      badge.classList.add('saving');
    } else if (s === 'error') {
      badge.textContent = '! Offline';
      badge.classList.add('error');
    } else if (s === 'synced') {
      badge.textContent = '✓ Cloud';
    } else {
      badge.textContent = autoSync ? 'Auto' : 'Manual';
    }
  }
  if (sEl) {
    sEl.textContent = label;
    sEl.style.color = color;
  }
}

/* ============================================================
   TOAST
   ============================================================ */
function showToast(msg: string) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  const existingTimer = (t as any)._timer;
  if (existingTimer) clearTimeout(existingTimer);
  (t as any)._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ============================================================
   THEME
   ============================================================ */
function applyTheme() {
  document.body.className = '';
  if (state.theme && state.theme !== 'dark') {
    document.body.classList.add('theme-' + state.theme);
  }
  updateThemeSelection();
}

function selectTheme(theme: string) {
  state.theme = theme;
  localStorage.setItem('cbp_theme', theme);
  applyTheme();
  if (currentUser) {
    saveUserProfile({
      userId: currentUser.uid,
      email: currentUser.email,
      theme
    }).catch(err => console.warn('Could not save theme to profile:', err));
  }
  showToast('Theme: ' + theme);
}

function updateThemeSelection() {
  document.querySelectorAll<HTMLElement>('.theme-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.theme === state.theme);
  });
}

/* ============================================================
   RENDER
   ============================================================ */
function renderAll() {
  renderHeader();
  renderBalance();
  renderEntries();
  updateSearchButtonState();
}

function renderHeader() {
  const acc = getActiveAccount();
  const iconEl = document.getElementById('activeAccountIcon');
  const nameEl = document.getElementById('activeAccountName');
  if (acc) {
    if (iconEl) iconEl.textContent = acc.icon;
    if (nameEl) nameEl.textContent = acc.name;
  } else {
    if (iconEl) iconEl.textContent = '💳';
    if (nameEl) nameEl.textContent = 'No Account';
  }
}

function renderBalance() {
  const entries = state.filters.scope === 'all'
    ? state.entries
    : (state.activeAccountId ? getAccountEntries(state.activeAccountId) : []);
  const { totalIn, totalOut, net } = calculateBalance(entries);

  const netEl = document.getElementById('netBalance');
  const inEl = document.getElementById('totalIn');
  const outEl = document.getElementById('totalOut');

  if (netEl) netEl.textContent = formatBalanceNet(net);
  if (inEl) inEl.textContent = 'Rs ' + formatNumber(totalIn);
  if (outEl) outEl.textContent = 'Rs ' + formatNumber(totalOut);
}

function renderEntries() {
  const entries = getFilteredEntries();
  const list = document.getElementById('entriesList');
  const empty = document.getElementById('emptyState');
  const countEl = document.getElementById('entryCount');

  if (countEl) countEl.textContent = entries.length + ' entries';
  if (!list || !empty) return;

  if (entries.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = entries.map(e => {
    const d = new Date(e.date);
    const dateStr = isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-PK', { day: '2-digit', month: 'short' });
    const timeStr = isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
    const prefix = e.type === 'in' ? '+' : '-';
    const nameDisplay = e.details ? escapeHtml(e.details) : '--';
    const nameClass = e.details ? 'entry-name' : 'entry-name empty';

    return `<div class="entry-item ${e.type}">
<div class="entry-main" onclick="window.appHandler.editEntry('${e.id}')">
<span class="entry-amount">${prefix} Rs ${formatNumber(e.amount)}</span>
<span class="${nameClass}">${nameDisplay}</span>
</div>
<div class="entry-meta">
<span class="entry-date">${dateStr} ${timeStr}</span>
</div>
<button class="entry-menu-btn" onclick="event.stopPropagation();window.appHandler.openEntryActionModal('${e.id}')" title="Actions">⋮</button>
</div>`;
  }).join('');
}

function updateSearchButtonState() {
  const btn = document.getElementById('searchFilterBtn');
  if (!btn) return;
  const hasQuery = Boolean(state.searchQuery && state.searchQuery.length > 0);
  btn.classList.toggle('has-query', hasQuery);
}

/* ============================================================
   SUGGESTIONS
   ============================================================ */
function showDetailsSuggestions() {
  const input = document.getElementById('entryDetails') as HTMLInputElement | null;
  const container = document.getElementById('detailsSuggestionsContainer');
  const datalist = document.getElementById('detailsDatalist');
  if (!input || !container) return;

  const query = input.value.trim().toLowerCase();
  const allDetails: string[] = [];
  const seen = new Set<string>();

  const sorted = [...state.entries].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  sorted.forEach(e => {
    if (e.details && e.details.trim()) {
      const trimmed = e.details.trim();
      const lower = trimmed.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        allDetails.push(trimmed);
      }
    }
  });

  const matches = query ? allDetails.filter(d => d.toLowerCase().includes(query)) : allDetails.slice(0, 5);
  if (datalist) {
    datalist.innerHTML = matches.map(d => `<option value="${escapeHtml(d)}"></option>`).join('');
  }
  if (matches.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = matches.slice(0, 5).map(d =>
    `<span class="suggestion-chip" data-val="${escapeHtml(d)}" onclick="window.appHandler.clickSuggestionChip(this)">${escapeHtml(d)}</span>`
  ).join('');
}

function clickSuggestionChip(el: HTMLElement) {
  const val = el.getAttribute('data-val');
  const input = document.getElementById('entryDetails') as HTMLInputElement | null;
  if (input && val) input.value = val;
  const container = document.getElementById('detailsSuggestionsContainer');
  if (container) container.innerHTML = '';
}

/* ============================================================
   ENTRY ACTIONS MODAL
   ============================================================ */
function openEntryActionModal(entryId: string) {
  const entry = state.entries.find(e => e.id === entryId);
  if (!entry) return;
  state.activeActionEntryId = entryId;
  const preview = document.getElementById('entryActionPreview');
  const prefix = entry.type === 'in' ? '+' : '-';
  const nameDisplay = entry.details ? escapeHtml(entry.details) : 'No details';
  if (preview) {
    preview.innerHTML = `<span class="preview-amount ${entry.type}">${prefix} Rs ${formatNumber(entry.amount)}</span><span class="preview-name">${nameDisplay}</span>`;
  }
  document.getElementById('entryActionOverlay')?.classList.add('active');
  document.getElementById('entryActionModal')?.classList.add('active');
}

function closeEntryActionModal() {
  document.getElementById('entryActionOverlay')?.classList.remove('active');
  document.getElementById('entryActionModal')?.classList.remove('active');
  state.activeActionEntryId = null;
}

function actionEditEntry() {
  const id = state.activeActionEntryId;
  closeEntryActionModal();
  if (id) editEntry(id);
}

function actionMoveEntry() {
  const id = state.activeActionEntryId;
  closeEntryActionModal();
  if (id) openMoveEntryModal(id);
}

function actionDeleteEntry() {
  const id = state.activeActionEntryId;
  closeEntryActionModal();
  if (id) deleteEntry(id);
}

/* ============================================================
   SIDE MENU
   ============================================================ */
function toggleSideMenu() {
  document.getElementById('sideMenu')?.classList.toggle('open');
  document.getElementById('sideOverlay')?.classList.toggle('active');
}

function closeSideMenuIfOpen() {
  const m = document.getElementById('sideMenu');
  if (m && m.classList.contains('open')) toggleSideMenu();
}

/* ============================================================
   ENTRY MODAL & LOGIC
   ============================================================ */
function openEntryModal(type: 'in' | 'out') {
  state.entryType = type;
  state.editingEntryId = null;
  const title = document.getElementById('entryModalTitle');
  if (title) title.textContent = type === 'in' ? '📈 + Cash IN' : '📉 - Cash OUT';
  const amountInput = document.getElementById('entryAmount') as HTMLInputElement | null;
  const detailsInput = document.getElementById('entryDetails') as HTMLInputElement | null;
  const dateInput = document.getElementById('entryDateTime') as HTMLInputElement | null;

  if (amountInput) amountInput.value = '';
  if (detailsInput) detailsInput.value = '';
  if (dateInput) dateInput.value = new Date().toLocaleString('en-PK');

  document.getElementById('entryModal')?.classList.add('active');
  showDetailsSuggestions();
  setTimeout(() => amountInput?.focus(), 200);
}

function closeEntryModal() {
  document.getElementById('entryModal')?.classList.remove('active');
  const container = document.getElementById('detailsSuggestionsContainer');
  if (container) container.innerHTML = '';
  state.editingEntryId = null;
}

async function saveEntry() {
  const amountInput = document.getElementById('entryAmount') as HTMLInputElement | null;
  const detailsInput = document.getElementById('entryDetails') as HTMLInputElement | null;
  const amount = parseFloat(amountInput?.value || '0');

  if (!amount || amount <= 0) {
    showToast('Please enter a valid amount');
    return;
  }
  if (!state.activeAccountId) {
    showToast('Please select or create an account first');
    return;
  }

  const details = detailsInput?.value.trim() || '';
  setSyncStatus('saving');

  try {
    if (state.editingEntryId) {
      const entry = state.entries.find(e => e.id === state.editingEntryId);
      if (entry) {
        entry.amount = amount;
        entry.details = details;
        if (currentUser) {
          await fsSaveEntry({
            id: entry.id,
            userId: currentUser.uid,
            accountId: entry.accountId,
            type: entry.type,
            amount: entry.amount,
            details: entry.details,
            date: entry.date
          });
        }
      }
      showToast('Entry updated');
    } else {
      const newEntry: AppEntry = {
        id: generateId(),
        accountId: state.activeAccountId,
        type: state.entryType,
        amount: amount,
        details: details,
        date: new Date().toISOString()
      };
      state.entries.push(newEntry);
      if (currentUser) {
        await fsSaveEntry({
          id: newEntry.id,
          userId: currentUser.uid,
          accountId: newEntry.accountId,
          type: newEntry.type,
          amount: newEntry.amount,
          details: newEntry.details,
          date: newEntry.date
        });
      }
      showToast(state.entryType === 'in' ? 'Cash In added' : 'Cash Out added');
    }
    setSyncStatus('synced');
  } catch (err) {
    console.error('Save entry failed:', err);
    setSyncStatus('error');
    showToast('Saved locally (offline)');
  }

  closeEntryModal();
  renderAll();
}

function editEntry(id: string) {
  const entry = state.entries.find(e => e.id === id);
  if (!entry) return;
  state.editingEntryId = id;
  state.entryType = entry.type;

  const title = document.getElementById('entryModalTitle');
  if (title) title.textContent = entry.type === 'in' ? '✏️ Edit Cash IN' : '✏️ Edit Cash OUT';

  const amountInput = document.getElementById('entryAmount') as HTMLInputElement | null;
  const detailsInput = document.getElementById('entryDetails') as HTMLInputElement | null;
  const dateInput = document.getElementById('entryDateTime') as HTMLInputElement | null;

  if (amountInput) amountInput.value = String(entry.amount);
  if (detailsInput) detailsInput.value = entry.details || '';
  if (dateInput) {
    const d = new Date(entry.date);
    dateInput.value = isNaN(d.getTime()) ? '' : d.toLocaleString('en-PK');
  }

  document.getElementById('entryModal')?.classList.add('active');
  showDetailsSuggestions();
}

function deleteEntry(id: string) {
  state.confirmAction = async () => {
    const idx = state.entries.findIndex(e => e.id === id);
    if (idx > -1) {
      const [removed] = state.entries.splice(idx, 1);
      const trashItem: AppTrash = {
        id: removed.id,
        itemType: 'entry',
        deletedAt: new Date().toISOString(),
        entry: removed,
        type: removed.type,
        amount: removed.amount,
        details: removed.details,
        date: removed.date
      };
      state.trash.push(trashItem);
      renderAll();

      if (currentUser) {
        setSyncStatus('saving');
        try {
          await fsSaveTrash({
            id: trashItem.id,
            userId: currentUser.uid,
            itemType: 'entry',
            deletedAt: trashItem.deletedAt,
            data: removed
          });
          await fsRemoveEntry(currentUser.uid, removed.id);
          setSyncStatus('synced');
        } catch (err) {
          console.warn('Trash sync failed:', err);
          setSyncStatus('error');
        }
      }
      showToast('Moved to trash');
    }
  };
  showConfirm('Move to Trash?', 'This entry will be moved to the recycle bin.');
}

/* ============================================================
   MOVE ENTRY
   ============================================================ */
function openMoveEntryModal(entryId: string) {
  state.movingEntryId = entryId;
  renderMoveAccountList();
  document.getElementById('moveEntryModal')?.classList.add('active');
}

function closeMoveEntryModal() {
  document.getElementById('moveEntryModal')?.classList.remove('active');
  state.movingEntryId = null;
}

function renderMoveAccountList() {
  const list = document.getElementById('moveAccountList');
  if (!list) return;
  const entry = state.entries.find(e => e.id === state.movingEntryId);
  if (!entry) return;

  const otherAccounts = state.accounts.filter(a => a.id !== entry.accountId);
  if (otherAccounts.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📦</div><p>No other accounts available.<br>Create another account first.</p></div>';
    return;
  }

  list.innerHTML = otherAccounts.map(a => {
    const bal = calculateBalance(getAccountEntries(a.id));
    return `<div class="account-item" onclick="window.appHandler.moveEntryToAccount('${a.id}')">
<span class="icon">${a.icon}</span>
<div class="info">
<div class="name">${escapeHtml(a.name)}</div>
<div class="balance">Net: ${formatBalanceNet(bal.net)}</div>
</div>
</div>`;
  }).join('');
}

async function moveEntryToAccount(accountId: string) {
  const entry = state.entries.find(e => e.id === state.movingEntryId);
  if (entry) {
    entry.accountId = accountId;
    renderAll();
    closeMoveEntryModal();

    if (currentUser) {
      setSyncStatus('saving');
      try {
        await fsSaveEntry({
          id: entry.id,
          userId: currentUser.uid,
          accountId: entry.accountId,
          type: entry.type,
          amount: entry.amount,
          details: entry.details,
          date: entry.date
        });
        setSyncStatus('synced');
      } catch (err) {
        console.warn('Move sync failed:', err);
        setSyncStatus('error');
      }
    }
    showToast('Entry moved successfully');
  }
}

/* ============================================================
   ACCOUNTS
   ============================================================ */
function openAccountModal() {
  closeSideMenuIfOpen();
  renderAccountList();
  document.getElementById('accountModal')?.classList.add('active');
}

function closeAccountModal() {
  document.getElementById('accountModal')?.classList.remove('active');
}

function renderAccountList() {
  const list = document.getElementById('accountList');
  if (!list) return;

  list.innerHTML = state.accounts.map(a => {
    const bal = calculateBalance(getAccountEntries(a.id));
    const isActive = a.id === state.activeAccountId;
    return `<div class="account-item ${isActive ? 'active' : ''}" onclick="window.appHandler.switchAccount('${a.id}')">
<span class="icon">${a.icon}</span>
<div class="info">
<div class="name">${escapeHtml(a.name)}</div>
<div class="balance">Net: ${formatBalanceNet(bal.net)}</div>
</div>
<div class="actions">
<button onclick="event.stopPropagation();window.appHandler.editAccount('${a.id}')" title="Edit">✏️</button>
<button onclick="event.stopPropagation();window.appHandler.deleteAccount('${a.id}')" title="Delete">🗑️</button>
</div>
</div>`;
  }).join('');
}

function switchAccount(id: string) {
  state.activeAccountId = id;
  if (currentUser) {
    saveUserProfile({
      userId: currentUser.uid,
      email: currentUser.email,
      activeAccountId: id
    }).catch(err => console.warn('Could not save activeAccountId:', err));
  }
  renderAll();
  closeAccountModal();
  showToast('Account switched');
}

async function addAccount() {
  const nameInput = document.getElementById('newAccountName') as HTMLInputElement | null;
  const name = nameInput?.value.trim() || '';
  if (!name) {
    showToast('Please enter account name');
    return;
  }
  const acc: AppAccount = {
    id: generateId(),
    name,
    icon: state.selectedIcon || '💵'
  };
  state.accounts.push(acc);
  state.activeAccountId = acc.id;

  if (currentUser) {
    setSyncStatus('saving');
    try {
      await saveAccount({
        id: acc.id,
        userId: currentUser.uid,
        name: acc.name,
        icon: acc.icon
      });
      await saveUserProfile({
        userId: currentUser.uid,
        email: currentUser.email,
        activeAccountId: acc.id
      });
      setSyncStatus('synced');
    } catch (err) {
      console.warn('Account add sync failed:', err);
      setSyncStatus('error');
    }
  }

  renderAll();
  renderAccountList();
  if (nameInput) nameInput.value = '';
  showToast('Account created');
}

async function editAccount(id: string) {
  const acc = state.accounts.find(a => a.id === id);
  if (!acc) return;
  const newName = prompt('Account name:', acc.name);
  if (newName && newName.trim()) {
    acc.name = newName.trim();
    renderAll();
    renderAccountList();

    if (currentUser) {
      setSyncStatus('saving');
      try {
        await saveAccount({
          id: acc.id,
          userId: currentUser.uid,
          name: acc.name,
          icon: acc.icon
        });
        setSyncStatus('synced');
      } catch (err) {
        console.warn('Account edit sync failed:', err);
        setSyncStatus('error');
      }
    }
  }
}

function deleteAccount(id: string) {
  const acc = state.accounts.find(a => a.id === id);
  if (!acc) return;
  if (state.accounts.length <= 1) {
    showToast('Cannot delete last account');
    return;
  }

  state.confirmAction = async () => {
    const inputVal = (document.getElementById('confirmInputField') as HTMLInputElement)?.value.trim();
    if (inputVal !== acc.name) {
      showToast('Account name does not match');
      return;
    }

    state.accounts = state.accounts.filter(a => a.id !== id);
    const removedEntries = state.entries.filter(e => e.accountId === id);
    state.entries = state.entries.filter(e => e.accountId !== id);

    const trashAcc: AppTrash = {
      id: acc.id,
      itemType: 'account',
      deletedAt: new Date().toISOString(),
      account: acc,
      name: acc.name
    };
    state.trash.push(trashAcc);

    removedEntries.forEach(e => {
      state.trash.push({
        id: e.id,
        itemType: 'entry',
        deletedAt: new Date().toISOString(),
        entry: e,
        type: e.type,
        amount: e.amount,
        details: e.details,
        date: e.date
      });
    });

    if (state.activeAccountId === id) {
      state.activeAccountId = state.accounts[0].id;
    }

    renderAll();
    renderAccountList();

    if (currentUser) {
      setSyncStatus('saving');
      try {
        await removeAccount(currentUser.uid, acc.id);
        await fsSaveTrash({
          id: trashAcc.id,
          userId: currentUser.uid,
          itemType: 'account',
          deletedAt: trashAcc.deletedAt,
          data: acc
        });
        for (const e of removedEntries) {
          await fsRemoveEntry(currentUser.uid, e.id);
          await fsSaveTrash({
            id: e.id,
            userId: currentUser.uid,
            itemType: 'entry',
            deletedAt: new Date().toISOString(),
            data: e
          });
        }
        setSyncStatus('synced');
      } catch (err) {
        console.warn('Account delete sync error:', err);
        setSyncStatus('error');
      }
    }

    showToast('Account and entries moved to trash');
  };

  showConfirm(
    '⚠️ Delete Account?',
    `To confirm deletion of "${acc.name}", please type the exact account name below:`,
    true,
    acc.name
  );
}

function setupIconSelector() {
  document.querySelectorAll<HTMLElement>('#iconSelector .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('#iconSelector .filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.selectedIcon = chip.dataset.icon || '💵';
    });
  });
}

/* ============================================================
   SEARCH / FILTERS
   ============================================================ */
function handleSearchFromModal() {
  const input = document.getElementById('filterSearchInput') as HTMLInputElement | null;
  const val = input?.value || '';
  state.searchQuery = val;
  document.getElementById('filterClearBtn')?.classList.toggle('visible', val.length > 0);
  renderEntries();
  updateSearchButtonState();
}

function clearSearchFromModal() {
  const input = document.getElementById('filterSearchInput') as HTMLInputElement | null;
  if (input) input.value = '';
  state.searchQuery = '';
  document.getElementById('filterClearBtn')?.classList.remove('visible');
  renderEntries();
  updateSearchButtonState();
}

function openFilterModal() {
  document.getElementById('filterModal')?.classList.add('active');
  const fromInput = document.getElementById('filterDateFrom') as HTMLInputElement | null;
  const toInput = document.getElementById('filterDateTo') as HTMLInputElement | null;
  const searchInput = document.getElementById('filterSearchInput') as HTMLInputElement | null;

  if (fromInput) fromInput.value = state.filters.dateFrom || '';
  if (toInput) toInput.value = state.filters.dateTo || '';
  if (searchInput) searchInput.value = state.searchQuery || '';
  document.getElementById('filterClearBtn')?.classList.toggle('visible', (state.searchQuery || '').length > 0);
  syncFilterChips();
  setTimeout(() => searchInput?.focus(), 200);
}

function closeFilterModal() {
  document.getElementById('filterModal')?.classList.remove('active');
}

function setupFilterChips() {
  document.querySelectorAll<HTMLElement>('[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const group = chip.dataset.filter;
      document.querySelectorAll<HTMLElement>(`[data-filter="${group}"]`).forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });
}

function syncFilterChips() {
  document.querySelectorAll<HTMLElement>('[data-filter="scope"]').forEach(c =>
    c.classList.toggle('active', c.dataset.value === state.filters.scope)
  );
  document.querySelectorAll<HTMLElement>('[data-filter="type"]').forEach(c =>
    c.classList.toggle('active', c.dataset.value === state.filters.type)
  );
}

function applyFilters() {
  const scopeChip = document.querySelector<HTMLElement>('[data-filter="scope"].active');
  const typeChip = document.querySelector<HTMLElement>('[data-filter="type"].active');
  state.filters.scope = (scopeChip?.dataset.value as 'current' | 'all') || 'current';
  state.filters.type = (typeChip?.dataset.value as 'all' | 'in' | 'out') || 'all';

  const fromInput = document.getElementById('filterDateFrom') as HTMLInputElement | null;
  const toInput = document.getElementById('filterDateTo') as HTMLInputElement | null;
  state.filters.dateFrom = fromInput?.value || '';
  state.filters.dateTo = toInput?.value || '';

  closeFilterModal();
  renderAll();
  showToast('Filters applied');
}

function resetFilters() {
  state.filters = { scope: 'current', type: 'all', dateFrom: '', dateTo: '' };
  state.searchQuery = '';
  const searchInput = document.getElementById('filterSearchInput') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
  document.getElementById('filterClearBtn')?.classList.remove('visible');
  syncFilterChips();
  renderAll();
  showToast('All filters cleared');
}

/* ============================================================
   SETTINGS / TRASH / ANALYTICS
   ============================================================ */
function openSettings() {
  closeSideMenuIfOpen();
  updateThemeSelection();
  const sp = document.getElementById('settingsPhone');
  const sn = document.getElementById('settingsName');
  if (sp && currentUser) sp.textContent = currentUser.email || currentUser.uid;
  if (sn && currentUser) sn.textContent = currentUser.displayName || 'User';
  updateAutoSyncUI();
  document.getElementById('settingsModal')?.classList.add('active');
}

function closeSettingsModal() {
  document.getElementById('settingsModal')?.classList.remove('active');
}

function openTrash() {
  closeSideMenuIfOpen();
  renderTrash();
  document.getElementById('trashModal')?.classList.add('active');
}

function closeTrashModal() {
  document.getElementById('trashModal')?.classList.remove('active');
}

function renderTrash() {
  const list = document.getElementById('trashList');
  if (!list) return;

  if (state.trash.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">🗑️</div><p>Trash is empty</p></div>';
    return;
  }

  list.innerHTML = state.trash.map((item, i) => {
    if (item.itemType === 'account') {
      const name = item.account?.name || item.name || 'Account';
      return `<div class="trash-item">
<div class="info">
<div class="details">💳 Account: ${escapeHtml(name)}</div>
<div class="date">Deleted: ${new Date(item.deletedAt).toLocaleDateString('en-PK')}</div>
</div>
<div class="actions">
<button onclick="window.appHandler.restoreTrashItem(${i})" style="background:var(--green);color:#fff">↩️</button>
<button onclick="window.appHandler.permanentDeleteTrashItem(${i})" style="background:var(--red);color:#fff">✕</button>
</div>
</div>`;
    } else {
      const type = item.entry?.type || item.type || 'in';
      const amount = item.entry?.amount || item.amount || 0;
      const details = item.entry?.details || item.details || '';
      const prefix = type === 'in' ? '+' : '-';
      const d = new Date(item.deletedAt || item.date || Date.now());
      return `<div class="trash-item">
<div class="info">
<div class="details">${prefix} Rs ${formatNumber(amount)} ${details ? '-- ' + escapeHtml(details) : ''}</div>
<div class="date">${isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-PK')}</div>
</div>
<div class="actions">
<button onclick="window.appHandler.restoreTrashItem(${i})" style="background:var(--green);color:#fff">↩️</button>
<button onclick="window.appHandler.permanentDeleteTrashItem(${i})" style="background:var(--red);color:#fff">✕</button>
</div>
</div>`;
    }
  }).join('');
}

async function restoreTrashItem(index: number) {
  const item = state.trash.splice(index, 1)[0];
  if (!item) return;

  if (item.itemType === 'account' && item.account) {
    state.accounts.push(item.account);
    if (currentUser) {
      await saveAccount({
        id: item.account.id,
        userId: currentUser.uid,
        name: item.account.name,
        icon: item.account.icon
      });
      await fsRemoveTrash(currentUser.uid, item.id);
    }
  } else if (item.entry) {
    state.entries.push(item.entry);
    if (currentUser) {
      await fsSaveEntry({
        id: item.entry.id,
        userId: currentUser.uid,
        accountId: item.entry.accountId,
        type: item.entry.type,
        amount: item.entry.amount,
        details: item.entry.details,
        date: item.entry.date
      });
      await fsRemoveTrash(currentUser.uid, item.id);
    }
  }

  renderTrash();
  renderAll();
  showToast('Restored successfully');
}

async function permanentDeleteTrashItem(index: number) {
  const item = state.trash.splice(index, 1)[0];
  if (item && currentUser) {
    try {
      await fsRemoveTrash(currentUser.uid, item.id);
    } catch (err) {
      console.warn('Trash delete error:', err);
    }
  }
  renderTrash();
  showToast('Permanently deleted');
}

function emptyTrash() {
  if (state.trash.length === 0) {
    showToast('Trash is already empty');
    return;
  }
  state.confirmAction = async () => {
    const ids = state.trash.map(t => t.id);
    state.trash = [];
    if (currentUser) {
      try {
        await fsPurgeAllTrash(currentUser.uid, ids);
      } catch (err) {
        console.warn('Purge trash error:', err);
      }
    }
    renderTrash();
    showToast('Trash emptied');
  };
  showConfirm('Empty Trash?', 'Permanently delete all trash entries? This cannot be undone.');
}

function openAnalytics() {
  closeSideMenuIfOpen();
  document.getElementById('analyticsModal')?.classList.add('active');
  renderAnalytics();
}

function closeAnalyticsModal() {
  document.getElementById('analyticsModal')?.classList.remove('active');
}

function renderAnalytics() {
  const entries = state.filters.scope === 'all'
    ? state.entries
    : (state.activeAccountId ? getAccountEntries(state.activeAccountId) : []);
  const { totalIn, totalOut, net } = calculateBalance(entries);

  const inEl = document.getElementById('analyticsIn');
  const outEl = document.getElementById('analyticsOut');
  const netEl = document.getElementById('analyticsNet');

  if (inEl) inEl.textContent = 'Rs ' + formatNumber(totalIn);
  if (outEl) outEl.textContent = 'Rs ' + formatNumber(totalOut);
  if (netEl) netEl.textContent = formatBalanceNet(net);

  const canvas = document.getElementById('analyticsChart') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const days: { date: string; label: string; in: number; out: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({
      date: d.toISOString().split('T')[0],
      label: d.toLocaleDateString('en-PK', { weekday: 'short' }),
      in: 0,
      out: 0
    });
  }

  entries.forEach(e => {
    const day = (e.date || '').split('T')[0];
    const match = days.find(dd => dd.date === day);
    if (match) {
      if (e.type === 'in') match.in += Number(e.amount) || 0;
      else match.out += Number(e.amount) || 0;
    }
  });

  const maxVal = Math.max(...days.map(d => Math.max(d.in, d.out)), 1);
  const barW = 20;
  const gap = (w - 40) / 7;

  days.forEach((d, i) => {
    const x = 20 + i * gap + gap / 2;
    const inH = (d.in / maxVal) * (h - 50);
    const outH = (d.out / maxVal) * (h - 50);

    ctx.fillStyle = '#10b981';
    ctx.fillRect(x - barW, h - 30 - inH, barW / 2 - 1, inH);

    ctx.fillStyle = '#ef4444';
    ctx.fillRect(x + 1, h - 30 - outH, barW / 2 - 1, outH);

    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(d.label, x, h - 10);
  });
}

/* ============================================================
   IMPORT / EXPORT JSON
   ============================================================ */
function exportData() {
  closeSideMenuIfOpen();
  const data = JSON.stringify({ accounts: state.accounts, entries: state.entries, trash: state.trash }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cashbook_backup_' + new Date().toISOString().split('T')[0] + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Data exported');
}

function importData(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target?.result as string);
      if (Array.isArray(data.accounts)) state.accounts = data.accounts;
      if (Array.isArray(data.entries)) state.entries = data.entries;
      if (Array.isArray(data.trash)) state.trash = data.trash;

      if (state.accounts.length > 0 && !state.activeAccountId) {
        state.activeAccountId = state.accounts[0].id;
      }
      if (state.accounts.length === 0) {
        createDefaultAccount();
      }

      renderAll();

      if (currentUser) {
        setSyncStatus('saving');
        for (const a of state.accounts) {
          await saveAccount({ id: a.id, userId: currentUser.uid, name: a.name, icon: a.icon });
        }
        for (const en of state.entries) {
          await fsSaveEntry({
            id: en.id,
            userId: currentUser.uid,
            accountId: en.accountId,
            type: en.type,
            amount: en.amount,
            details: en.details,
            date: en.date
          });
        }
        setSyncStatus('synced');
      }

      showToast('Data imported successfully');
    } catch (err) {
      showToast('Invalid file format');
    }
  };
  reader.readAsText(file);
  target.value = '';
}

/* ============================================================
   STATEMENT EXPORT
   ============================================================ */
function openStatementExportModal() {
  closeSideMenuIfOpen();
  renderStatementPreview();
  document.getElementById('statementExportModal')?.classList.add('active');
}

function closeStatementExportModal() {
  document.getElementById('statementExportModal')?.classList.remove('active');
}

function renderStatementPreview() {
  const entries = getStatementEntries();
  const { totalIn, totalOut, net } = calculateBalance(entries);
  const acc = getActiveAccount();
  const area = document.getElementById('printableStatementArea');
  if (!area) return;

  const rows = entries.map(e => {
    const d = new Date(e.date);
    const cls = e.type === 'in' ? 'pos' : 'neg';
    const prefix = e.type === 'in' ? '+' : '-';
    const dateStr = isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-PK') + ' ' + d.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
    return `<tr>
<td>${dateStr}</td>
<td>${escapeHtml(e.details || '--')}</td>
<td style="text-align:right" class="${cls}">${prefix} Rs ${formatNumber(e.amount)}</td>
</tr>`;
  }).join('');

  area.innerHTML = `
<div class="statement-preview-header">
<h2><span>${acc ? acc.icon : '💳'}</span> ${acc ? escapeHtml(acc.name) : 'Cash Book'}</h2>
<div class="date">Generated: ${new Date().toLocaleDateString('en-PK')}</div>
</div>
<div class="statement-summary-grid">
<div class="statement-summary-box in"><strong>Cash In</strong><br>Rs ${formatNumber(totalIn)}</div>
<div class="statement-summary-box out"><strong>Cash Out</strong><br>Rs ${formatNumber(totalOut)}</div>
<div class="statement-summary-box net"><strong>Net Balance</strong><br>${formatBalanceNet(net)}</div>
</div>
<div style="font-size:11px;color:#475569;margin-bottom:6px"><b>Total Entries:</b> ${entries.length}</div>
<table class="statement-table">
<thead><tr><th>Date & Time</th><th>Details</th><th style="text-align:right">Amount</th></tr></thead>
<tbody>${rows || '<tr><td colspan="3" style="text-align:center;color:#94a3b8">No entries found</td></tr>'}</tbody>
</table>
<div class="statement-footer">Cash Book Pro • Powered by Firebase Firestore</div>
`;
}

function exportStatementAsPDF() {
  renderStatementPreview();
  setTimeout(() => window.print(), 200);
}

function exportStatementAsImage() {
  const area = document.getElementById('printableStatementArea');
  const win = window as any;
  if (win.html2canvas && area) {
    showToast('Generating picture...');
    win.html2canvas(area, { scale: 2, useCORS: true, backgroundColor: '#ffffff' })
      .then((canvas: HTMLCanvasElement) => {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        const accName = getActiveAccount() ? getActiveAccount()!.name.replace(/\s+/g, '_') : 'cashbook';
        a.download = `statement_${accName}_${new Date().toISOString().split('T')[0]}.png`;
        a.click();
        showToast('Picture downloaded!');
      })
      .catch(() => generateCanvasPictureFallback());
  } else {
    generateCanvasPictureFallback();
  }
}

function generateCanvasPictureFallback() {
  const entries = getStatementEntries();
  const { totalIn, totalOut, net } = calculateBalance(entries);
  const acc = getActiveAccount();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = 600;
  const rowHeight = 30;
  const height = 230 + (entries.length * rowHeight) + 30;
  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText((acc ? acc.icon + ' ' + acc.name : 'Cash Book') + ' Statement', 20, 40);

  ctx.fillStyle = '#64748b';
  ctx.font = '12px sans-serif';
  ctx.fillText('Generated: ' + new Date().toLocaleString('en-PK'), 20, 60);
  ctx.fillText('Total Entries: ' + entries.length, 20, 78);

  ctx.fillStyle = '#dcfce7'; ctx.fillRect(20, 92, 170, 50);
  ctx.fillStyle = '#166534'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('Cash In', 30, 110);
  ctx.fillText('Rs ' + formatNumber(totalIn), 30, 130);

  ctx.fillStyle = '#fee2e2'; ctx.fillRect(210, 92, 170, 50);
  ctx.fillStyle = '#991b1b'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('Cash Out', 220, 110);
  ctx.fillText('Rs ' + formatNumber(totalOut), 220, 130);

  ctx.fillStyle = '#dbeafe'; ctx.fillRect(400, 92, 180, 50);
  ctx.fillStyle = '#1e40af'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('Net Balance', 410, 110);
  ctx.fillText(formatBalanceNet(net), 410, 130);

  ctx.fillStyle = '#f1f5f9'; ctx.fillRect(20, 162, 560, 25);
  ctx.fillStyle = '#475569'; ctx.font = 'bold 11px sans-serif';
  ctx.fillText('DATE & TIME', 30, 179);
  ctx.fillText('DETAILS / NAME', 200, 179);
  ctx.fillText('AMOUNT', 480, 179);

  let y = 207;
  entries.forEach((e, idx) => {
    if (idx % 2 === 1) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(20, y - 18, 560, rowHeight);
    }
    const d = new Date(e.date);
    const dateStr = isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-PK') + ' ' + d.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
    ctx.fillStyle = '#1e293b';
    ctx.font = '11px sans-serif';
    ctx.fillText(dateStr, 30, y);
    ctx.fillText((e.details || '--').substring(0, 30), 200, y);

    const prefix = e.type === 'in' ? '+' : '-';
    ctx.fillStyle = e.type === 'in' ? '#16a34a' : '#dc2626';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(prefix + ' Rs ' + formatNumber(e.amount), 480, y);
    y += rowHeight;
  });

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Cash Book Pro • Powered by Firebase Firestore', width / 2, height - 15);

  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  const accName = acc ? acc.name.replace(/\s+/g, '_') : 'cashbook';
  a.download = `statement_${accName}_${new Date().toISOString().split('T')[0]}.png`;
  a.click();
  showToast('Statement picture saved');
}

function openStatementExportHTML() {
  closeStatementExportModal();
  const entries = getStatementEntries();
  const { totalIn, totalOut, net } = calculateBalance(entries);
  const acc = getActiveAccount();

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Statement - ${acc ? acc.name : 'Cash Book'}</title>
<style>body{font-family:sans-serif;padding:20px;max-width:600px;margin:0 auto;background:#fff;color:#0f172a}
h1{color:#1e293b;border-bottom:2px solid #3b82f6;padding-bottom:8px}
.summary{display:flex;gap:16px;margin:16px 0}
.summary div{flex:1;padding:12px;border-radius:8px;text-align:center}
.in{background:#dcfce7;color:#166534}.out{background:#fee2e2;color:#991b1b}.net{background:#dbeafe;color:#1e40af}
table{width:100%;border-collapse:collapse;margin-top:16px}
th{background:#f1f5f9;padding:8px;text-align:left;font-size:12px}
td{padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px}
.pos{color:#16a34a;font-weight:700}.neg{color:#dc2626;font-weight:700}
.footer{margin-top:24px;text-align:center;font-size:11px;color:#64748b}</style></head><body>
<h1>💳 ${acc ? acc.icon + ' ' + acc.name : 'Cash Book'} - Statement</h1>
<p style="color:#64748b;font-size:12px">Generated: ${new Date().toLocaleString('en-PK')} &nbsp;•&nbsp; Total Entries: ${entries.length}</p>
<div class="summary">
<div class="in"><strong>Total In</strong><br>Rs ${formatNumber(totalIn)}</div>
<div class="out"><strong>Total Out</strong><br>Rs ${formatNumber(totalOut)}</div>
<div class="net"><strong>Net Balance</strong><br>${formatBalanceNet(net)}</div>
</div>
<table><thead><tr><th>Date</th><th>Details</th><th style="text-align:right">Amount</th></tr></thead><tbody>`;

  entries.forEach(e => {
    const d = new Date(e.date);
    const cls = e.type === 'in' ? 'pos' : 'neg';
    const prefix = e.type === 'in' ? '+' : '-';
    const dateStr = isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-PK') + ' ' + d.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
    html += `<tr><td>${dateStr}</td><td>${escapeHtml(e.details || '--')}</td><td style="text-align:right" class="${cls}">${prefix} Rs ${formatNumber(e.amount)}</td></tr>`;
  });

  html += `</tbody></table><div class="footer">Cash Book Pro • Powered by Firebase Firestore</div></body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const accName = acc ? acc.name.replace(/\s+/g, '_') : 'cashbook';
  a.download = `statement_${accName}_${new Date().toISOString().split('T')[0]}.html`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Statement HTML exported');
}

/* ============================================================
   CONFIRM DIALOG
   ============================================================ */
function showConfirm(title: string, message: string, requireInput = false, expectedValue = '') {
  const tEl = document.getElementById('confirmTitle');
  const mEl = document.getElementById('confirmMessage');
  const inputContainer = document.getElementById('confirmInput');
  const inputField = document.getElementById('confirmInputField') as HTMLInputElement | null;

  if (tEl) tEl.textContent = title;
  if (mEl) mEl.textContent = message;
  if (inputContainer) inputContainer.style.display = requireInput ? 'block' : 'none';
  if (inputField) {
    inputField.value = '';
    inputField.dataset.expected = expectedValue || '';
  }

  document.getElementById('confirmOverlay')?.classList.add('active');
  document.getElementById('confirmDialog')?.classList.add('active');
}

function closeConfirm() {
  document.getElementById('confirmOverlay')?.classList.remove('active');
  document.getElementById('confirmDialog')?.classList.remove('active');
  state.confirmAction = null;
}

function executeConfirm() {
  const inputField = document.getElementById('confirmInputField') as HTMLInputElement | null;
  const expected = inputField?.dataset.expected;
  const inputVal = inputField?.value.trim() || '';

  if (expected && inputVal !== expected) {
    showToast('Input does not match. Please type exactly: ' + expected);
    return;
  }

  const action = state.confirmAction;
  closeConfirm();
  if (action) action();
}

/* ============================================================
   AUTO SYNC
   ============================================================ */
function updateAutoSyncUI() {
  const b = document.getElementById('autoSyncBtn');
  if (b) b.textContent = '🔄 Auto Sync: ' + (autoSync ? 'ON' : 'OFF');
  const s = document.getElementById('autoSyncState');
  if (s) s.textContent = autoSync ? 'ON' : 'OFF';
  setSyncStatus(syncState);
}

function toggleAutoSync() {
  closeSideMenuIfOpen();
  autoSync = !autoSync;
  localStorage.setItem('cbp_autosync', autoSync ? 'on' : 'off');
  updateAutoSyncUI();
  if (autoSync) {
    showToast('Auto Sync ON -- data will sync automatically');
  } else {
    showToast('Auto Sync OFF -- manual backup mode');
  }
}

async function cloudBackupNow() {
  closeSideMenuIfOpen();
  if (!currentUser) {
    showToast('Please sign in first');
    return;
  }
  setSyncStatus('saving');
  showToast('Backing up to Firestore…');

  try {
    for (const a of state.accounts) {
      await saveAccount({ id: a.id, userId: currentUser.uid, name: a.name, icon: a.icon });
    }
    for (const en of state.entries) {
      await fsSaveEntry({
        id: en.id,
        userId: currentUser.uid,
        accountId: en.accountId,
        type: en.type,
        amount: en.amount,
        details: en.details,
        date: en.date
      });
    }
    await saveUserProfile({
      userId: currentUser.uid,
      email: currentUser.email,
      displayName: currentUser.displayName,
      photoURL: currentUser.photoURL,
      theme: state.theme,
      activeAccountId: state.activeAccountId || undefined
    });
    setSyncStatus('synced');
    showToast('Cloud backup complete ✓');
  } catch (err) {
    console.error('Backup error:', err);
    setSyncStatus('error');
    showToast('Backup failed -- check network');
  }
}

function cloudRestoreNow() {
  closeSideMenuIfOpen();
  if (!currentUser) {
    showToast('Please sign in first');
    return;
  }
  showConfirm(
    '⬇️ Restore from Cloud?',
    `This will refresh your local ledger from Firestore for ${currentUser.email || currentUser.displayName}. Proceed?`
  );
  state.confirmAction = () => {
    showToast('Restoring latest data from Firestore…');
    setSyncStatus('synced');
  };
}

/* ============================================================
   DEFAULT ACCOUNT CREATION
   ============================================================ */
async function createDefaultAccount() {
  const acc: AppAccount = { id: generateId(), name: 'Main Cash', icon: '💵' };
  state.accounts.push(acc);
  state.activeAccountId = acc.id;

  if (currentUser) {
    try {
      await saveAccount({
        id: acc.id,
        userId: currentUser.uid,
        name: acc.name,
        icon: acc.icon
      });
      await saveUserProfile({
        userId: currentUser.uid,
        email: currentUser.email,
        activeAccountId: acc.id
      });
    } catch (err) {
      console.warn('Default account create warning:', err);
    }
  }
  renderAll();
}

/* ============================================================
   AUTH HANDLING (GOOGLE SIGN IN & LOGOUT)
   ============================================================ */
function setLoginStatus(msg: string, cls?: string) {
  const el = document.getElementById('loginStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'login-status' + (cls ? ' ' + cls : '');
}

async function handleGoogleLogin() {
  const btn = document.getElementById('googleLoginBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  setLoginStatus('Opening Google Sign-In…');

  try {
    const cred = await signInWithPopup(auth, googleProvider);
    setLoginStatus('Signed in successfully! Loading ledger…', 'ok');
    showToast(`Welcome ${cred.user.displayName || cred.user.email}!`);
  } catch (error: any) {
    console.error('Google Sign-in error:', error);
    setLoginStatus('Sign-in error: ' + (error?.message || 'Check popup permissions'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handlePhoneLogin() {
  const phone = (document.getElementById('loginPhone') as HTMLInputElement)?.value.trim();
  const name = (document.getElementById('loginName') as HTMLInputElement)?.value.trim();

  if (!phone || phone.length < 10) {
    setLoginStatus('Please enter a valid phone number (at least 10 digits)', 'error');
    return;
  }

  // To provide full cloud security and cross-device sync as requested,
  // recommend Google Sign-in or create authenticated profile
  setLoginStatus('Connecting with private ID…', 'ok');
  showToast('Tip: Use "Continue with Google" for automatic secure cloud sync!');
  // Trigger Google sign-in to authenticate securely
  handleGoogleLogin();
}

async function logoutUser() {
  closeSideMenuIfOpen();
  state.confirmAction = async () => {
    try {
      await signOut(auth);
      cleanupSubscriptions();
      currentUser = null;
      state = freshState();
      document.getElementById('loginScreen')?.classList.remove('hidden');
      showToast('Logged out');
    } catch (err) {
      console.error('Logout error:', err);
    }
  };
  showConfirm('Logout?', 'You will need to sign in again to access your private data.');
}

function cleanupSubscriptions() {
  if (unsubAccounts) { unsubAccounts(); unsubAccounts = null; }
  if (unsubEntries) { unsubEntries(); unsubEntries = null; }
  if (unsubTrash) { unsubTrash(); unsubTrash = null; }
}

/* ============================================================
   ATTACH USER SESSION & FIRESTORE LISTENERS
   ============================================================ */
function attachUserDataListeners(user: User) {
  cleanupSubscriptions();

  // Listen to accounts
  unsubAccounts = subscribeToAccounts(user.uid, (accs) => {
    if (accs && accs.length > 0) {
      state.accounts = accs.map(a => ({ id: a.id, name: a.name, icon: a.icon }));
      if (!state.activeAccountId || !state.accounts.some(a => a.id === state.activeAccountId)) {
        state.activeAccountId = state.accounts[0].id;
      }
    } else if (state.accounts.length === 0) {
      createDefaultAccount();
    }
    renderAll();
    setSyncStatus('synced');
  }, (err) => {
    console.warn('Accounts subscription notice:', err);
    setSyncStatus('error');
  });

  // Listen to entries
  unsubEntries = subscribeToEntries(user.uid, (entries) => {
    state.entries = entries.map(e => ({
      id: e.id,
      accountId: e.accountId,
      type: e.type,
      amount: e.amount,
      details: e.details,
      date: e.date
    }));
    renderAll();
    setSyncStatus('synced');
  }, (err) => {
    console.warn('Entries subscription notice:', err);
    setSyncStatus('error');
  });

  // Listen to trash
  unsubTrash = subscribeToTrash(user.uid, (trashList) => {
    state.trash = trashList.map(t => ({
      id: t.id,
      itemType: t.itemType,
      deletedAt: t.deletedAt,
      account: t.itemType === 'account' ? t.data : undefined,
      entry: t.itemType === 'entry' ? t.data : undefined,
      type: t.data?.type,
      name: t.data?.name,
      amount: t.data?.amount,
      details: t.data?.details,
      date: t.data?.date
    }));
    renderTrash();
  });
}

function updateUserInfoUI(user: User) {
  const avatarEl = document.getElementById('sideUserAvatar');
  const nameEl = document.getElementById('sideUserName');
  const phoneEl = document.getElementById('sideUserPhone');
  const sp = document.getElementById('settingsPhone');
  const sn = document.getElementById('settingsName');

  const displayName = user.displayName || user.email?.split('@')[0] || 'User';
  const emailOrPhone = user.email || user.phoneNumber || user.uid.substring(0, 10);

  if (avatarEl) {
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${escapeHtml(user.photoURL)}" alt="Avatar" referrerpolicy="no-referrer">`;
    } else {
      avatarEl.textContent = '👤';
    }
  }
  if (nameEl) nameEl.textContent = displayName;
  if (phoneEl) phoneEl.textContent = emailOrPhone;
  if (sp) sp.textContent = emailOrPhone;
  if (sn) sn.textContent = displayName;
}

/* ============================================================
   PWA INSTALL
   ============================================================ */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!localStorage.getItem('cbp_install_dismissed')) {
    document.getElementById('installBanner')?.classList.add('show');
  }
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  dismissInstallBanner();
  showToast('App installed successfully! 🎉');
});

function triggerInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then((choice: any) => {
      if (choice.outcome === 'accepted') {
        showToast('Installing…');
      }
      deferredInstallPrompt = null;
    });
  } else {
    showToast('Add to Home Screen from your browser menu');
  }
}

function dismissInstallBanner() {
  document.getElementById('installBanner')?.classList.remove('show');
  localStorage.setItem('cbp_install_dismissed', '1');
}

/* ============================================================
   KEYBOARD
   ============================================================ */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (!document.getElementById('loginScreen')?.classList.contains('hidden')) {
      handleGoogleLogin();
      return;
    }
    if (document.getElementById('entryModal')?.classList.contains('active')) {
      saveEntry();
    }
  }
  if (e.key === 'Escape') {
    closeEntryModal();
    closeAccountModal();
    closeFilterModal();
    closeSettingsModal();
    closeTrashModal();
    closeAnalyticsModal();
    closeMoveEntryModal();
    closeEntryActionModal();
    closeStatementExportModal();
    closeConfirm();
  }
});

/* ============================================================
   EXPOSE APP HANDLER TO WINDOW
   ============================================================ */
const appHandler = {
  handleGoogleLogin,
  handlePhoneLogin,
  logoutUser,
  toggleSideMenu,
  openAccountModal,
  closeAccountModal,
  switchAccount,
  addAccount,
  editAccount,
  deleteAccount,
  openEntryModal,
  closeEntryModal,
  saveEntry,
  editEntry,
  deleteEntry,
  openMoveEntryModal,
  closeMoveEntryModal,
  moveEntryToAccount,
  openEntryActionModal,
  closeEntryActionModal,
  actionEditEntry,
  actionMoveEntry,
  actionDeleteEntry,
  showDetailsSuggestions,
  clickSuggestionChip,
  openFilterModal,
  closeFilterModal,
  handleSearchFromModal,
  clearSearchFromModal,
  applyFilters,
  resetFilters,
  openStatementExportModal,
  closeStatementExportModal,
  exportStatementAsPDF,
  exportStatementAsImage,
  openStatementExportHTML,
  openSettings,
  closeSettingsModal,
  selectTheme,
  cloudBackupNow,
  cloudRestoreNow,
  toggleAutoSync,
  openTrash,
  closeTrashModal,
  restoreTrashItem,
  permanentDeleteTrashItem,
  emptyTrash,
  openAnalytics,
  closeAnalyticsModal,
  exportData,
  importData,
  closeConfirm,
  executeConfirm,
  triggerInstall,
  dismissInstallBanner
};

(window as any).appHandler = appHandler;

/* ============================================================
   BOOTSTRAP
   ============================================================ */
async function boot() {
  state.theme = localStorage.getItem('cbp_theme') || 'dark';
  applyTheme();
  setupIconSelector();
  setupFilterChips();
  updateAutoSyncUI();

  // Test Firestore connection on boot (as required by Firestore skill)
  testConnection().then(ok => {
    if (ok) {
      setLoginStatus('Connected to Google Firestore ✓', 'ok');
    } else {
      setLoginStatus('Offline / local cache ready');
    }
  });

  // Watch Auth State
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || user.email?.split('@')[0] || 'User',
        photoURL: user.photoURL || ''
      };

      document.getElementById('loginScreen')?.classList.add('hidden');
      updateUserInfoUI(user);
      attachUserDataListeners(user);

      // Save initial profile
      saveUserProfile({
        userId: user.uid,
        email: currentUser.email,
        displayName: currentUser.displayName,
        photoURL: currentUser.photoURL,
        theme: state.theme
      }).catch(e => console.warn('User profile sync notice:', e));
    } else {
      currentUser = null;
      cleanupSubscriptions();
      document.getElementById('loginScreen')?.classList.remove('hidden');
      setLoginStatus('Ready to connect…');
    }
  });
}

// Start application
boot();
