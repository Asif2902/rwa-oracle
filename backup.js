import http from 'http';
import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// ─── Health check server (required for Railway) ─────────────────────────────
const PORT = process.env.PORT || 3000;
let lastCheck = null;
let lastTx = null;
let isHealthy = true;
let backupActive = false;
let lastSubmitTime = 0;
const BACKUP_SUBMIT_INTERVAL = 300000; // 5 minutes

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: isHealthy ? 'ok' : 'degraded',
            service: 'backup',
            mode: backupActive ? 'ACTIVE' : 'STANDBY',
            lastCheck,
            lastTx,
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`[HTTP] Health server on port ${PORT}`);
});

// ─── RPC Fallback ───────────────────────────────────────────────────────────
const RPC_URLS = [
    process.env.RPC_URL,
    "https://rpc.blockdaemon.testnet.arc.network",
    "https://rpc.drpc.testnet.arc.network",
    "https://rpc.quicknode.testnet.arc.network"
].filter(Boolean);

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;
const ARCANSCAN_API = "https://testnet.arcscan.app/api/v2";

const PAIR_IDS = { AAPL: 1, GOOGL: 2, WTI: 3, GOLD: 4, SILVER: 5 };

const PRICE_SOURCES = {
    AAPL: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/AAPL" }
    ],
    GOOGL: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GOOGL" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/GOOGL" }
    ],
    WTI: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/CL=F" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/CL=F" }
    ],
    GOLD: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/GC=F" }
    ],
    SILVER: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/SI=F" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/SI=F" }
    ]
};

let currentRpcIndex = 0;
function getProvider() {
    return new ethers.JsonRpcProvider(RPC_URLS[currentRpcIndex % RPC_URLS.length]);
}
function rotateRpc() {
    currentRpcIndex++;
    console.log(`[RPC] Switched to: ${RPC_URLS[currentRpcIndex % RPC_URLS.length]}`);
    return getProvider();
}

let provider = getProvider();
let wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const registryAbi = [
    "function submitPriceBatch(uint256[] calldata pairIds, uint256[] calldata prices) external"
];
let registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);

const INACTIVITY_THRESHOLD = 300;

async function checkPrimaryActivity() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(`${ARCANSCAN_API}/addresses/${REGISTRY_ADDRESS}/transactions?filter=to`, {
            signal: controller.signal
        });
        clearTimeout(timeout);
        const data = await res.json();
        if (!data.items || data.items.length === 0) {
            return { active: false, age: Infinity };
        }
        const lastTxTime = new Date(data.items[0].timestamp).getTime() / 1000;
        const age = Math.floor(Date.now() / 1000) - lastTxTime;
        return { active: age < INACTIVITY_THRESHOLD, age };
    } catch (err) {
        console.error(`[ArcScan] error: ${err.message}`);
        return { active: false, age: Infinity };
    }
}

async function fetchPrice(symbol) {
    const sources = PRICE_SOURCES[symbol];
    for (const source of sources) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(source.url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: controller.signal
            });
            clearTimeout(timeout);
            let price;
            if (source.type === "yahoo") {
                const data = await res.json();
                price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
            } else if (source.type === "stockprices") {
                const data = await res.json();
                price = data.Price;
            }
            if (price) return ethers.parseUnits(price.toString(), 18);
        } catch (err) {
            console.error(`[Price] ${source.type} failed for ${symbol}: ${err.message}`);
        }
    }
    return null;
}

async function submitBatch(pairIds, prices, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await registry.submitPriceBatch(pairIds, prices);
            console.log(`[${new Date().toISOString()}] BACKUP TX: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`Confirmed in block ${receipt.blockNumber}`);
            lastTx = tx.hash;
            return true;
        } catch (err) {
            console.error(`[TX] Attempt ${i + 1} failed: ${err.message}`);
            if (i < retries - 1) {
                provider = rotateRpc();
                wallet = new ethers.Wallet(PRIVATE_KEY, provider);
                registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
    return false;
}

async function monitor() {
    try {
        const status = await checkPrimaryActivity();
        console.log(`[${new Date().toISOString()}] Primary: ${status.active ? 'ACTIVE' : 'INACTIVE'} (${status.age}s)`);

        if (!status.active) {
            if (!backupActive) {
                console.log(`[Backup] PRIMARY DOWN - ACTIVATING`);
                backupActive = true;
                lastSubmitTime = 0; // Reset to submit immediately on first activation
            }
            
            const now = Date.now();
            const timeSinceLastSubmit = now - lastSubmitTime;
            
            if (timeSinceLastSubmit >= BACKUP_SUBMIT_INTERVAL) {
                console.log(`[Backup] Submitting prices (last submit: ${Math.floor(timeSinceLastSubmit/1000)}s ago)`);
                const pairIds = [];
                const prices = [];
                for (const symbol of Object.keys(PAIR_IDS)) {
                    const price = await fetchPrice(symbol);
                    if (price) {
                        pairIds.push(PAIR_IDS[symbol]);
                        prices.push(price);
                    }
                }
                if (pairIds.length > 0) {
                    const success = await submitBatch(pairIds, prices);
                    if (success) lastSubmitTime = now;
                }
            } else {
                console.log(`[Backup] Waiting ${Math.ceil((BACKUP_SUBMIT_INTERVAL - timeSinceLastSubmit)/1000)}s until next submit`);
            }
        } else {
            if (backupActive) {
                console.log(`[Backup] PRIMARY BACK - STANDBY`);
                backupActive = false;
                lastSubmitTime = 0;
            }
        }
        lastCheck = new Date().toISOString();
        isHealthy = true;
    } catch (err) {
        console.error(`[Backup] Error: ${err.message}`);
        isHealthy = false;
    }
}

// ─── Keep alive loop (prevents Railway from sleeping) ───────────────────────
function keepAlive() {
    setInterval(() => {
        fetch(`http://localhost:${PORT}/health`).catch(() => {});
    }, 25000);
}

// ─── Start ──────────────────────────────────────────────────────────────────
setInterval(monitor, 30_000);
monitor();
keepAlive();
console.log(`[Backup] Running | Wallet: ${wallet.address}`);
