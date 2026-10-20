import './style.css';
import './recovery.css';
import './browse.css';
import './scope.css';
import './linked.css';
import './gorelo-theme.css';
import { readSelectedEmail, type Email } from './mail';
import { isOutlookHost } from './outlook-host';
import { BrowsePane, type AssetItem, type AssetKind, type SenderContact } from './browse';
import { prioritizeSenderDevices, senderUsesDevice } from './asset-sort';
import { presenceLabel } from './asset-presence';
import { nameParts, uniqueRecipients } from './recipients';
import { creationKey, savedTicketId, savedAttachmentRetryToken, saveTicketId } from './ticket-creation';
import { icon } from './icons';
import { microsoftHeaders } from './auth';

type Option = { id: number; name: string; color?: string };
type Options = { groups: Option[]; statuses: Option[]; types: Option[]; clients: Option[] };
type GoreloUser = { id: number; name: string; email: string };
const app = document.querySelector<HTMLDivElement>('#app')!;
let hostState: 'checking' | 'outlook' | 'unavailable' = 'checking';
let email: Email | undefined;
let options: Options | undefined;
let busy = false;
let submitting = false;
let selectionVersion = 0;
let keyVersion = 0;
let pendingSelection = false;
let creationUnconfirmed = false;
let createdTicketId = '';
let createdMailKey: string | undefined;
let checkingCreation = false;
type AttachmentResult = { attachmentRetryToken?: string; retryableAttachmentCount?: number; uncertainAttachmentCount?: number; partialFailures?: string[] };
let attachmentResult: AttachmentResult = {};
let attachmentBusy = false;
let view: 'create' | 'tickets' | 'assets' = 'create';
let draft: Record<string, string> = {};
let matchedSender = '';
let classificationNote = '';
let classificationBusy = false;
let classificationAttempt = '';
const ccDraft = new Map<string, { included: boolean; firstName: string; lastName: string }>();
let senderDraft: { firstName: string; lastName: string } | undefined;
let users: GoreloUser[] = [];
let usersLoaded = false;
let usersBusy = false;
let usersError = '';
let usersRequestId = 0;
let assetPickerOpen = false;
let createAssetKind: AssetKind = 'agent';
let createAssetQuery = '';
let createAssetResults: AssetItem[] = [];
let createAssetsCursor = '';
let createAssetsBusy = false;
let createAssetsError = '';
const senderDevicesCache = new Map<string, AssetItem[]>();
let matchedAssets: AssetItem[] = [];
let matchedAssetClient = '';
let matchedAssetBusy = false;
let matchedAssetError = '';
let matchedAssetRequestId = 0;
let assetRequestId = 0;
let contactRequestId = 0;
const selectedAgentAssets = new Map<string, string>();
const selectedCustomAssets = new Map<string, string>();
let notice: { kind: 'success' | 'error'; message: string; ticketId?: string } | undefined;
const keyStorageName = 'gorelo-outlook-api-key';
let goreloKey = '';
let authMode: 'loading' | 'server' | 'local' | 'error' = 'loading';
let authModeError = '';
const hasGoreloAuth = () => authMode === 'server' || (authMode === 'local' && Boolean(goreloKey));
const browser = new BrowsePane(api, () => options?.clients || [], () => options?.statuses || [], () => email, hasGoreloAuth, () => render(), () => { view = 'assets'; render(); }, () => { void loadMatch(); });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function field(label: string, values: Option[], required: boolean, id: string): HTMLElement {
  const wrapper = el('label', 'field');
  wrapper.append(el('span', 'field-label', label));
  const select = el('select') as HTMLSelectElement;
  select.name = id;
  select.required = required;
  select.append(OptionElement('Select ' + label.toLowerCase(), ''));
  values.forEach((entry) => select.append(OptionElement(entry.name, String(entry.id))));
  if (draft[id]) select.value = draft[id];
  wrapper.append(select);
  return wrapper;
}

function OptionElement(label: string, value: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.textContent = label;
  option.value = value;
  return option;
}

function authModeFailure(): HTMLElement {
  const box = el('div', 'notice error');
  box.setAttribute('role', 'alert');
  box.append(icon('alert'), el('span', '', authModeError || 'Could not check the secure Gorelo connection.'));
  const retry = el('button', 'key-link', 'Sign in with Microsoft / Retry') as HTMLButtonElement;
  retry.type = 'button';
  retry.addEventListener('click', () => { void detectAuthMode(true, true); });
  box.append(retry);
  return box;
}

async function detectAuthMode(reloadOptions = false, interactive = false): Promise<void> {
  authMode = 'loading';
  authModeError = '';
  render();
  try {
    const headers = await microsoftHeaders(interactive);
    headers.set('Accept', 'application/json');
    const response = await fetch('/api/auth-mode', { headers });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || `Connection check failed (${response.status}).`);
    }
    const result = await response.json() as { serverManaged?: boolean };
    if (typeof result.serverManaged !== 'boolean') throw new Error('The server returned an invalid authentication mode.');
    authMode = result.serverManaged ? 'server' : 'local';
    if (result.serverManaged) {
      try { localStorage.removeItem(keyStorageName); } catch { /* Storage is optional. */ }
      goreloKey = '';
    } else {
      try { goreloKey = localStorage.getItem(keyStorageName) || ''; } catch { goreloKey = ''; }
    }
    render();
    if (reloadOptions && hasGoreloAuth()) void loadOptions();
  } catch (error) {
    authMode = 'error';
    authModeError = error instanceof Error ? error.message : 'Microsoft sign-in or the secure Gorelo connection failed.';
    render();
  }
}

