import { defineConfig } from 'wxt';

// Fixed public key => fixed extension ID (needed for the Keycloak redirect URI and
// for Group Policy force-install). Keep the matching private key (infra/keys) secret.
const EXTENSION_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAthu2Xo9DP6EkUK42k2w28bkHFQ1gBZBNiuht2WnWW2qctckZLjIbw700t2BpF7iEqtbTl20BfSbSh9zUEyEG6gc/JJB7Rvz2I1VVAW77bJkaivdGIv9mPLkP6jrBqGldlW4kzxeNx7y2zM/J3TaqJhIu8c8nYKnKMjobyP9l0XRL9LruU/kTlXZ1xs4njKvq5bavuyI3z7I6q1AeXD13m6e0nMavwRKwX5Zefuj6uXdoW0AcxYGzUdSnDj1OSw3Ylnyle7gNZT5IN25xPFcUGbTijIqvPPMjBfUYzq8OJPd6i99QlnOB64bRb4yNwNfloKGK1HfSY1lTZO2dM1HbyQIDAQAB';

export default defineConfig({
  manifest: ({ browser }) => ({
    name: 'Office Assistant',
    description: 'Offline AI assistant that operates intranet websites for you.',
    version: '0.1.0',
    ...(browser === 'chrome' ? { key: EXTENSION_KEY } : {}),
    permissions: ['identity', 'storage', 'sidePanel', 'scripting', 'tabs', 'downloads'],
    // <all_urls> is required by Chrome for tabs.captureVisibleTab (audit screenshots). Which sites the
    // agent may act on is enforced by the backend's allowed_sites policy; admins can also limit the
    // extension with the ExtensionSettings runtime_blocked_hosts browser policy.
    host_permissions: ['<all_urls>'],
    storage: { managed_schema: 'managed-schema.json' },
    action: { default_title: 'Office Assistant' },
    ...(browser === 'firefox' ? { browser_specific_settings: { gecko: { id: 'office-assistant@office.local' } } } : {}),
  }),
});
