import http from 'http';
import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// ─── Health check server (required for Railway) ─────────────────────────────
const PORT = process.env.PORT || 3000;
let lastRun = null;
let lastTx = null;
let isHealthy = true;

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: isHealthy ? 'ok' : 'degraded',
            service: 'oracle',
            lastRun,
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

// ─── Telegram Alerts ─────────────────────────────────────────────────────────
// Add TG_TOKEN and TG_CHAT_ID to your .env to enable alerts
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function alert(msg) {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `🚨 [AchRWA Oracle] ${msg}` })
        });
    } catch (err) {
        console.error(`[Alert] Telegram failed: ${err.message}`);
    }
}

// ─── RPC Fallback List (official Arc docs) ─────────────────────────────────
const RPC_URLS = [
    process.env.RPC_URL,
    "https://rpc.blockdaemon.testnet.arc.network",
    "https://rpc.drpc.testnet.arc.network",
    "https://rpc.quicknode.testnet.arc.network"
].filter(Boolean);

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;

const PAIR_IDS = { AAPL: 1, GOOGL: 2, WTI: 3, GOLD: 4, SILVER: 5 };

// ─── Price Sources (primary + backups) ──────────────────────────────────────
const PRICE_SOURCES = {
    AAPL: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/AAPL" },
        { type: "stockprices", url: "https://stockprices.dev/api/price?symbol=AAPL" }
    ],
    GOOGL: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GOOGL" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/GOOGL" },
        { type: "stockprices", url: "https://stockprices.dev/api/price?symbol=GOOGL" }
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

// ─── Provider with fallback ─────────────────────────────────────────────────
let currentRpcIndex = 0;

function getProvider() {
    const url = RPC_URLS[currentRpcIndex % RPC_URLS.length];
    return new ethers.JsonRpcProvider(url);
}

function rotateRpc() {
    currentRpcIndex++;
    console.log(`[RPC] Switched to: ${RPC_URLS[currentRpcIndex % RPC_URLS.length]}`);
    return getProvider();
}

let provider = getProvider();
let wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const registryAbi = [
    "function submitPriceBatch(uint256[] calldata pairIds, uint256[] calldata prices) external",
    "function isSubmitter(address) view returns (bool)"
];
let registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);

// ─── Price Sanity Check ─────────────────────────────────────────────────────
// Rejects any price that deviates more than 20% from the last known good price.
// Protects against corrupted API responses being submitted on-chain.
const lastKnownGoodPrices = {};
const MAX_PRICE_CHANGE_BPS = 2000; // 20%

function isSanePrice(symbol, newPrice) {
    const last = lastKnownGoodPrices[symbol];
    if (!last) return true; // First ever price — accept it
    const diff = newPrice > last ? newPrice - last : last - newPrice;
    const changeBps = Number((diff * 10000n) / last);
    if (changeBps > MAX_PRICE_CHANGE_BPS) {
        console.error(`[Sanity] ${symbol}: ${(changeBps / 100).toFixed(1)}% change rejected (max ${MAX_PRICE_CHANGE_BPS / 100}%)`);
        return false;
    }
    return true;
}

// ─── Price Fetch with fallback sources ──────────────────────────────────────
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
            if (price) {
                return ethers.parseUnits(price.toString(), 18);
            }
        } catch (err) {
            console.error(`[Price] ${source.type} failed for ${symbol}: ${err.message}`);
        }
    }
    console.error(`[Price] ALL sources failed for ${symbol}`);
    return null;
}

// ─── Transaction with retry + RPC rotation ──────────────────────────────────
async function submitBatch(pairIds, prices, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await registry.submitPriceBatch(pairIds, prices, {
                gasLimit: 500_000 // Cap gas to prevent runaway costs on bad RPC responses
            });
            console.log(`[${new Date().toISOString()}] TX: ${tx.hash}`);
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
    await alert(`TX failed after ${retries} retries — oracle may be stale`);
    return false;
}

// ─── Main update loop ───────────────────────────────────────────────────────
async function updatePrices() {
    try {
        const pairIds = [];
        const prices = [];

        for (const symbol of Object.keys(PAIR_IDS)) {
            const price = await fetchPrice(symbol);
            if (price) {
                if (isSanePrice(symbol, price)) {
                    pairIds.push(PAIR_IDS[symbol]);
                    prices.push(price);
                    lastKnownGoodPrices[symbol] = price; // Update last known good
                } else {
                    await alert(`⚠️ ${symbol} price sanity check failed — skipped this cycle`);
                }
            }
        }

        // Critical: alert and bail if zero prices were fetchable this cycle
        if (pairIds.length === 0) {
            isHealthy = false;
            console.error('[Oracle] CRITICAL: No prices fetched this cycle — all sources failed');
            await alert('CRITICAL: 0 prices fetched — all sources failed, nothing submitted');
            return;
        }

        await submitBatch(pairIds, prices);
        lastRun = new Date().toISOString();
        isHealthy = true;
    } catch (err) {
        console.error(`[Update] Error: ${err.message}`);
        isHealthy = false;
        await alert(`Unhandled error in updatePrices: ${err.message}`);
    }
}

// ─── Keep alive loop (prevents Railway from sleeping) ───────────────────────
function keepAlive() {
    setInterval(() => {
        fetch(`http://localhost:${PORT}/health`).catch(() => {});
    }, 25000);
}

// ─── Start ──────────────────────────────────────────────────────────────────
setInterval(updatePrices, 60_000);
updatePrices();
keepAlive();
console.log(`[Oracle] Running | RPC: ${RPC_URLS[0]} | Wallet: ${wallet.address}`);