function renderCreateAssets(): HTMLElement {
  const section = el('section', 'create-assets');
  section.append(el('h2', '', 'Linked assets'));
  const selected = [
    ...Array.from(selectedAgentAssets.values()),
    ...Array.from(selectedCustomAssets.values()),
  ];
  section.append(el('p', 'form-note', selected.length ? `${selected.length} selected: ${selected.join(', ')}` : 'Optionally link a managed device or custom asset to the new ticket.'));
  if (!draft.clientId) {
    section.append(el('p', 'form-note', 'Choose a client first to browse its assets.'));
    return section;
  }
  if (email && hasGoreloAuth()) {
    const matches = el('div', 'matched-assets');
    matches.append(el('p', 'form-note', 'Devices last used by this sender. Tick any that should be linked to the ticket; last logon does not establish ownership.'));
    if (matchedAssetBusy) matches.append(el('p', 'browse-empty', 'Finding matching devices…'));
    if (matchedAssetError) {
      matches.append(el('p', 'browse-error', matchedAssetError));
      const retry = el('button', 'text-action', 'Retry matching devices') as HTMLButtonElement;
      retry.type = 'button'; retry.addEventListener('click', () => { void loadMatchedAssets(); }); matches.append(retry);
    }
    if (matchedAssetClient && !matchedAssetBusy && !matchedAssetError && !matchedAssets.length) matches.append(el('p', 'form-note', 'No devices matched this sender. You can still choose other assets below.'));
    for (const asset of matchedAssets) {
      const row = el('label', 'asset-choice');
      const checkbox = el('input') as HTMLInputElement;
      checkbox.type = 'checkbox'; checkbox.checked = selectedAgentAssets.has(asset.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedAgentAssets.set(asset.id, asset.name);
        else selectedAgentAssets.delete(asset.id);
        render();
      });
      const details = el('span', 'asset-choice-details');
      const name = el('span', 'asset-name'); name.append(document.createTextNode(asset.name));
      const presence = presenceLabel(asset.details?.statusName);
      if (presence) name.append(presence);
      details.append(name);
      const signedIn = asset.details?.lastLoggedOnUser || asset.details?.lastLoggedOnUserUpn;
      if (signedIn) details.append(el('small', '', `Last logged on: ${signedIn}`));
      row.append(checkbox, details); matches.append(row);
    }
    section.append(matches);
  }
  const toggle = el('button', 'text-action', assetPickerOpen ? 'Hide asset picker' : 'Choose assets') as HTMLButtonElement;
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    assetPickerOpen = !assetPickerOpen;
    render();
    if (assetPickerOpen && !createAssetResults.length) void loadCreateAssets(true);
  });
  section.append(toggle);
  if (!assetPickerOpen) return section;

  const kindTabs = el('div', 'kind-tabs');
  for (const kind of ['agent', 'custom'] as const) {
    const label = kind === 'agent' ? 'Managed devices' : 'Custom assets';
    const tab = el('button', `kind-tab${createAssetKind === kind ? ' active' : ''}`, label) as HTMLButtonElement;
    tab.type = 'button';
    if (kind === createAssetKind) tab.setAttribute('aria-current', 'page');
    tab.addEventListener('click', () => { createAssetKind = kind; createAssetResults = []; createAssetsCursor = ''; void loadCreateAssets(true); });
    kindTabs.append(tab);
  }
  section.append(kindTabs);
  const search = el('div', 'asset-search');
  const input = el('input') as HTMLInputElement;
  input.type = 'search'; input.value = createAssetQuery; input.placeholder = 'Find a client asset';
  input.setAttribute('aria-label', 'Find an asset to link');
  input.addEventListener('input', () => { createAssetQuery = input.value; });
  const button = el('button', 'browse-search', 'Find') as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', () => { createAssetQuery = input.value.trim(); void loadCreateAssets(true); });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); button.click(); } });
  search.append(input, button); section.append(search);
  if (createAssetsError) section.append(el('p', 'browse-error', createAssetsError));
  if (createAssetsBusy && !createAssetResults.length) section.append(el('p', 'browse-empty', 'Loading client assets…'));
  if (!createAssetsBusy && !createAssetsError && !createAssetResults.length) section.append(el('p', 'browse-empty', 'No matching assets for this client.'));
  const list = el('div', 'asset-choices');
  const selectedMap = createAssetKind === 'agent' ? selectedAgentAssets : selectedCustomAssets;
  for (const asset of createAssetResults) {
    const row = el('label', 'asset-choice');
    const checkbox = el('input') as HTMLInputElement;
    checkbox.type = 'checkbox'; checkbox.checked = selectedMap.has(asset.id);
    checkbox.addEventListener('change', () => { if (checkbox.checked) selectedMap.set(asset.id, asset.name); else selectedMap.delete(asset.id); render(); });
    const info = el('span', 'asset-choice-details');
    const name = el('span', 'asset-name'); name.append(document.createTextNode(asset.name));
    if (asset.kind === 'agent') { const presence = presenceLabel(asset.details?.statusName); if (presence) name.append(presence); }
    info.append(name);
    if (asset.kind === 'agent') {
      const signedIn = asset.details?.lastLoggedOnUser || asset.details?.lastLoggedOnUserUpn;
      if (signedIn) info.append(el('small', '', `Last logged on: ${signedIn}`));
      if (senderUsesDevice(asset, email?.from.email || '')) info.append(el('small', '', 'Last used by this email’s sender'));
    }
    row.append(checkbox, info); list.append(row);
  }
  section.append(list);
  if (createAssetsCursor) {
    const more = el('button', 'text-action', createAssetsBusy ? 'Loading…' : 'More assets') as HTMLButtonElement;
    more.type = 'button'; more.disabled = createAssetsBusy;
    more.addEventListener('click', () => { void loadCreateAssets(false); });
    section.append(more);
  }
  return section;
}

