import http from 'http';
import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// ─── Configuration ───────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const PORT = process.env.BOT_PORT || 8080;

// Wallet addresses to monitor (use public addresses, not private keys)
const WALLETS = {};
if (process.env.ORACLE_ADDRESS) WALLETS.oracle = process.env.ORACLE_ADDRESS;
if (process.env.MONITOR_ADDRESS) WALLETS.monitor = process.env.MONITOR_ADDRESS;
if (process.env.BACKUP_ADDRESS) WALLETS.backup = process.env.BACKUP_ADDRESS;

// Low balance threshold in USDC
const LOW_BALANCE_THRESHOLD = '20';

// RPC for balance checks
const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.arc.network';

// Health check URLs - hardcoded for local services (no env vars needed)
const SERVICES = {
    oracle: 'http://localhost:3000/health',
    monitor: 'http://localhost:3001/health'
};

// ─── State ──────────────────────────────────────────────────────────────────
let lastBalanceAlert = {};
const BALANCE_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes

// ─── Helper Functions ───────────────────────────────────────────────────────
async function getBalance(address) {
    try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const balance = await provider.getBalance(address);
        return ethers.formatEther(balance);
    } catch (err) {
        console.error(`Balance check failed for ${address}: ${err.message}`);
        return null;
    }
}

async function sendTelegramMessage(text) {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text,
                parse_mode: 'Markdown'
            })
        });
    } catch (err) {
        console.error(`Telegram send failed: ${err.message}`);
    }
}

async function checkServiceHealth(url) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json();
        return { ok: true, data };
    } catch {
        return { ok: false, status: 0 };
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────
async function handleOkCommand() {
    let message = '🔍 *System Status Check*\n\n';

    const serviceNames = { oracle: 'Oracle', monitor: 'Monitor', backup: 'Backup' };
    
    for (const [name, label] of Object.entries(serviceNames)) {
        if (!SERVICES[name]) {
            message += `⚪ *${label.toUpperCase()}*: NOT MONITORED\n`;
            continue;
        }
        
        const result = await checkServiceHealth(SERVICES[name]);
        if (result.ok) {
            const mode = result.data.mode || 'ACTIVE';
            message += `✅ *${label.toUpperCase()}*: ${result.data.status} (${mode})\n`;
            if (result.data.uptime) {
                const uptimeMin = Math.floor(result.data.uptime / 60);
                message += `   Uptime: ${uptimeMin} min\n`;
            }
        } else {
            message += `❌ *${label.toUpperCase()}*: OFFLINE\n`;
        }
    }

    await sendTelegramMessage(message);
}

async function handleBalanceCommand() {
    let message = '💰 *Wallet Balances*\n\n';
    const threshold = parseFloat(LOW_BALANCE_THRESHOLD);

    const walletLabels = { oracle: 'Oracle', monitor: 'Monitor', backup: 'Backup' };

    for (const [name, label] of Object.entries(walletLabels)) {
        if (!WALLETS[name]) {
            message += `⚪ *${label.toUpperCase()}*: NOT MONITORED\n`;
            continue;
        }

        const address = WALLETS[name];
        const balance = await getBalance(address);
        
        if (balance === null) {
            message += `❓ *${label.toUpperCase()}*: Check failed\n`;
            continue;
        }

        const balNum = parseFloat(balance);
        const status = balNum < threshold ? '🚨 LOW' : '✅ OK';
        message += `${status} *${label.toUpperCase()}*: ${balance} USDC\n\`${address}\`\n\n`;
    }

    await sendTelegramMessage(message);
}

async function checkBalancesAndAlert() {
    const threshold = parseFloat(LOW_BALANCE_THRESHOLD);
    const now = Date.now();
    const ALERT_COOLDOWN = 60 * 60 * 1000; // 1 hour between repeat alerts

    for (const [name, address] of Object.entries(WALLETS)) {
        if (!address) continue;

        const balance = await getBalance(address);
        if (balance === null) continue;

        const balNum = parseFloat(balance);
        const lastAlert = lastBalanceAlert[name] || 0;
        const timeSinceAlert = now - lastAlert;

        if (balNum < threshold && timeSinceAlert > ALERT_COOLDOWN) {
            const label = name.toUpperCase();
            await sendTelegramMessage(
                `🚨 *LOW BALANCE ALERT*\n\n` +
                `*${label}* wallet is low!\n` +
                `Balance: ${balance} USDC\n` +
                `Threshold: ${LOW_BALANCE_THRESHOLD} USDC\n` +
                `Address: \`${address}\`\n\n` +
                `Please top up this wallet.`
            );
            lastBalanceAlert[name] = now;
        }
    }
}

// ─── Telegram Bot Updates ───────────────────────────────────────────────────
async function getUpdates(offset) {
    try {
        const res = await fetch(
            `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${offset || 0}&timeout=30`
        );
        const data = await res.json();
        return data.ok ? data.result : [];
    } catch {
        return [];
    }
}

async function processUpdates() {
    let offset = 0;

    while (true) {
        const updates = await getUpdates(offset);

        for (const update of updates) {
            offset = update.update_id + 1;

            if (!update.message || !update.message.text) continue;
            const text = update.message.text.trim();
            const chatId = update.message.chat.id;

            if (chatId.toString() !== TG_CHAT_ID) {
                console.log(`Ignoring message from unauthorized chat: ${chatId}`);
                continue;
            }

            if (text === '/ok') {
                console.log('[Bot] /ok command received');
                await handleOkCommand();
            } else if (text === '/balance') {
                console.log('[Bot] /balance command received');
                await handleBalanceCommand();
            } else if (text === '/start') {
                await sendTelegramMessage(
                    '👋 *RWA Oracle Bot*\n\n' +
                    'Commands:\n' +
                    '/ok - Check system status\n' +
                    '/balance - Check wallet balances\n' +
                    '/help - Show this message'
                );
            } else if (text === '/help') {
                await sendTelegramMessage(
                    '👋 *RWA Oracle Bot*\n\n' +
                    'Commands:\n' +
                    '/ok - Check if oracle, monitor, backup are active\n' +
                    '/balance - Check wallet balances and low balance alerts\n' +
                    '/help - Show this message\n\n' +
                    'The bot also automatically monitors wallet balances every 10 minutes.'
                );
            }
        }

        await new Promise(r => setTimeout(r, 1000));
    }
}

// ─── Health Server ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'telegram-bot' }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`[Bot] HTTP server on port ${PORT}`);
});

// ─── Start ──────────────────────────────────────────────────────────────────
if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('[Bot] TG_TOKEN and TG_CHAT_ID must be set in .env');
    process.exit(1);
}

console.log(`[Bot] Starting Telegram bot...`);
console.log(`[Bot] Monitoring wallets: ${Object.keys(WALLETS).join(', ')}`);
console.log(`[Bot] Low balance threshold: ${LOW_BALANCE_THRESHOLD} USDC`);

// Initial balance check
checkBalancesAndAlert();

// Periodic balance monitoring
setInterval(checkBalancesAndAlert, BALANCE_CHECK_INTERVAL);
console.log(`[Bot] Balance check interval: ${BALANCE_CHECK_INTERVAL / 60000} min`);

// Start listening for commands
processUpdates();
