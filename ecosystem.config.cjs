module.exports = {
    apps: [
        {
            name: "oracle",
            script: "oracle.js",
            autorestart: true,
            max_restarts: 50,
            restart_delay: 5000,
            max_memory_restart: "200M",
            exp_backoff_restart_delay: 100,
            env: { PORT: 3000 }
        },
        {
            name: "monitor",
            script: "monitor.js",
            autorestart: true,
            max_restarts: 50,
            restart_delay: 5000,
            max_memory_restart: "200M",
            exp_backoff_restart_delay: 100,
            env: { PORT: 3001 }
        },
        {
            name: "backup",
            script: "backup.js",
            autorestart: true,
            max_restarts: 50,
            restart_delay: 5000,
            max_memory_restart: "200M",
            exp_backoff_restart_delay: 100,
            env: { PORT: 3002 }
        }
    ]
};