function renderParticipants(): HTMLElement {
  const section = el('section', 'create-participants');
  section.append(el('h2', '', 'Requester, assignment and CC contacts'));
  section.append(el('p', 'form-note', 'The sender is the requester. Matching Gorelo contacts are reused; missing contacts are created under the chosen client. No ticket-created notification email is sent.'));
  if (!draft.clientId || !email) {
    section.append(el('p', 'form-note', 'Choose a client first to add contacts.'));
    return section;
  }
  senderDraft ||= nameParts(email.from);
  {
    const requester = el('div', 'participant-row');
    requester.append(el('span', 'participant-address', `Requester · ${email.from.email}`));
    for (const [key, label] of [['firstName', 'First name'], ['lastName', 'Last name']] as const) {
      const input = el('input') as HTMLInputElement;
      input.type = 'text'; input.name = key === 'firstName' ? 'requesterFirstName' : 'requesterLastName';
      input.setAttribute('aria-label', `Requester ${label.toLowerCase()}`);
      input.placeholder = label;
      input.maxLength = 150; input.required = true; input.value = senderDraft[key];
      input.addEventListener('input', () => { senderDraft![key] = input.value; });
      requester.append(input);
    }
    section.append(requester);
  }
  const toEmails = new Set(email.to.map(({ email }) => email.toLowerCase()));
  const matchingUsers = users.filter(({ email }) => toEmails.has(email.toLowerCase()));
  const assignment = el('div', 'assignment-review');
  assignment.append(el('h3', '', 'Assign ticket from To recipients'));
  if (usersBusy) assignment.append(el('p', 'form-note', 'Checking Gorelo technicians…'));
  if (usersError) {
    assignment.append(el('p', 'browse-error', `Could not match technicians: ${usersError}`));
    const retry = el('button', 'text-action', 'Retry technician lookup') as HTMLButtonElement;
    retry.type = 'button'; retry.addEventListener('click', () => { void loadUsers(); }); assignment.append(retry);
  }
  if (!usersBusy && !usersError) {
    const select = el('select') as HTMLSelectElement;
    select.name = 'leadAssigneeId'; select.setAttribute('aria-label', 'Assign ticket to Gorelo technician');
    select.append(OptionElement('Unassigned', ''));
    for (const user of matchingUsers) select.append(OptionElement(`${user.name} · ${user.email}`, String(user.id)));
    if (draft.leadAssigneeId === undefined && matchingUsers.length === 1) draft.leadAssigneeId = String(matchingUsers[0]!.id);
    select.value = draft.leadAssigneeId || '';
    assignment.append(select);
    if (usersLoaded && !matchingUsers.length) assignment.append(el('p', 'form-note', 'No To address matches a Gorelo technician. Ticket will remain unassigned.'));
    if (matchingUsers.length > 1 && !draft.leadAssigneeId) assignment.append(el('p', 'form-note', 'Multiple To addresses match technicians. Choose the lead assignee above.'));
  }
  assignment.append(el('p', 'form-note', 'Technicians in To can be assigned the ticket. Other To recipients can be added as ticket CC contacts. Matching uses exact Gorelo technician email addresses.'));
  section.append(assignment);
  const recipients = ticketCcCandidates(email);
  if (!recipients.length) section.append(el('p', 'form-note', usersBusy || usersError ? 'Waiting for technician lookup before offering To recipients as ticket CC contacts.' : 'No additional recipients to add as ticket CC contacts.'));
  for (const recipient of recipients) {
    let saved = ccDraft.get(recipient.email);
    if (!saved) { saved = { included: true, ...nameParts(recipient) }; ccDraft.set(recipient.email, saved); }
    const entry = saved;
    const row = el('div', 'participant-row');
    const label = el('label', 'participant-address');
    const checkbox = el('input') as HTMLInputElement;
    checkbox.type = 'checkbox'; checkbox.name = 'ccEmail'; checkbox.value = recipient.email; checkbox.checked = entry.included;
    checkbox.addEventListener('change', () => {
      entry.included = checkbox.checked;
      row.querySelectorAll<HTMLInputElement>('input[type=text]').forEach((input) => { input.disabled = !checkbox.checked; });
    });
    label.append(checkbox, el('span', '', `${recipient.role} · ${recipient.email}`)); row.append(label);
    for (const [key, name] of [['firstName', 'First name'], ['lastName', 'Last name']] as const) {
      const input = el('input') as HTMLInputElement;
      input.type = 'text'; input.value = entry[key]; input.maxLength = 150;
      input.required = true; input.disabled = !entry.included;
      input.setAttribute('aria-label', `${name} for ${recipient.email}`);
      input.placeholder = name;
      input.addEventListener('input', () => { entry[key] = input.value; });
      row.append(input);
    }
    section.append(row);
  }
  section.append(el('p', 'form-note', 'Unticking a recipient excludes them from Gorelo contacts and ticket CCs. The original To/Cc remain in the email record on the ticket.'));
  return section;
}

function ticketCcCandidates(selected: Email): ReturnType<typeof uniqueRecipients> {
  return uniqueRecipients(selected, new Set(users.map(({ email }) => email.toLowerCase())), usersLoaded && !usersError);
}

async function loadUsers(): Promise<void> {
  if (!email?.to.length || !hasGoreloAuth() || usersBusy) return;
  const requestId = ++usersRequestId;
  const key = keyVersion;
  usersBusy = true; usersError = ''; render();
  try {
    const result: { users: GoreloUser[] } = await api('/api/users');
    if (requestId === usersRequestId && key === keyVersion) { users = result.users; usersLoaded = true; }
  } catch (error) {
    if (requestId === usersRequestId && key === keyVersion) usersError = error instanceof Error ? error.message : 'Could not load technicians.';
  } finally { if (requestId === usersRequestId && key === keyVersion) { usersBusy = false; render(); } }
}

async function loadMatchedAssets(): Promise<void> {
  if (!draft.clientId || !email || !hasGoreloAuth()) return;
  const requestId = ++matchedAssetRequestId;
  const cacheKey = `${draft.clientId}:${email.from.email.toLowerCase()}`;
  matchedAssetClient = cacheKey; matchedAssetBusy = true; matchedAssetError = ''; matchedAssets = []; render();
  try {
    const result: AssetItem[] = senderDevicesCache.has(cacheKey)
      ? senderDevicesCache.get(cacheKey)!
      : (await api(`/api/assets?${new URLSearchParams({ kind: 'agent', clientId: draft.clientId, userEmail: email.from.email })}`) as { items: AssetItem[] }).items;
    if (requestId !== matchedAssetRequestId) return;
    matchedAssets = result;
    senderDevicesCache.set(cacheKey, result);
  } catch (error) {
    if (requestId === matchedAssetRequestId) matchedAssetError = error instanceof Error ? error.message : 'Could not find matching devices.';
  } finally { if (requestId === matchedAssetRequestId) { matchedAssetBusy = false; render(); } }
}

