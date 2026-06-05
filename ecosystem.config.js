// PM2 Ecosystem Config — matches your Kalshi bot setup
module.exports = {
  apps: [
    {
      name: 'stock-bot',
      script: 'dist/bot.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/stock-bot-error.log',
      out_file: 'logs/stock-bot-out.log',
      log_file: 'logs/stock-bot-combined.log',
      time: true,
    },
  ],
};
