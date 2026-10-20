import { icon } from './icons';
import { statusStyle, type TicketStatus } from './ticket-status';
import type { Email } from './mail';
import { presenceLabel } from './asset-presence';

export type Option = { id: number; name: string };
export type AssetKind = 'agent' | 'custom';
export type AssetItem = { id: string; name: string; kind: AssetKind; clientId?: number; details?: Record<string, string> };
export type TicketSummary = { id: string; displayNumber?: string; title: string; statusName?: string; statusId?: number; clientName?: string; updatedOn?: string };
export type SenderContact = { id: number; name: string; clientId?: number; email: string };
export type TicketDetail = TicketSummary & {
  descriptionText?: string; clientId?: number; contactName?: string; priorityName?: string;
  createdOn?: string; agentAssetIds?: string[]; customAssetIds?: string[];
  linkedAssets?: AssetItem[];
};
type Comment = { id: string; bodyText?: string; bodyHtml?: string; createdOn?: string; conversationTypeId?: number; createdByName?: string };
type Page<T> = { items: T[]; nextCursor?: string | null };
type Api = (path: string, init?: RequestInit) => Promise<any>;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}
function action(text: string, onClick: () => void, className = 'text-action'): HTMLButtonElement {
  const button = node('button', className, text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}
function date(value?: string): string {
  if (!value) return '';
  const result = new Date(value);
  return Number.isNaN(result.valueOf()) ? value : result.toLocaleString();
}
function heading(title: string, description: string): HTMLElement {
  const section = node('div', 'browse-heading');
  section.append(node('h1', '', title), node('p', '', description));
  return section;
}

export class BrowsePane {
  private tickets: TicketSummary[] = [];
  private ticketsLoaded = false;
  private ticketsBusy = false;
  private ticketsError = '';
  private ticketsCursor = '';
  private ticketsQuery = '';
  private ticketRequest = 0;
  private contactDevices: AssetItem[] = [];
  private contactDevicesLoaded = false;
  private contactDevicesBusy = false;
  private contactDevicesError = '';
  private contactDevicesRequest = 0;
  private detailRequest = 0;
  private senderEmail = '';
  private contactsLoaded = false;
  private contactsError = '';
  private senderContacts: SenderContact[] = [];
  private contactId = 0;
  private companyClient = '';
  private scope: 'contact' | 'company' = 'contact';
  private selectedTicket?: TicketDetail;
  private comments: Comment[] = [];
  private commentsCursor = '';
  private ticketBusy = false;
  private ticketError = '';
  private attachConfirm = false;
  private attachBusy = false;
  private attachNotice = '';
  private attachUnconfirmed = false;
  private attachedEmailTickets = new Set<string>();

  private assets: AssetItem[] = [];
  private assetsLoaded = false;
  private assetsBusy = false;
  private assetsError = '';
  private assetsCursor = '';
  private assetsQuery = '';
  private assetRequest = 0;
  private assetDetailRequest = 0;
  private assetsKind: AssetKind = 'agent';
  private selectedAsset?: AssetItem;
  private selectedAssetBusy = false;

  constructor(private api: Api, private clients: () => Option[], private statuses: () => TicketStatus[], private currentEmail: () => Email | undefined, private allowAttach: () => boolean, private refresh: () => void, private switchToAssets: () => void, private retryMatch: () => void) {}

  private statusBadge(ticket: TicketSummary): HTMLElement | undefined {
    if (!ticket.statusName) return undefined;
    const badge = node('span', 'ticket-status', ticket.statusName);
    const style = statusStyle(ticket.statusId, ticket.statusName, this.statuses());
    if (style) Object.assign(badge.style, style);
    return badge;
  }

  beginMatch(): void { this.contactsLoaded = false; this.contactsError = ''; this.refresh(); }

  setSender(email: string): void {
    this.senderEmail = email.trim().toLowerCase();
    this.contactsLoaded = false;
    this.contactsError = '';
    this.senderContacts = [];
    this.contactId = 0;
    this.companyClient = '';
    this.scope = 'contact';
    this.ticketsQuery = '';
    this.assetsQuery = '';
    this.reset();
  }

  setMatches(contacts: SenderContact[]): void {
    this.senderContacts = contacts;
    this.contactsLoaded = true;
    this.contactsError = '';
    this.selectContact(contacts.length === 1 ? contacts[0]!.id : 0);
  }

  setMatchError(message: string): void {
    this.contactsLoaded = true;
    this.contactsError = message;
    this.reset();
  }

  private selectContact(id: number): void {
    this.contactId = id;
    const contact = this.senderContacts.find((item) => item.id === id);
    this.companyClient = contact?.clientId ? String(contact.clientId) : '';
    this.reset();
  }

  private get selectedContact(): SenderContact | undefined {
    return this.senderContacts.find((item) => item.id === this.contactId);
  }

  private get scopeReady(): boolean {
    return this.scope === 'contact' ? Boolean(this.selectedContact) : Boolean(this.companyClient);
  }

  private get assetsReady(): boolean {
    return this.scopeReady && (this.scope === 'company' || Boolean(this.selectedContact?.clientId));
  }

  reset(): void {
    this.ticketRequest++; this.detailRequest++; this.assetRequest++; this.assetDetailRequest++; this.contactDevicesRequest++;
    this.tickets = []; this.ticketsLoaded = false; this.selectedTicket = undefined;
    this.contactDevices = []; this.contactDevicesLoaded = false; this.contactDevicesBusy = false; this.contactDevicesError = '';
    this.assets = []; this.assetsLoaded = false; this.selectedAsset = undefined;
    this.ticketsCursor = ''; this.assetsCursor = ''; this.comments = [];
    this.ticketsBusy = false; this.ticketBusy = false; this.assetsBusy = false; this.selectedAssetBusy = false;
    this.ticketsError = ''; this.ticketError = ''; this.assetsError = '';
    this.attachConfirm = false; this.attachNotice = ''; this.attachUnconfirmed = false;
    this.refresh();
  }

  ensureTickets(): void {
    if (!this.scopeReady) return;
    if (!this.ticketsLoaded && !this.ticketsBusy) void this.loadTickets(true);
    if (this.scope === 'contact' && this.selectedContact?.clientId && !this.contactDevicesLoaded && !this.contactDevicesBusy) void this.loadContactDevices();
  }
  ensureAssets(): void { if (this.assetsReady && !this.assetsLoaded && !this.assetsBusy && (this.scope === 'company' || this.assetsKind === 'agent')) void this.loadAssets(true); }

  private async loadTickets(reset: boolean): Promise<void> {
    if (!this.scopeReady) return;
    if (this.ticketsBusy && !reset) return;
    const version = ++this.ticketRequest;
    this.ticketsBusy = true; this.ticketsError = ''; this.refresh();
    try {
      const params = new URLSearchParams();
      if (this.ticketsQuery) params.set('query', this.ticketsQuery);
      if (this.companyClient) params.set('clientId', this.companyClient);
      if (this.scope === 'contact') params.set('contactId', String(this.contactId));
      if (!reset && this.ticketsCursor) params.set('cursor', this.ticketsCursor);
      const result: Page<TicketSummary> = await this.api(`/api/tickets?${params}`);
      if (version !== this.ticketRequest) return;
      this.tickets = reset ? result.items : [...this.tickets, ...result.items];
      this.ticketsCursor = result.nextCursor || '';
      this.ticketsLoaded = true;
    } catch (error) { if (version === this.ticketRequest) this.ticketsError = error instanceof Error ? error.message : 'Could not load tickets.'; }
    finally { if (version === this.ticketRequest) { this.ticketsBusy = false; this.refresh(); } }
  }

  private async loadContactDevices(): Promise<void> {
    if (!this.selectedContact?.clientId || !this.senderEmail) return;
    const version = ++this.contactDevicesRequest;
    this.contactDevicesBusy = true; this.contactDevicesError = ''; this.refresh();
    try {
      const params = new URLSearchParams({ kind: 'agent', clientId: String(this.selectedContact.clientId), userEmail: this.senderEmail });
      const result: Page<AssetItem> = await this.api(`/api/assets?${params}`);
      if (version !== this.contactDevicesRequest) return;
      this.contactDevices = result.items;
      this.contactDevicesLoaded = true;
    } catch (error) { if (version === this.contactDevicesRequest) this.contactDevicesError = error instanceof Error ? error.message : 'Could not load sender devices.'; }
    finally { if (version === this.contactDevicesRequest) { this.contactDevicesBusy = false; this.refresh(); } }
  }

  async showTicket(id: string): Promise<void> {
    const version = ++this.detailRequest;
    this.attachConfirm = false; this.attachNotice = ''; this.attachUnconfirmed = false;
    this.ticketBusy = true; this.ticketError = ''; this.selectedTicket = undefined; this.refresh();
    try {
      const [ticket, conversation] = await Promise.all([
        this.api(`/api/tickets/${encodeURIComponent(id)}`),
        this.api(`/api/tickets/${encodeURIComponent(id)}/comments`),
      ]);
      if (version !== this.detailRequest) return;
      this.selectedTicket = ticket as TicketDetail;
      this.comments = (conversation as Page<Comment>).items;
      this.commentsCursor = (conversation as Page<Comment>).nextCursor || '';
    } catch (error) { if (version === this.detailRequest) this.ticketError = error instanceof Error ? error.message : 'Could not open the ticket.'; }
    finally { if (version === this.detailRequest) { this.ticketBusy = false; this.refresh(); } }
  }

  private async attachEmail(ticket: TicketDetail): Promise<void> {
    const email = this.currentEmail();
    if (!email || !this.allowAttach() || this.attachBusy || this.attachedEmailTickets.has(ticket.id)) return;
    this.attachBusy = true; this.attachConfirm = false; this.attachNotice = ''; this.refresh();
    try {
      const result: { partialFailures?: string[] } = await this.api(`/api/tickets/${encodeURIComponent(ticket.id)}/emails`, {
        method: 'POST', body: JSON.stringify(email),
      });
      if (this.currentEmail() !== email) return;
      this.attachedEmailTickets.add(ticket.id);
      this.attachNotice = result.partialFailures?.length
        ? `Email added to ${ticket.displayNumber || ticket.id}, but some attachments failed: ${result.partialFailures.join(' ')} Check Gorelo before retrying.`
        : `Email attached to ${ticket.displayNumber || ticket.id}.`;
      if (this.selectedTicket?.id === ticket.id) {
        try {
          const conversation: Page<Comment> = await this.api(`/api/tickets/${encodeURIComponent(ticket.id)}/comments`);
          if (this.currentEmail() === email && this.selectedTicket?.id === ticket.id) {
            this.comments = conversation.items;
            this.commentsCursor = conversation.nextCursor || '';
          }
        } catch { /* The write succeeded; conversation can be refreshed by reopening the ticket. */ }
      }
    } catch (error) {
      if (this.currentEmail() !== email) return;
      const retrySafe = error instanceof Error && 'retrySafe' in error && error.retrySafe === true;
      this.attachUnconfirmed = !retrySafe;
      this.attachNotice = `${error instanceof Error ? error.message : 'Could not attach the email.'}${retrySafe ? '' : ' Check Gorelo before retrying; the comment may already exist.'}`;
    } finally { this.attachBusy = false; this.refresh(); }
  }

  private async moreComments(): Promise<void> {
    if (!this.selectedTicket || !this.commentsCursor || this.ticketBusy) return;
    const id = this.selectedTicket.id;
    const version = this.detailRequest;
    this.ticketBusy = true; this.refresh();
    try {
      const params = new URLSearchParams({ cursor: this.commentsCursor });
      const result: Page<Comment> = await this.api(`/api/tickets/${encodeURIComponent(id)}/comments?${params}`);
      if (version !== this.detailRequest) return;
      this.comments.push(...result.items); this.commentsCursor = result.nextCursor || '';
    } catch (error) { if (version === this.detailRequest) this.ticketError = error instanceof Error ? error.message : 'Could not load more comments.'; }
    finally { if (version === this.detailRequest) { this.ticketBusy = false; this.refresh(); } }
  }

  private clientPicker(value: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = node('select') as HTMLSelectElement;
    select.setAttribute('aria-label', 'Choose company');
    const empty = node('option', '', 'Choose a company'); empty.value = ''; select.append(empty);
    for (const client of this.clients()) {
      const option = node('option', '', client.name); option.value = String(client.id); select.append(option);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  private scopeControls(kind: 'tickets' | 'assets'): HTMLElement {
    const wrapper = node('div', 'browse-scope');
    const tabs = node('div', 'kind-tabs');
    for (const [scope, label] of [['contact', 'This contact'], ['company', 'All company']] as const) {
      const tab = action(label, () => {
        if (this.scope === scope) return;
        this.scope = scope;
        if (scope === 'contact') this.assetsKind = 'agent';
        this.reset();
        if (kind === 'tickets') this.ensureTickets(); else this.ensureAssets();
      }, `kind-tab${this.scope === scope ? ' active' : ''}`);
      if (this.scope === scope) tab.setAttribute('aria-current', 'page');
      tabs.append(tab);
    }
    wrapper.append(tabs);
    if (this.scope === 'contact') {
      if (!this.contactsLoaded) wrapper.append(node('p', 'browse-empty', 'Finding the email sender in Gorelo…'));
      else if (this.contactsError) wrapper.append(node('p', 'browse-error', `Could not match the sender: ${this.contactsError}`), action('Retry sender match', this.retryMatch));
      else if (!this.senderContacts.length) wrapper.append(node('p', 'browse-empty', `No Gorelo contact matches ${this.senderEmail || 'this sender'}. Choose All company and select a company to browse.`));
      else if (this.senderContacts.length > 1 || !this.selectedContact?.clientId) {
        const select = node('select') as HTMLSelectElement;
        select.setAttribute('aria-label', 'Choose matching contact');
        const empty = node('option', '', 'Choose a contact'); empty.value = ''; select.append(empty);
        for (const contact of this.senderContacts) {
          const option = node('option', '', `${contact.name}${contact.clientId ? ` · ${this.clients().find((client) => client.id === contact.clientId)?.name || 'Company'}` : ' · No company'}`);
          option.value = String(contact.id); select.append(option);
        }
        select.value = String(this.contactId || '');
        select.addEventListener('change', () => {
          this.selectContact(Number(select.value));
          if (kind === 'tickets') this.ensureTickets(); else this.ensureAssets();
        });
        wrapper.append(select);
      }
      if (this.selectedContact?.clientId) wrapper.append(node('p', 'scope-caption', `${this.selectedContact.name} · ${this.clients().find((client) => client.id === this.selectedContact?.clientId)?.name || 'Company'}`));
    } else {
      wrapper.append(this.clientPicker(this.companyClient, (value) => {
        this.companyClient = value; this.reset();
        if (kind === 'tickets') this.ensureTickets(); else this.ensureAssets();
      }));
    }
    return wrapper;
  }

  renderTickets(): HTMLElement {
    const section = node('section', 'browse-view');
    if (this.selectedTicket || this.ticketBusy || this.ticketError) {
      const back = action('Back to tickets', () => { this.detailRequest++; this.selectedTicket = undefined; this.ticketError = ''; this.ticketBusy = false; this.refresh(); });
      back.prepend(icon('back'));
      section.append(back);
      if (this.ticketBusy && !this.selectedTicket) section.append(node('p', 'browse-empty', 'Loading ticket…'));
      if (this.ticketError) section.append(node('p', 'browse-error', this.ticketError));
      if (this.selectedTicket) section.append(this.renderTicketDetail(this.selectedTicket));
      return section;
    }
    section.append(heading('Tickets', 'Tickets for this email’s contact, or all tickets for their company. Open a ticket to see linked assets and conversation.'));
    section.append(this.scopeControls('tickets'));
    if (!this.scopeReady) return section;
    const form = node('form', 'browse-filters');
    const input = node('input') as HTMLInputElement;
    input.type = 'search'; input.placeholder = 'Search title or ticket number'; input.value = this.ticketsQuery;
    input.setAttribute('aria-label', 'Search tickets');
    input.addEventListener('input', () => { this.ticketsQuery = input.value; });
    form.append(input);
    const submit = node('button', 'browse-search', 'Search') as HTMLButtonElement;
    submit.type = 'submit'; form.append(submit);
    form.addEventListener('submit', (event) => { event.preventDefault(); this.ticketsQuery = input.value.trim(); void this.loadTickets(true); });
    section.append(form);
    if (this.ticketsError) section.append(node('p', 'browse-error', this.ticketsError), action('Retry tickets', () => { void this.loadTickets(true); }));
    if (this.ticketsBusy && !this.tickets.length) section.append(node('p', 'browse-empty', 'Loading tickets…'));
    if (this.ticketsLoaded && !this.ticketsBusy && !this.tickets.length) section.append(node('p', 'browse-empty', 'No tickets match this contact or search. Try a shorter title or switch to All company.'));
    const list = node('div', 'browse-list');
    for (const ticket of this.tickets) {
      const row = action('', () => { void this.showTicket(ticket.id); }, 'browse-row');
      const title = node('strong', '', ticket.title || 'Untitled ticket');
      const meta = node('span', 'row-meta');
      if (ticket.displayNumber) meta.append(node('span', '', ticket.displayNumber));
      const badge = this.statusBadge(ticket);
      if (badge) meta.append(badge);
      if (ticket.clientName) meta.append(node('span', '', ticket.clientName));
      row.append(title, meta);
      if (ticket.updatedOn) row.append(node('span', 'row-time', `Updated ${date(ticket.updatedOn)}`));
      list.append(row);
    }
    section.append(list);
    if (this.ticketsCursor) { const more = action(this.ticketsBusy ? 'Loading…' : 'Load more tickets', () => { void this.loadTickets(false); }); more.disabled = this.ticketsBusy; section.append(more); }
    if (this.scope === 'contact' && this.selectedContact?.clientId) {
      const related = node('div', 'contact-devices');
      related.append(node('h2', '', 'Devices last used by this contact'));
      related.append(node('p', 'scope-caption', 'Matched by last logged-on email; this does not establish formal ownership.'));
      if (this.contactDevicesBusy) related.append(node('p', 'browse-empty', 'Loading sender devices…'));
      if (this.contactDevicesError) related.append(node('p', 'browse-error', this.contactDevicesError), action('Retry devices', () => { void this.loadContactDevices(); }));
      if (this.contactDevicesLoaded && !this.contactDevices.length) related.append(node('p', 'browse-empty', 'No devices show this sender as the last logged-on user.'));
      for (const asset of this.contactDevices) {
        const device = action('', () => { this.switchToAssets(); void this.openAsset(asset); }, 'browse-row');
        const title = node('strong', 'asset-name', asset.name);
        const presence = presenceLabel(asset.details?.statusName);
        if (presence) title.append(presence);
        device.append(title, node('span', 'row-meta', asset.details?.lastLoggedOnUser || asset.details?.lastLoggedOnUserUpn || this.senderEmail));
        related.append(device);
      }
      section.append(related);
    }
    return section;
  }

  private renderTicketDetail(ticket: TicketDetail): HTMLElement {
    const content = node('article', 'browse-detail');
    content.append(node('h1', '', ticket.title || 'Untitled ticket'));
    const facts = node('dl', 'fact-list');
    const pairs: Array<[string, string | undefined]> = [
      ['Ticket', ticket.displayNumber || ticket.id],
      ['Client', ticket.clientName], ['Requester', ticket.contactName],
      ['Priority', ticket.priorityName], ['Created', date(ticket.createdOn)], ['Updated', date(ticket.updatedOn)],
    ];
    for (const [label, value] of pairs) {
      if (value) facts.append(node('dt', '', label), node('dd', '', value));
      if (label === 'Ticket' && ticket.statusName) {
        const status = node('dd');
        status.append(this.statusBadge(ticket)!);
        facts.append(node('dt', '', 'Status'), status);
      }
    }
    content.append(facts);
    const email = this.currentEmail();
    if (this.allowAttach() && email) {
      const attach = node('section', 'attach-email');
      attach.append(node('h2', '', 'Selected Outlook email'));
      attach.append(node('p', 'scope-caption', `${email.subject} · ${email.from.email} · ${email.attachments.length} attachment${email.attachments.length === 1 ? '' : 's'}`));
      if (this.attachNotice) attach.append(node('p', this.attachUnconfirmed || !this.attachedEmailTickets.has(ticket.id) || this.attachNotice.includes('failed:') ? 'browse-error' : 'match-hint', this.attachNotice));
      if (this.attachUnconfirmed) attach.append(node('p', 'scope-caption', 'Reopen the ticket in Gorelo to check whether the email was added before trying again.'));
      if (!this.attachedEmailTickets.has(ticket.id) && !this.attachUnconfirmed) {
        if (this.attachConfirm) {
          attach.append(node('p', 'scope-caption', `Add this email and its attachments to ticket ${ticket.displayNumber || ticket.id}? This will create a comment in Gorelo; it will not send a reply or enable native email threading.`));
          const confirm = action(this.attachBusy ? 'Attaching…' : 'Confirm attach to this ticket', () => { void this.attachEmail(ticket); }, 'browse-search');
          confirm.disabled = this.attachBusy;
          attach.append(confirm, action('Cancel', () => { this.attachConfirm = false; this.refresh(); }));
        } else {
          const button = action(this.attachBusy ? 'Attaching…' : 'Attach selected email to this ticket', () => { this.attachConfirm = true; this.refresh(); }, 'browse-search');
          button.disabled = this.attachBusy;
          attach.append(button);
        }
      }
      content.append(attach);
    }
    if (ticket.descriptionText) {
      content.append(node('h2', '', 'Description'), node('p', 'detail-body', ticket.descriptionText));
    }
    content.append(node('h2', '', 'Linked assets'));
    const linked: AssetItem[] = ticket.linkedAssets || [
      ...(ticket.agentAssetIds || []).map((id) => ({ id, name: id, kind: 'agent' as const })),
      ...(ticket.customAssetIds || []).map((id) => ({ id, name: id, kind: 'custom' as const })),
    ];
    if (!linked.length) content.append(node('p', 'browse-empty', 'No assets linked to this ticket.'));
    else {
      const assetList = node('ul', 'linked-list');
      for (const asset of linked) {
        const item = node('li');
        const button = action('', () => {
          this.switchToAssets();
          void this.openAsset(asset);
        }, 'linked-asset-action');
        button.append(document.createTextNode(`${asset.name} · ${asset.kind === 'agent' ? 'Managed device' : 'Custom asset'}`));
        if (asset.kind === 'agent') { const presence = presenceLabel(asset.details?.statusName); if (presence) button.append(presence); }
        item.append(button);
        assetList.append(item);
      }
      content.append(assetList);
    }
    content.append(node('h2', '', 'Conversation'));
    if (!this.comments.length && !this.ticketBusy) content.append(node('p', 'browse-empty', 'No comments on this ticket yet.'));
    const thread = node('div', 'conversation');
    for (const comment of this.comments) {
      const item = node('article', 'conversation-item');
      item.append(node('div', 'conversation-by', [comment.createdByName || 'Gorelo', date(comment.createdOn)].filter(Boolean).join(' · ')));
      item.append(node('p', 'detail-body', comment.bodyText || (comment.bodyHtml ? 'This comment contains formatted content; open it in Gorelo to read it.' : '(Empty comment)')));
      thread.append(item);
    }
    content.append(thread);
    if (this.commentsCursor) { const more = action(this.ticketBusy ? 'Loading…' : 'More comments', () => { void this.moreComments(); }); more.disabled = this.ticketBusy; content.append(more); }
    return content;
  }

  private async loadAssets(reset: boolean): Promise<void> {
    if (!this.assetsReady || (this.scope === 'contact' && this.assetsKind !== 'agent')) return;
    if (this.assetsBusy && !reset) return;
    const version = ++this.assetRequest;
    this.assetsBusy = true; this.assetsError = ''; this.refresh();
    try {
      const params = new URLSearchParams({ kind: this.assetsKind });
      if (this.assetsQuery) params.set('query', this.assetsQuery);
      if (this.companyClient) params.set('clientId', this.companyClient);
      if (this.scope === 'contact') params.set('userEmail', this.senderEmail);
      if (!reset && this.assetsCursor) params.set('cursor', this.assetsCursor);
      const result: Page<AssetItem> = await this.api(`/api/assets?${params}`);
      if (version !== this.assetRequest) return;
      this.assets = reset ? result.items : [...this.assets, ...result.items];
      this.assetsCursor = result.nextCursor || '';
      this.assetsLoaded = true;
    } catch (error) { if (version === this.assetRequest) this.assetsError = error instanceof Error ? error.message : 'Could not load assets.'; }
    finally { if (version === this.assetRequest) { this.assetsBusy = false; this.refresh(); } }
  }

  private async openAsset(asset: AssetItem): Promise<void> {
    const version = ++this.assetDetailRequest;
    this.selectedAsset = asset; this.selectedAssetBusy = true; this.refresh();
    try { const result = await this.api(`/api/assets/${asset.kind}/${encodeURIComponent(asset.id)}`); if (version === this.assetDetailRequest) this.selectedAsset = result; }
    catch (error) { if (version === this.assetDetailRequest) this.assetsError = error instanceof Error ? error.message : 'Could not load asset details.'; }
    finally { if (version === this.assetDetailRequest) { this.selectedAssetBusy = false; this.refresh(); } }
  }

  renderAssets(): HTMLElement {
    const section = node('section', 'browse-view');
    if (this.selectedAsset) {
      const back = action('Back to assets', () => { this.assetDetailRequest++; this.selectedAsset = undefined; this.selectedAssetBusy = false; this.assetsError = ''; this.refresh(); });
      back.prepend(icon('back'));
      section.append(back);
      const asset = this.selectedAsset;
      const details = node('article', 'browse-detail');
      details.append(node('h1', '', asset.name || 'Unnamed asset'), node('p', 'detail-subtitle', asset.kind === 'agent' ? 'Managed device' : 'Custom asset'));
      if (asset.kind === 'agent') { const presence = presenceLabel(asset.details?.statusName); if (presence) details.append(presence); }
      if (this.selectedAssetBusy) details.append(node('p', 'browse-empty', 'Loading asset details…'));
      if (this.assetsError) details.append(node('p', 'browse-error', this.assetsError));
      const facts = node('dl', 'fact-list');
      facts.append(node('dt', '', 'Asset ID'), node('dd', '', asset.id));
      for (const [key, value] of Object.entries(asset.details || {})) if (value) facts.append(node('dt', '', key), node('dd', '', String(value)));
      details.append(facts); section.append(details);
      return section;
    }
    section.append(heading('Assets', 'See devices last used by this email’s sender, or browse all company assets.'));
    section.append(this.scopeControls('assets'));
    if (!this.scopeReady) return section;
    if (!this.assetsReady) { section.append(node('p', 'browse-empty', 'This contact has no company in Gorelo, so its devices cannot be searched.')); return section; }
    const kindTabs = node('div', 'kind-tabs');
    for (const kind of ['agent', 'custom'] as const) {
      if (this.scope === 'contact' && kind === 'custom') continue;
      const tab = action(kind === 'agent' ? 'Managed devices' : 'Custom assets', () => {
        this.assetsKind = kind; this.assets = []; this.assetsCursor = ''; this.assetsLoaded = false; void this.loadAssets(true);
      }, `kind-tab${this.assetsKind === kind ? ' active' : ''}`);
      if (this.assetsKind === kind) tab.setAttribute('aria-current', 'page');
      kindTabs.append(tab);
    }
    section.append(kindTabs);
    if (this.scope === 'contact') section.append(node('p', 'scope-caption', 'Matched by last logged-on email, not a formal asset assignment. Custom assets are available under All company.'));
    const form = node('form', 'browse-filters');
    const input = node('input') as HTMLInputElement;
    input.type = 'search'; input.placeholder = 'Search assets'; input.value = this.assetsQuery;
    input.setAttribute('aria-label', 'Search assets');
    input.addEventListener('input', () => { this.assetsQuery = input.value; });
    form.append(input);
    const submit = node('button', 'browse-search', 'Search') as HTMLButtonElement;
    submit.type = 'submit'; form.append(submit);
    form.addEventListener('submit', (event) => { event.preventDefault(); this.assetsQuery = input.value.trim(); void this.loadAssets(true); });
    section.append(form);
    if (this.assetsError) section.append(node('p', 'browse-error', this.assetsError), action('Retry assets', () => { void this.loadAssets(true); }));
    if (this.assetsBusy && !this.assets.length) section.append(node('p', 'browse-empty', 'Loading assets…'));
    if (this.assetsLoaded && !this.assetsBusy && !this.assets.length) section.append(node('p', 'browse-empty', 'No matching devices found. Try All company to browse every company asset.'));
    const list = node('div', 'browse-list');
    for (const asset of this.assets) {
      const row = action('', () => { void this.openAsset(asset); }, 'browse-row');
      const name = node('strong', 'asset-name', asset.name || 'Unnamed asset');
      if (asset.kind === 'agent') { const presence = presenceLabel(asset.details?.statusName); if (presence) name.append(presence); }
      row.append(name, node('span', 'row-meta', asset.kind === 'agent' ? 'Managed device' : 'Custom asset'));
      if (asset.details?.lastLoggedOnUserUpn || asset.details?.lastLoggedOnUser) row.append(node('span', 'row-meta', `Last logged on: ${asset.details.lastLoggedOnUser || asset.details.lastLoggedOnUserUpn}`));
      list.append(row);
    }
    section.append(list);
    if (this.assetsCursor) { const more = action(this.assetsBusy ? 'Loading…' : 'Load more assets', () => { void this.loadAssets(false); }); more.disabled = this.assetsBusy; section.append(more); }
    return section;
  }
}