async function loadCreateAssets(reset = true): Promise<void> {
  if (!draft.clientId || !hasGoreloAuth()) return;
  const requestId = ++assetRequestId;
  createAssetsBusy = true; createAssetsError = ''; render();
  try {
    const params = new URLSearchParams({ kind: createAssetKind, clientId: draft.clientId });
    if (createAssetQuery) params.set('query', createAssetQuery);
    if (!reset && createAssetsCursor) params.set('cursor', createAssetsCursor);
    const cacheKey = `${draft.clientId}:${email?.from.email.toLowerCase() || ''}`;
    const senderDevices = reset && createAssetKind === 'agent' && email?.from.email && !createAssetQuery
      ? (senderDevicesCache.has(cacheKey) ? Promise.resolve(senderDevicesCache.get(cacheKey)!) : api(`/api/assets?${new URLSearchParams({ kind: 'agent', clientId: draft.clientId, userEmail: email.from.email })}`).then((result: { items: AssetItem[] }) => {
          senderDevicesCache.set(cacheKey, result.items);
          return result.items;
        }))
      : Promise.resolve([] as AssetItem[]);
    const [result, matched]: [{ items: AssetItem[]; nextCursor?: string }, AssetItem[]] = await Promise.all([api(`/api/assets?${params}`), senderDevices]);
    if (requestId !== assetRequestId) return;
    const known = new Map((reset ? [...matched, ...result.items] : [...createAssetResults, ...result.items]).map((asset) => [asset.id, asset]));
    createAssetResults = prioritizeSenderDevices([...known.values()], email?.from.email || '');
    createAssetsCursor = result.nextCursor || '';
  } catch (error) {
    if (requestId === assetRequestId) createAssetsError = error instanceof Error ? error.message : 'Could not load assets.';
  } finally {
    if (requestId === assetRequestId) { createAssetsBusy = false; render(); }
  }
}

