import http from 'http';
import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// ─── Health check server (required for Railway) ─────────────────────────────
const PORT = process.env.PORT || 3000;
let lastCheck = null;
let lastCorrection = null;
let isHealthy = true;

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: isHealthy ? 'ok' : 'degraded',
            service: 'monitor',
            lastCheck,
            lastCorrection,
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

// Alert categories to reduce noise and prevent alert fatigue
// CRITICAL: Immediate action required (TX failures, total failures)
// WARNING: Attention needed but not immediate (sanity check failures)
// CORRECTION: Price corrections (normal monitoring activity)
// INFO: Normal operations (submissions, status changes)
const ALERT_CATEGORIES = {
    CRITICAL: { emoji: '🚨', label: 'CRITICAL' },
    WARNING: { emoji: '⚠️', label: 'WARNING' },
    CORRECTION: { emoji: '🔧', label: 'CORRECTION' },
    INFO: { emoji: 'ℹ️', label: 'INFO' }
};

async function alert(msg, category = 'CRITICAL') {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        const cat = ALERT_CATEGORIES[category] || ALERT_CATEGORIES.CRITICAL;
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `${cat.emoji} [AchRWA Monitor] [${cat.label}] ${msg}` })
        });
    } catch (err) {
        console.error(`[Alert] Telegram failed: ${err.message}`);
    }
}

// ─── RPC Fallback ───────────────────────────────────────────────────────────
const RPC_URLS = [
    process.env.RPC_URL,
    "https://rpc.blockdaemon.testnet.arc.network",
    "https://rpc.drpc.testnet.arc.network",
    "https://rpc.quicknode.testnet.arc.network"
].filter(Boolean);

const MONITOR_KEY = process.env.MONITOR_KEY;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;

const PAIR_IDS = { AAPL: 1, GOOGL: 2, WTI: 3, GOLD: 4, SILVER: 5, NVDA: 6, MSFT: 7, TSLA: 8, NATGAS: 9, GBPUSD: 10 };

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
    ],
    NVDA: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/NVDA" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/NVDA" }
    ],
    MSFT: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/MSFT" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/MSFT" }
    ],
    TSLA: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/TSLA" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/TSLA" }
    ],
    NATGAS: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/NG=F" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/NG=F" }
    ],
    GBPUSD: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GBPUSD=X" },
        { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/GBPUSD=X" }
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
let wallet = new ethers.Wallet(MONITOR_KEY, provider);
const registryAbi = [
    "function submitPriceBatch(uint256[] calldata pairIds, uint256[] calldata prices) external",
    "function getPair(uint256 pairId) view returns (tuple(uint256 pairId, string name, string symbol, uint8 category, string priceSource, string description, address synth, uint256 price, uint256 lastUpdated, uint256 maxStaleness, uint256 maxDeviation, bool active, bool frozen, uint256 createdAt))"
];
let registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);

// Raised from 10 BPS (0.1%) to 50 BPS (0.5%).
// 0.1% was triggering on normal bid/ask spread noise and wasting gas.
// Monitor still re-fetches fresh price to confirm before submitting any correction.
const DEVIATION_THRESHOLD = 50;

const PRICE_CACHE_TTL = 10_000; // Refresh API prices every 10 seconds

// Reduced from 500ms to 5000ms (5s).
// 500ms = 10 RPC reads/second which causes rate limiting on all endpoints.
// 5s is still fast enough to catch and correct any real deviation quickly.
const CHECK_INTERVAL = 5_000;

const STALE_THRESHOLD = 300; // 5 minutes

// ─── Price Sanity Check ─────────────────────────────────────────────────────
// Rejects any price that deviates more than 20% from the last known good price.
// Protects against submitting corrupted API responses as corrections.
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

// ─── Price Cache ─────────────────────────────────────────────────────────────
let priceCache = {};
let lastCacheRefresh = 0;

async function fetchApiPrice(symbol) {
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
            }
            if (price) return ethers.parseUnits(price.toString(), 18);
        } catch (err) {
            console.error(`[Price] ${source.type} failed for ${symbol}: ${err.message}`);
        }
    }
    return null;
}

async function refreshPriceCache() {
    const symbols = Object.keys(PAIR_IDS);
    for (const symbol of symbols) {
        const price = await fetchApiPrice(symbol);
        if (price) {
            if (isSanePrice(symbol, price)) {
                priceCache[symbol] = { price, fetchedAt: Date.now() };
                lastKnownGoodPrices[symbol] = price; // Update last known good on sane prices
            } else {
                await alert(`${symbol} sanity check failed during cache refresh — keeping old cached value`, 'WARNING');
            }
        }
        await new Promise(r => setTimeout(r, 200)); // 200ms between each symbol to avoid burst
    }
    lastCacheRefresh = Date.now();
}

function getCachedPrice(symbol) {
    const cached = priceCache[symbol];
    if (!cached) return null;
    // Match the cache TTL exactly — was 15_000 before which was inconsistent with PRICE_CACHE_TTL
    if (Date.now() - cached.fetchedAt < PRICE_CACHE_TTL) return cached.price;
    return null;
}

