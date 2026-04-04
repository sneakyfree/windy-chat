/** Environment configuration for Windy Chat web app */
export const env = {
  /** Synapse homeserver URL */
  matrixUrl: import.meta.env.VITE_MATRIX_URL || 'https://chat.windypro.com',
  /** Onboarding service */
  onboardingUrl: import.meta.env.VITE_ONBOARDING_URL || '/api/v1',
  /** Social service */
  socialUrl: import.meta.env.VITE_SOCIAL_URL || '/api/v1/social',
  /** Media service */
  mediaUrl: import.meta.env.VITE_MEDIA_URL || '/api/v1/media',
  /** Translation service */
  translateUrl: import.meta.env.VITE_TRANSLATE_URL || '/api/v1/translate',
  /** Windy Pro account server */
  accountServerUrl: import.meta.env.VITE_ACCOUNT_SERVER_URL || 'https://api.windypro.com',
  /** App name */
  appName: 'Windy Chat',
  /** Matrix server name */
  serverName: 'chat.windypro.com',
};