function render(): void {
  if (options && email && !draft.statusId) {
    const newStatus = options.statuses.find(({ name }) => name.trim().toLowerCase() === 'new');
    if (newStatus) draft.statusId = String(newStatus.id);
  }
  app.replaceChildren();
  const shell = el('main', 'shell');
  const header = el('header', 'topbar');
  const mark = el('div', 'mark');
  const officialMark = el('img') as HTMLImageElement;
  officialMark.src = '/gorelo-mark.svg'; officialMark.alt = '';
  officialMark.width = 38; officialMark.height = 38;
  mark.append(officialMark);
  const brand = el('div', 'brand');
  brand.append(el('strong', '', 'Gorelo'), el('span', '', 'Unofficial plugin · v0.1.0'));
  header.append(mark, brand, el('span', 'topbar-state', hostState === 'unavailable' ? 'OUTLOOK ONLY' : authMode === 'loading' ? 'CHECKING' : authMode === 'error' ? 'OFFLINE' : authMode === 'server' ? 'SERVER KEY' : goreloKey ? 'KEY SAVED' : 'SETUP'));
  shell.append(header);
  shell.append(el('p', 'unofficial-disclaimer', 'This is not an official Gorelo tool and is not affiliated with or endorsed by Gorelo. Use at your own risk.'));
  const credits = el('a', 'credits-link', 'Credits and licenses') as HTMLAnchorElement;
  credits.href = '/credits.html';
  credits.target = '_blank';
  credits.rel = 'noopener noreferrer';
  credits.setAttribute('aria-label', 'Credits and licenses (opens in a new tab)');
  shell.append(credits);

  if (hostState !== 'outlook') {
    const intro = el('section', 'intro');
    intro.setAttribute('role', 'status');
    intro.append(el('h1', '', hostState === 'checking' ? 'Connecting to Outlook…' : 'Open this add-in in Outlook'),
      el('p', '', hostState === 'checking' ? 'Waiting for Outlook to initialise.' : 'Gorelo for Outlook is only available inside Outlook. Open an email in Outlook, then launch the Gorelo add-in from Apps. This website cannot be used on its own.'));
    shell.append(intro);
    app.append(shell);
    return;
  }

  if (authMode === 'local') {
    const settings = el('section', 'key-settings');
    if (goreloKey) {
      const info = el('span', '', 'Gorelo key saved on this device');
      const forget = el('button', 'key-link', 'Change key') as HTMLButtonElement;
      forget.type = 'button';
      forget.disabled = busy;
      forget.addEventListener('click', () => {
        if (busy) return;
        keyVersion++; assetRequestId++; contactRequestId++;
        usersRequestId++; users = []; usersLoaded = false; usersBusy = false; usersError = '';
        matchedAssetRequestId++; matchedAssetClient = ''; matchedAssets = []; matchedAssetBusy = false; matchedAssetError = ''; senderDevicesCache.clear();
        try { localStorage.removeItem(keyStorageName); } catch { /* Storage is optional. */ }
        goreloKey = '';
        options = undefined;
        draft = {};
        browser.setSender(email?.from.email || '');
        selectedAgentAssets.clear(); selectedCustomAssets.clear();
        createAssetResults = []; createAssetsCursor = ''; createAssetsBusy = false; createAssetsError = ''; assetPickerOpen = false;
        notice = undefined;
        render();
      });
      settings.append(info, forget);
    } else {
      const label = el('label', 'key-entry');
      label.append(el('span', '', 'Gorelo API key'));
      const input = el('input') as HTMLInputElement;
      input.type = 'password';
      input.placeholder = 'Paste your API key';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', 'Gorelo API key');
      const save = el('button', 'key-save', 'Save') as HTMLButtonElement;
      save.type = 'button';
      save.disabled = busy;
      save.addEventListener('click', () => {
        if (busy) return;
        const value = input.value.trim();
        if (!value) { input.focus(); return; }
        try { localStorage.setItem(keyStorageName, value); }
        catch { notice = { kind: 'error', message: 'Outlook blocked local storage. Enable it to save the Gorelo key.' }; render(); return; }
        input.value = '';
        keyVersion++; assetRequestId++; contactRequestId++;
        usersRequestId++; users = []; usersLoaded = false; usersBusy = false; usersError = '';
        matchedAssetRequestId++; matchedAssetClient = ''; matchedAssets = []; matchedAssetBusy = false; matchedAssetError = ''; senderDevicesCache.clear();
        goreloKey = value;
        browser.setSender(email?.from.email || '');
        render();
        void loadOptions();
      });
      label.append(input);
      settings.append(label, save);
    }
    shell.append(settings);
  }

  const navigation = el('nav', 'workspace-nav');
  navigation.setAttribute('aria-label', 'Gorelo sections');
  for (const [target, label] of [['create', createdTicketId ? 'Ticket created' : 'Create ticket'], ['tickets', 'Tickets'], ['assets', 'Assets']] as const) {
    const button = el('button', `workspace-tab${view === target ? ' active' : ''}`) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.append(icon(target === 'create' ? 'ticket' : target === 'tickets' ? 'mail' : 'asset'), el('span', 'tab-label-full', label));
    if (target === 'create') button.append(el('span', 'tab-label-short', 'Create'));
    if (view === target) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => {
      if (view === target) return;
      view = target;
      notice = undefined;
      render();
      if (hasGoreloAuth()) {
        if (target === 'tickets') browser.ensureTickets();
        if (target === 'assets') browser.ensureAssets();
      }
    });
    navigation.append(button);
  }
  shell.append(navigation);

  if (view !== 'create') {
    if (authMode === 'loading') shell.append(el('p', 'browse-empty', 'Checking the secure Gorelo connection…'));
    else if (authMode === 'error') shell.append(authModeFailure());
    else if (!hasGoreloAuth()) shell.append(el('p', 'browse-empty', 'Save your Gorelo API key above to browse Gorelo.'));
    else shell.append(view === 'tickets' ? browser.renderTickets() : browser.renderAssets());
    app.append(shell);
    return;
  }

  const intro = el('section', 'intro');
  intro.append(el('h1', '', createdTicketId ? 'Ticket already created' : 'Create a ticket'),
    el('p', '', createdTicketId ? 'This email has already been recorded as a Gorelo ticket.' : 'Turn this message into a trackable request. Review the email and choose where it should go.'));
  shell.append(intro);

  if (notice) {
    const alert = el('div', `notice ${notice.kind}`);
    alert.setAttribute('role', 'alert');
    alert.append(icon(notice.kind === 'success' ? 'check' : 'alert'), el('span', '', notice.message));
    shell.append(alert);
  }
  if (!email) {
    shell.append(el('div', 'empty', 'Open an email in Outlook to begin.'));
    app.append(shell);
    return;
  }
  if (checkingCreation) {
    shell.append(el('p', 'browse-empty', 'Checking whether this email already has a ticket…'));
    app.append(shell);
    return;
  }
  if (createdTicketId) {
    const completed = el('section', 'created-ticket');
    completed.append(el('p', '', `Selected email: ${email.subject}`), el('p', '', `Gorelo ticket: ${createdTicketId}`));
    completed.append(el('p', 'form-note', 'The creation form is hidden for this email to help prevent duplicates.'));
    const open = el('button', 'browse-search', 'View this ticket') as HTMLButtonElement;
    open.type = 'button';
    open.addEventListener('click', () => { view = 'tickets'; render(); void browser.showTicket(createdTicketId); });
    completed.append(open); shell.append(completed);
    if (attachmentResult.uncertainAttachmentCount) completed.append(el('p', 'form-note', `${attachmentResult.uncertainAttachmentCount} attachment operation(s) were not confirmed. Review Gorelo manually; these will not be retried automatically.`));
    if (attachmentResult.retryableAttachmentCount || !attachmentResult.attachmentRetryToken && email.attachments.length) {
      const retry = el('button', 'browse-search', attachmentBusy ? 'Checking/uploading attachments…'
        : attachmentResult.attachmentRetryToken ? `Retry ${attachmentResult.retryableAttachmentCount} failed attachment(s)` : 'Recover missing attachments') as HTMLButtonElement;
      retry.type = 'button'; retry.disabled = attachmentBusy || !hasGoreloAuth();
      retry.addEventListener('click', () => { void recoverCreatedAttachments(); }); completed.append(retry);
      completed.append(el('p', 'form-note', 'Uses this existing ticket only. Successful files are not uploaded again. Identical images are deduplicated by file contents.'));
    } else if (attachmentBusy) completed.append(el('p', 'form-note', 'Checking attachment retry status…'));
    app.append(shell);
    return;
  }

  const message = el('section', 'message');
  const messageTitle = el('div', 'section-heading');
  messageTitle.append(el('h2', '', 'Selected email'), el('span', 'section-caption', 'Captured from Outlook'));
  message.append(messageTitle, el('h3', 'subject', email.subject));
  const from = el('div', 'detail-row');
  from.append(el('span', 'detail-label', 'From'), el('span', '', `${email.from.name || email.from.email} <${email.from.email}>`));
  const to = el('div', 'detail-row');
  to.append(el('span', 'detail-label', 'To'), el('span', '', email.to.map((person) => person.email).join(', ') || 'None'));
  const cc = el('div', 'detail-row');
  cc.append(el('span', 'detail-label', 'Cc'), el('span', '', email.cc.map((person) => person.email).join(', ') || 'None'));
  const received = el('div', 'detail-row');
  received.append(el('span', 'detail-label', 'Received'), el('span', '', new Date(email.receivedAt).toLocaleString()));
  message.append(from, to, cc, received);
  const messageId = el('div', 'detail-row');
  messageId.append(el('span', 'detail-label', 'Message ID'), el('span', '', email.internetMessageId || 'Unavailable'));
  message.append(messageId);
  if (email.attachments.length) {
    const attachments = el('div', 'attachments');
    attachments.append(icon('paperclip'), el('span', '', email.attachments.map((item) => item.name).join(', ')));
    message.append(attachments);
  }
  const preview = el('details', 'preview');
  preview.append(el('summary', '', 'Preview message body'), el('p', 'preview-text', email.bodyText || '(Empty message)'));
  message.append(preview);
  const technical = el('details', 'preview');
  technical.append(el('summary', '', 'Outlook IDs and email headers'));
  const technicalText = el('p', 'preview-text', `Outlook item: ${email.outlookItemId || 'Unavailable'}\nConversation: ${email.conversationId || 'Unavailable'}\n\n${email.internetHeaders || 'Headers unavailable'}`);
  technical.append(technicalText);
  message.append(technical);
  shell.append(message);

  const form = el('form', 'form') as HTMLFormElement;
  const heading = el('div', 'section-heading');
  heading.append(el('h2', '', 'Ticket details'), el('span', 'section-caption', 'Required fields marked *'));
  form.append(heading);
  if (options) {
    form.append(field('Team *', options.groups, true, 'groupId'));
    const grid = el('div', 'field-grid');
    grid.append(field('Status *', options.statuses, true, 'statusId'), field('Type *', options.types, true, 'typeId'));
    form.append(grid);
    if (classificationBusy) form.append(el('p', 'form-note', 'Jev is suggesting a Team and Type from the email subject and a short plain-text excerpt…'));
    else if (classificationNote) {
      form.append(el('p', 'form-note', classificationNote));
      if (classificationNote.startsWith('Jev could not') || classificationNote.startsWith('Jev request failed')) {
        const retry = el('button', 'text-action', 'Retry Jev suggestion') as HTMLButtonElement;
        retry.type = 'button'; retry.addEventListener('click', () => { classificationAttempt = ''; void loadClassification(); }); form.append(retry);
      }
    }
    const clientField = field('Client *', options.clients, true, 'clientId');
    clientField.querySelector('select')?.addEventListener('change', (event) => {
      const clientId = (event.target as HTMLSelectElement).value;
      contactRequestId++;
      if (draft.clientId !== clientId) {
        draft.clientId = clientId;
        selectedAgentAssets.clear(); selectedCustomAssets.clear();
        assetRequestId++; createAssetResults = []; createAssetsCursor = ''; createAssetsBusy = false; createAssetsError = '';
        matchedAssetRequestId++; matchedAssetClient = ''; matchedAssets = []; matchedAssetBusy = false; matchedAssetError = '';
        matchedSender = '';
        if (assetPickerOpen && clientId) void loadCreateAssets();
        if (clientId) void loadMatchedAssets();
      }
      render();
    });
    form.append(clientField);
    if (matchedSender) form.append(el('p', 'match-hint', matchedSender));
    form.append(renderParticipants());
    form.append(renderCreateAssets());
  } else {
    form.append(el('p', 'loading', authMode === 'loading' ? 'Checking the secure Gorelo connection…' : authMode === 'error' ? 'Could not check the secure Gorelo connection.' : busy ? 'Loading Gorelo settings…' : !hasGoreloAuth() ? 'Save your Gorelo API key above to load ticket settings.' : 'Gorelo settings are unavailable. Check the connection and retry.'));
    if (authMode === 'error') form.append(authModeFailure());
    if (!busy && hasGoreloAuth()) {
      const retry = el('button', 'retry', 'Retry loading Gorelo settings') as HTMLButtonElement;
      retry.type = 'button';
      retry.addEventListener('click', () => { void loadOptions(); });
      form.append(retry);
    }
  }
  const note = el('p', 'form-note', 'Sender, recipients, date, Outlook IDs and email body are recorded on the ticket. Inline images are attached as files. Original message headers are not copied. Native mail threading is not available.');
  form.append(note);
  const button = el('button', 'submit') as HTMLButtonElement;
  button.type = 'submit';
  button.disabled = busy || authMode !== 'local' && authMode !== 'server' || !hasGoreloAuth() || !options || Boolean(createdTicketId) || creationUnconfirmed;
  button.append(el('span', '', busy ? 'Creating ticket…' : createdTicketId ? 'Ticket created' : creationUnconfirmed ? 'Check Gorelo before retrying' : 'Create ticket'), icon('arrow'));
  form.append(button);
  form.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.name) {
      draft[target.name] = target.value;
    }
  });
  form.addEventListener('submit', submit);
  shell.append(form);
  const footer = el('footer', 'footer', 'Ticket content and attachments are copied to Gorelo. Original email threading remains in Outlook.');
  shell.append(footer);
  app.append(shell);
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  if (!hasGoreloAuth()) {
    const error = new Error(authMode === 'local' ? 'Save your Gorelo API key first.' : 'Check the secure Gorelo connection before retrying.') as Error & { retrySafe?: boolean };
    error.retrySafe = true;
    throw error;
  }
  const headers = new Headers({ 'Content-Type': 'application/json', ...init.headers });
  try {
    (await microsoftHeaders()).forEach((value, key) => headers.set(key, value));
  } catch (cause) {
    authMode = 'error';
    authModeError = cause instanceof Error ? cause.message : 'Microsoft sign-in is required.';
    render();
    const error = new Error(authModeError) as Error & { retrySafe?: boolean };
    error.retrySafe = true; // Nothing was sent to the API.
    throw error;
  }
  if (authMode === 'local' && goreloKey) headers.set('X-Gorelo-Key', goreloKey);
  else headers.delete('X-Gorelo-Key');
  const response = await fetch(path, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      authMode = 'error';
      authModeError = data.error || 'Microsoft sign-in has expired. Sign in again.';
      render();
    }
    const detail = data.issues?.[0]?.message ? ` ${data.issues[0].message}` : '';
    const error = new Error(`${data.error || `Gorelo request failed (${response.status}).`}${detail}`) as Error & { retrySafe?: boolean };
    error.retrySafe = response.status < 500 && data.retrySafe !== false;
    throw error;
  }
  return data;
}

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!email || busy || checkingCreation || createdTicketId || creationUnconfirmed) return;
  const form = event.currentTarget as HTMLFormElement;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const ccRecipients = ticketCcCandidates(email).filter((recipient) => data.getAll('ccEmail').includes(recipient.email)).map((recipient) => {
    const details = ccDraft.get(recipient.email)!;
    return { email: recipient.email, firstName: details.firstName.trim(), lastName: details.lastName.trim() };
  });
  busy = true;
  submitting = true;
  notice = undefined;
  render();
  try {
    const result = await api('/api/tickets', {
      method: 'POST',
      body: JSON.stringify({
        ...email,
        groupId: Number(data.get('groupId')),
        statusId: Number(data.get('statusId')),
        typeId: Number(data.get('typeId')),
        ...(data.get('clientId') ? { clientId: Number(data.get('clientId')) } : {}),
        createSenderContact: true,
        requesterFirstName: senderDraft?.firstName.trim(), requesterLastName: senderDraft?.lastName.trim(),
        ...(data.get('leadAssigneeId') ? { leadAssigneeId: Number(data.get('leadAssigneeId')) } : {}),
        ccRecipients,
        agentAssetIds: [...selectedAgentAssets.keys()],
        customAssetIds: [...selectedCustomAssets.keys()],
      }),
    });
    createdTicketId = result.ticketId;
    attachmentResult = result;
    let recorded = false;
    try { recorded = saveTicketId(localStorage, createdMailKey, result.ticketId, result.attachmentRetryToken); } catch { /* Some Outlook hosts block browser storage. */ }
    notice = { kind: result.partialFailures?.length ? 'error' : 'success', ticketId: result.ticketId,
      message: result.partialFailures?.length
        ? `Ticket ${result.ticketId} was created, but ${result.partialFailures.join(' ')} Use the attachment recovery action below; do not recreate the ticket.${recorded ? '' : ' This device could not remember the ticket result.'}`
        : `Ticket ${result.ticketId} created in Gorelo.${recorded ? '' : ' This device could not remember the result; check Gorelo before creating from this email again after reopening the add-in.'}`,
    };
  } catch (error) {
    const safeToRetry = error instanceof Error && 'retrySafe' in error && error.retrySafe === true;
    creationUnconfirmed = !safeToRetry;
    notice = { kind: 'error', message: `${error instanceof Error ? error.message : 'The request failed.'}${safeToRetry ? ' Correct the issue and try again.' : ' A ticket may still have been created. Check Gorelo before opening the email again to retry.'}` };
  } finally {
    busy = false;
    submitting = false;
    if (pendingSelection) {
      pendingSelection = false;
      void refreshSelectedEmail();
    } else render();
  }
}