// ─── Submit ──────────────────────────────────────────────────────────────────
let submitting = false;

async function submitCorrection(pairIds, prices, retries = 3) {
    if (submitting) return false;
    submitting = true;
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await registry.submitPriceBatch(pairIds, prices, {
                gasLimit: 500_000 // Cap gas to prevent runaway costs on bad RPC responses
            });
            console.log(`[Monitor] TX: ${tx.hash}`);
            await tx.wait();
            lastCorrection = tx.hash;
            submitting = false;
            await alert(`Submitted ${pairIds.length} price correction(s) — TX: ${tx.hash}`, 'CORRECTION');
            return true;
        } catch (err) {
            console.error(`[TX] Attempt ${i + 1} failed: ${err.message}`);
            if (i < retries - 1) {
                provider = rotateRpc();
                wallet = new ethers.Wallet(MONITOR_KEY, provider);
                registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
    submitting = false;
    await alert(`Correction TX failed after ${retries} retries`, 'CRITICAL');
    return false;
}

// ─── Fast check (every 5s) - uses cached prices ───────────────────────────
async function fastCheck() {
    if (submitting) return;
    try {
        const mismatches = [];

        for (const [symbol, pairId] of Object.entries(PAIR_IDS)) {
            try {
                const pair = await registry.getPair(pairId);
                const onChainPrice = pair.price;
                const lastUpdated = Number(pair.lastUpdated);

                if (onChainPrice === 0n) continue;

                const cachedPrice = getCachedPrice(symbol);
                if (!cachedPrice) continue; // No cache yet, wait for refresh

                const diff = onChainPrice > cachedPrice ? onChainPrice - cachedPrice : cachedPrice - onChainPrice;
                const deviationBps = Number((diff * 10000n) / onChainPrice);
                const age = Math.floor(Date.now() / 1000) - lastUpdated;

                if (deviationBps >= DEVIATION_THRESHOLD) {
                    console.log(`[!] ${symbol} DEVIATION: ${(deviationBps / 100).toFixed(4)}% | on-chain=${ethers.formatUnits(onChainPrice, 18)} cached=${ethers.formatUnits(cachedPrice, 18)}`);
                    // Re-fetch fresh price to confirm before submitting
                    const freshPrice = await fetchApiPrice(symbol);
                    if (freshPrice) {
                        const freshDiff = onChainPrice > freshPrice ? onChainPrice - freshPrice : freshPrice - onChainPrice;
                        const freshDevBps = Number((freshDiff * 10000n) / onChainPrice);
                        if (freshDevBps >= DEVIATION_THRESHOLD) {
                            if (isSanePrice(symbol, freshPrice)) {
                                mismatches.push({ pairId, symbol, apiPrice: freshPrice });
                            } else {
                                await alert(`${symbol} correction skipped — sanity check failed on fresh price`, 'WARNING');
                            }
                        } else {
                            console.log(`  ${symbol}: Fresh check OK (${(freshDevBps / 100).toFixed(4)}%), skipping`);
                        }
                    }
                }

                if (age > STALE_THRESHOLD) {
                    const freshPrice = await fetchApiPrice(symbol);
                    if (freshPrice) {
                        if (isSanePrice(symbol, freshPrice)) {
                            mismatches.push({ pairId, symbol, apiPrice: freshPrice });
                        } else {
                            await alert(`${symbol} stale correction skipped — sanity check failed`, 'WARNING');
                        }
                    }
                }
            } catch (err) {
                // Silent in fast check, errors logged in refresh
            }
        }

        if (mismatches.length > 0) {
            const pairIds = mismatches.map(m => m.pairId);
            const prices = mismatches.map(m => m.apiPrice);
            console.log(`[Monitor] Submitting ${mismatches.length} corrections...`);
            await submitCorrection(pairIds, prices);
        }

        lastCheck = new Date().toISOString();
        isHealthy = true;
    } catch (err) {
        console.error(`[Monitor] Error: ${err.message}`);
        isHealthy = false;
    }
}

// ─── Keep alive ──────────────────────────────────────────────────────────────
function keepAlive() {
    setInterval(() => {
        fetch(`http://localhost:${PORT}/health`).catch(() => {});
    }, 25000);
}

// ─── Start ──────────────────────────────────────────────────────────────────
console.log(`[Monitor] Running | Wallet: ${wallet.address}`);
console.log(`[Monitor] Fast check: ${CHECK_INTERVAL}ms | Cache refresh: ${PRICE_CACHE_TTL / 1000}s | Threshold: ${DEVIATION_THRESHOLD / 100}%`);

// Refresh cache every 10s
refreshPriceCache();
setInterval(refreshPriceCache, PRICE_CACHE_TTL);

// Fast on-chain check every 5s using cached prices
setInterval(fastCheck, CHECK_INTERVAL);

keepAlive();
