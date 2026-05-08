module.exports = {
    apps: [
        {
            name: "oracle",
            script: "oracle.js",
            autorestart: true,
            max_restarts: 50,
            restart_delay: 5000,
            max_memory_restart: "400M",
            exp_backoff_restart_delay: 100,
            env: { PORT: 3000, SERVICE_NAME: "oracle" }
        },
        {
            name: "monitor",
            script: "monitor.js",
            autorestart: true,
            max_restarts: 50,
            restart_delay: 5000,
            max_memory_restart: "400M",
            exp_backoff_restart_delay: 100,
            env: { PORT: 3001, SERVICE_NAME: "monitor" }
        },
        {
            name: "backup",
            script: "backup.js",
            autorestart: true,
            max_restarts: 50,
            restart_delay: 5000,
            max_memory_restart: "400M",
            exp_backoff_restart_delay: 100,
            env: { PORT: 3002, SERVICE_NAME: "backup" }
        },
        {
            name: "bot",
            script: "telegram-bot.js",
            autorestart: true,
            max_restarts: 50,
            restart_delay: 5000,
            max_memory_restart: "400M",
            exp_backoff_restart_delay: 100,
            env: { BOT_PORT: 8080, SERVICE_NAME: "bot" }
        }
    ]
};