async function recoverCreatedAttachments(): Promise<void> {
  if (!email || !createdTicketId || attachmentBusy || !hasGoreloAuth()) return;
  const ticketId = createdTicketId;
  const token = attachmentResult.attachmentRetryToken;
  attachmentBusy = true; submitting = true; notice = undefined; render();
  try {
    const result: AttachmentResult = await api(`/api/tickets/${encodeURIComponent(ticketId)}/attachments/${token ? 'retry' : 'recover'}`, {
      method: 'POST', body: JSON.stringify(token ? { token } : { attachments: email.attachments }),
    });
    attachmentResult = result;
    try { saveTicketId(localStorage, createdMailKey, ticketId, result.attachmentRetryToken); } catch { /* Storage is optional. */ }
    notice = { kind: result.partialFailures?.length ? 'error' : 'success',
      message: result.partialFailures?.length ? `Ticket ${ticketId} is unchanged. ${result.partialFailures.join(' ')}`
        : `Attachments are confirmed on existing ticket ${ticketId}. No new ticket was created.` };
  } catch (error) {
    notice = { kind: 'error', message: `${error instanceof Error ? error.message : 'Attachment recovery failed.'} No new ticket was created.` };
    // Reload the durable write-ahead record before offering another attempt.
    if (token) await loadAttachmentStatus();
  } finally {
    attachmentBusy = false; submitting = false;
    if (pendingSelection) { pendingSelection = false; void refreshSelectedEmail(); } else render();
  }
}

