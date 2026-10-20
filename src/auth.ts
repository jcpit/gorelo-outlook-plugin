import { createNestablePublicClientApplication, InteractionRequiredAuthError, type IPublicClientApplication } from '@azure/msal-browser';

type AuthConfig = { provider: 'local' } | { provider: 'entra'; tenantId: string; clientId: string; scope: string };
let configuration: Promise<AuthConfig> | undefined;
let client: Promise<IPublicClientApplication> | undefined;
let signingIn: Promise<Headers> | undefined;

async function config(): Promise<AuthConfig> {
  if (!configuration) configuration = fetch('/api/auth-config', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('Unable to load Microsoft sign-in configuration.');
    const value = await response.json();
    if (value.provider !== 'local' && (value.provider !== 'entra' ||
        !/^[a-f0-9-]{36}$/i.test(value.tenantId) || !/^[a-f0-9-]{36}$/i.test(value.clientId) ||
        value.scope !== `api://${value.clientId}/access_as_user`)) throw new Error('Invalid Microsoft sign-in configuration.');
    return value as AuthConfig;
  }).catch(error => { configuration = undefined; throw error; });
  return configuration;
}

async function acquire(interactive: boolean): Promise<Headers> {
  const settings = await config();
  const headers = new Headers();
  if (settings.provider === 'local') return headers;
  if (typeof Office === 'undefined' || !Office.context.requirements.isSetSupported('NestedAppAuth', '1.1')) {
    throw new Error('This Outlook version does not support Microsoft nested app sign-in. Update Outlook or use a supported Outlook on the web client.');
  }
  if (!client) client = createNestablePublicClientApplication({
    auth: { clientId: settings.clientId, authority: `https://login.microsoftonline.com/${settings.tenantId}` },
    cache: { cacheLocation: 'memoryStorage' },
  }).catch(error => { client = undefined; throw error; });
  const instance = await client;
  // NAA's broker selects the signed-in Office account. A mailbox address is
  // neither an authentication credential nor an authorization check.
  const request = { scopes: [settings.scope] };
  let result;
  try {
    result = await instance.acquireTokenSilent(request);
  } catch (error) {
    if (!interactive) throw new Error('Microsoft sign-in is required. Select “Sign in with Microsoft” to continue.');
    if (!(error instanceof InteractionRequiredAuthError)) throw error;
    result = await instance.acquireTokenPopup(request);
  }
  if (!result.accessToken) throw new Error('Microsoft did not return an access token.');
  headers.set('Authorization', `Bearer ${result.accessToken}`);
  return headers;
}

export function microsoftHeaders(interactive = false): Promise<Headers> {
  // Coalesce Office startup requests so only one broker interaction is active.
  if (!signingIn) signingIn = acquire(interactive).finally(() => { signingIn = undefined; });
  return signingIn;
}
