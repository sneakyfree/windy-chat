/** Environment configuration for Windy Chat web app */
export const env = {
  matrixUrl: import.meta.env.VITE_MATRIX_HOMESERVER || 'https://chat.windyword.ai',
  onboardingUrl: import.meta.env.VITE_ONBOARDING_URL || '/api/v1',
  socialUrl: import.meta.env.VITE_SOCIAL_API_URL || '/api/v1/social',
  mediaUrl: import.meta.env.VITE_MEDIA_URL || '/api/v1/media',
  translateUrl: import.meta.env.VITE_TRANSLATE_URL || '/api/v1/translate',
  directoryUrl: import.meta.env.VITE_DIRECTORY_URL || '/api/v1/chat/directory',
  accountServerUrl: import.meta.env.VITE_ACCOUNT_SERVER_URL || 'https://account.windypro.com',
  eternitasUrl: import.meta.env.VITE_ETERNITAS_URL || 'https://api.eternitas.ai',
  windyWordWs: import.meta.env.VITE_WINDY_WORD_WS || 'wss://windyword.ai',
  windyMailUrl: import.meta.env.VITE_WINDY_MAIL_URL || 'https://windymail.ai',
  appName: 'Windy Chat',
  serverName: 'chat.windyword.ai',
};