async function loadAttachmentStatus(): Promise<void> {
  const token = attachmentResult.attachmentRetryToken;
  const ticketId = createdTicketId;
  if (!token || !ticketId || !hasGoreloAuth()) return;
  const version = selectionVersion; const key = keyVersion;
  attachmentBusy = true; render();
  try {
    const result: AttachmentResult = await api(`/api/tickets/${encodeURIComponent(ticketId)}/attachments/retry/${encodeURIComponent(token)}`);
    if (version !== selectionVersion || key !== keyVersion || createdTicketId !== ticketId) return;
    attachmentResult = result;
    try { saveTicketId(localStorage, createdMailKey, ticketId, result.attachmentRetryToken); } catch { /* Storage is optional. */ }
  } catch (error) {
    if (version === selectionVersion && key === keyVersion)
      notice = { kind: 'error', message: `Could not verify attachment retry status. ${error instanceof Error ? error.message : ''} Review the existing ticket in Gorelo.` };
  } finally { if (version === selectionVersion && key === keyVersion) { attachmentBusy = false; render(); } }
}

async function loadOptions(): Promise<void> {
  const version = keyVersion;
  busy = true;
  notice = undefined;
  render();
  try { const result = await api('/api/options'); if (version === keyVersion) options = result; }
  catch (error) { if (version === keyVersion) notice = { kind: 'error', message: error instanceof Error ? error.message : 'Could not load Gorelo settings.' }; }
  finally { if (version === keyVersion) { busy = false; render(); } }
  if (version !== keyVersion) return;
  if (options && email) { void loadMatch(); if (!usersLoaded) void loadUsers(); }
  if (options && email) void loadClassification();
}

