/**
 * Windy Chat — PM2 Ecosystem Configuration
 *
 * Start all services:   pm2 start ecosystem.config.js
 * Start one service:    pm2 start ecosystem.config.js --only windy-onboarding
 * View logs:            pm2 logs
 * Monitor:              pm2 monit
 * Restart all:          pm2 restart all
 * Stop all:             pm2 stop all
 */

module.exports = {
  apps: [
    {
      name: 'windy-onboarding',
      script: 'services/onboarding/server.js',
      env: {
        PORT: 8101,
        NODE_ENV: 'production',
      },
      instances: 1,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/onboarding-error.log',
      out_file: 'logs/onboarding-out.log',
      merge_logs: true,
    },
    {
      name: 'windy-directory',
      script: 'services/directory/server.js',
      env: {
        PORT: 8102,
        NODE_ENV: 'production',
      },
      instances: 1,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/directory-error.log',
      out_file: 'logs/directory-out.log',
      merge_logs: true,
    },
    {
      name: 'windy-push-gateway',
      script: 'services/push-gateway/server.js',
      env: {
        PORT: 8103,
        NODE_ENV: 'production',
      },
      instances: 1,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/push-gateway-error.log',
      out_file: 'logs/push-gateway-out.log',
      merge_logs: true,
    },
    {
      name: 'windy-backup',
      script: 'services/backup/server.js',
      env: {
        PORT: 8104,
        NODE_ENV: 'production',
      },
      instances: 1,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/backup-error.log',
      out_file: 'logs/backup-out.log',
      merge_logs: true,
    },
    {
      name: 'windy-social',
      script: 'services/social/server.js',
      env: {
        PORT: 8105,
        NODE_ENV: 'production',
      },
      instances: 1,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/social-error.log',
      out_file: 'logs/social-out.log',
      merge_logs: true,
    },
    {
      name: 'windy-translation',
      script: 'services/translation/server.js',
      env: {
        PORT: 8106,
        NODE_ENV: 'production',
      },
      instances: 1,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/translation-error.log',
      out_file: 'logs/translation-out.log',
      merge_logs: true,
    },
    {
      name: 'windy-media',
      script: 'services/media/server.js',
      env: {
        PORT: 8107,
        NODE_ENV: 'production',
      },
      instances: 1,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/media-error.log',
      out_file: 'logs/media-out.log',
      merge_logs: true,
    },
    {
      name: 'windy-call-history',
      script: 'services/call-history/server.js',
      env: {
        PORT: 8108,
        NODE_ENV: 'production',
      },
      instances: 1,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/call-history-error.log',
      out_file: 'logs/call-history-out.log',
      merge_logs: true,
    },
  ],
};