async function loadClassification(): Promise<void> {
  if (!email || !options || !hasGoreloAuth() || createdTicketId || checkingCreation) return;
  const request = `${keyVersion}:${selectionVersion}`;
  if (classificationAttempt === request) return;
  classificationAttempt = request;
  classificationBusy = true; classificationNote = '';
  const selected = email;
  render();
  try {
    const result: { available: boolean; team?: { id: number; confidence: number }; type?: { id: number; confidence: number } } = await api('/api/classify', {
      method: 'POST', body: JSON.stringify({ subject: selected.subject, bodyText: selected.bodyText.slice(0, 5000) }),
    });
    if (request !== `${keyVersion}:${selectionVersion}` || email !== selected) return;
    if (!result.available) { classificationNote = 'Jev suggestions are off until an OpenCode API key is configured on the server.'; return; }
    const suggestions: string[] = [];
    const team = options?.groups.find(({ id }) => id === result.team?.id);
    const type = options?.types.find(({ id }) => id === result.type?.id);
    if (team && !draft.groupId) { draft.groupId = String(team.id); suggestions.push(`Team: ${team.name}`); }
    if (type && !draft.typeId) { draft.typeId = String(type.id); suggestions.push(`Type: ${type.name}`); }
    classificationNote = suggestions.length ? `Jev suggested ${suggestions.join(' · ')}. Review before creating the ticket.`
      : 'Jev had no confident suggestion, or you already selected Team and Type. Choose them manually.';
  } catch (error) {
    if (request === `${keyVersion}:${selectionVersion}` && email === selected)
      classificationNote = error instanceof Error ? error.message : 'Jev could not classify this email. Select Team and Type manually.';
  } finally {
    if (request === `${keyVersion}:${selectionVersion}` && email === selected) { classificationBusy = false; render(); }
  }
}

async function loadMatch(): Promise<void> {
  if (!email || !hasGoreloAuth()) return;
  browser.beginMatch();
  const from = email.from.email;
  const version = keyVersion;
  const selectedVersion = selectionVersion;
  const contactVersion = contactRequestId;
  try {
    const result: { suggestedClientId?: number; suggestedContactId?: number; suggestedViaDomain?: boolean; ambiguousDomain?: boolean; contacts?: SenderContact[] } = await api(`/api/matches?email=${encodeURIComponent(from)}`);
    if (version !== keyVersion || selectedVersion !== selectionVersion || contactVersion !== contactRequestId || email?.from.email !== from) return;
    browser.setMatches(result.contacts || []);
    if (view === 'tickets') browser.ensureTickets();
    if (view === 'assets') browser.ensureAssets();
    if (draft.clientId) return;
    if (result.ambiguousDomain) {
      matchedSender = 'More than one Gorelo client has this email domain. Choose the client before creating the ticket.';
      render();
      return;
    }
    if (!result.suggestedClientId) return;
    draft.clientId = String(result.suggestedClientId);
    void loadMatchedAssets();
    matchedSender = result.suggestedViaDomain
      ? 'Suggested the client from the sender’s email domain. No matching contact was found; review the client before creating the ticket.'
      : 'Matched the sender to an existing Gorelo contact. Review the client before creating the ticket.';
    render();
  } catch (error) {
    if (version === keyVersion && selectedVersion === selectionVersion && contactVersion === contactRequestId && email?.from.email === from) {
      browser.setMatchError(error instanceof Error ? error.message : 'Connection failed');
    }
  }
}

async function acceptSelectedEmail(selected: Email, version: number): Promise<void> {
  email = selected;
  checkingCreation = true;
  render();
  try {
    const key = await creationKey(selected, Office.context.mailbox.userProfile?.emailAddress || '');
    if (version !== selectionVersion) return;
    createdMailKey = key;
    try {
      createdTicketId = savedTicketId(localStorage, key) || '';
      attachmentResult = { attachmentRetryToken: savedAttachmentRetryToken(localStorage, key) };
    } catch { createdTicketId = ''; attachmentResult = {}; }
  } catch { /* A missing browser digest must not prevent reading the selected email. */ }
  finally {
    if (version === selectionVersion) {
      checkingCreation = false;
      browser.setSender(selected.from.email);
      render();
      if (createdTicketId && attachmentResult.attachmentRetryToken) void loadAttachmentStatus();
    }
  }
}

async function refreshSelectedEmail(): Promise<void> {
  if (submitting) { pendingSelection = true; return; }
  const version = ++selectionVersion;
  assetRequestId++; contactRequestId++; matchedAssetRequestId++;
  email = undefined;
  senderDevicesCache.clear();
  matchedAssetClient = ''; matchedAssets = []; matchedAssetBusy = false; matchedAssetError = '';
  browser.setSender('');
  draft = {}; matchedSender = '';
  classificationNote = ''; classificationBusy = false; classificationAttempt = '';
  ccDraft.clear(); senderDraft = undefined;
  selectedAgentAssets.clear(); selectedCustomAssets.clear();
  createAssetResults = []; createAssetsCursor = ''; createAssetsBusy = false; createAssetsError = ''; assetPickerOpen = false;
  createAssetQuery = '';
  createdTicketId = ''; createdMailKey = undefined; checkingCreation = false; creationUnconfirmed = false;
  attachmentResult = {}; attachmentBusy = false;
  notice = undefined;
  render();
  try {
    const selected = await readSelectedEmail();
    if (version !== selectionVersion) return;
    await acceptSelectedEmail(selected, version);
    if (options && hasGoreloAuth()) { void loadMatch(); if (!usersLoaded) void loadUsers(); void loadClassification(); }
  } catch (error) {
    if (version !== selectionVersion) return;
    notice = { kind: 'error', message: error instanceof Error ? error.message : 'Unable to load the selected email.' };
    render();
  }
}

async function start(): Promise<void> {
  render();
  hostState = await isOutlookHost(typeof Office === 'undefined' ? undefined : Office) ? 'outlook' : 'unavailable';
  render();
  if (hostState !== 'outlook') return;
  await detectAuthMode();
  Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, () => { void refreshSelectedEmail(); });
  try {
    busy = true;
    render();
    const version = ++selectionVersion;
    const [mailResult, optionsResult] = await Promise.allSettled([readSelectedEmail(), hasGoreloAuth() ? api('/api/options') : Promise.resolve(undefined)]);
    if (mailResult.status === 'fulfilled' && version === selectionVersion) await acceptSelectedEmail(mailResult.value, version);
    if (optionsResult.status === 'fulfilled') options = optionsResult.value;
    if (mailResult.status === 'rejected' && version === selectionVersion) throw mailResult.reason;
    if (optionsResult.status === 'rejected') throw optionsResult.reason;
  } catch (error) {
    notice = { kind: 'error', message: error instanceof Error ? error.message : 'Unable to load the email.' };
  } finally { busy = false; render(); }
  if (options && email && hasGoreloAuth()) { void loadMatch(); if (!usersLoaded) void loadUsers(); void loadClassification(); }
}

void start();
