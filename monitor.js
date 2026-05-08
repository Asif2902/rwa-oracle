import http from 'http';
import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// ─── Health check server ─────────────────────────────────────────────────────
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
            uptime: process.uptime(),
            cacheStatus: Object.fromEntries(
                Object.keys(PAIR_IDS).map(s => [s, priceCache[s] ? ethers.formatUnits(priceCache[s].price, 18) : 'empty'])
            )
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
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const ALERT_CATEGORIES = {
    CRITICAL:   { emoji: '🚨', label: 'CRITICAL' },
    WARNING:    { emoji: '⚠️',  label: 'WARNING' },
    CORRECTION: { emoji: '🔧', label: 'CORRECTION' },
    INFO:       { emoji: 'ℹ️',  label: 'INFO' }
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

// ─── Config ──────────────────────────────────────────────────────────────────
const RPC_URLS = [
    process.env.RPC_URL,
    "https://rpc.blockdaemon.testnet.arc.network",
    "https://rpc.drpc.testnet.arc.network",
    "https://rpc.quicknode.testnet.arc.network"
].filter(Boolean);

const MONITOR_KEY = process.env.MONITOR_KEY;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;

const PAIR_IDS = { AAPL: 1, GOOGL: 2, WTI: 3, GOLD: 4, SILVER: 5, MSFT: 6, TSLA: 7, NATGAS: 8, NVDA: 9, GBPUSD: 10 };

const PRICE_SOURCES = {
    AAPL:   [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL" },   { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/AAPL" }],
    GOOGL:  [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GOOGL" },  { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/GOOGL" }],
    WTI:    [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/CL=F" },   { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/CL=F" }],
    GOLD:   [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F" },   { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/GC=F" }],
    SILVER: [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/SI=F" },   { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/SI=F" }],
    NVDA:   [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/NVDA" },   { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/NVDA" }],
    MSFT:   [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/MSFT" },   { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/MSFT" }],
    TSLA:   [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/TSLA" },   { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/TSLA" }],
    NATGAS: [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/NG=F" },   { type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/NG=F" }],
    GBPUSD: [{ type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GBPUSD=X" },{ type: "yahoo", url: "https://query2.finance.yahoo.com/v8/finance/chart/GBPUSD=X" }]
};

// One symbol fetched per second → each symbol refreshes every ~10s, Yahoo sees 1 req/s (no burst)
const SYMBOL_REFRESH_INTERVAL = 1000; // 1s between each symbol fetch
const CHECK_INTERVAL = 5_000;         // On-chain deviation check every 5s
const CACHE_MAX_AGE = 30_000;         // Cache entry considered stale after 30s
const STALE_THRESHOLD = 300;          // On-chain price stale after 5 minutes
const MAX_PRICE_CHANGE_BPS = 2000;    // 20% sanity guard
const CORRECTION_THRESHOLD_BPS = 50;   // 0.5% - submit correction when difference exceeds this

// ─── RPC ─────────────────────────────────────────────────────────────────────
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

// ─── Price Sanity Check ───────────────────────────────────────────────────────
const lastKnownGoodPrices = {};

function isSanePrice(symbol, newPrice) {
    const last = lastKnownGoodPrices[symbol];
    if (!last) return true;
    const diff = newPrice > last ? newPrice - last : last - newPrice;
    const changeBps = Number((diff * 10000n) / last);
    if (changeBps > MAX_PRICE_CHANGE_BPS) {
        console.error(`[Sanity] ${symbol}: ${(changeBps / 100).toFixed(1)}% change rejected (max ${MAX_PRICE_CHANGE_BPS / 100}%)`);
        return false;
    }
    return true;
}

// ─── Price Cache ──────────────────────────────────────────────────────────────
let priceCache = {};

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
            if (!res.ok) {
                console.error(`[Price] ${source.type} HTTP ${res.status} for ${symbol}`);
                continue;
            }
            const data = await res.json();
            const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
            if (price) return ethers.parseUnits(price.toString(), 18);
        } catch (err) {
            console.error(`[Price] ${source.type} failed for ${symbol}: ${err.message}`);
        }
    }
    return null;
}

function getCachedPrice(symbol) {
    const cached = priceCache[symbol];
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt < CACHE_MAX_AGE) return cached.price;
    return null;
}

// ─── Rolling symbol refresh (1 symbol/sec → no burst) ────────────────────────
const SYMBOLS = Object.keys(PAIR_IDS);
let symbolIndex = 0;
let cachePopulated = false;
let cachePopulatedCount = 0;

async function refreshNextSymbol() {
    const symbol = SYMBOLS[symbolIndex % SYMBOLS.length];
    symbolIndex++;

    const price = await fetchApiPrice(symbol);
    if (price) {
        if (isSanePrice(symbol, price)) {
            priceCache[symbol] = { price, fetchedAt: Date.now() };
            lastKnownGoodPrices[symbol] = price;
            console.log(`[Cache] ${symbol} = ${ethers.formatUnits(price, 18)}`);

            // Track first full population
            if (!cachePopulated) {
                cachePopulatedCount = Object.keys(priceCache).length;
                if (cachePopulatedCount >= SYMBOLS.length) {
                    cachePopulated = true;
                    console.log(`[Cache] ✅ All ${SYMBOLS.length} symbols populated — monitor fully active`);
                }
            }
        } else {
            await alert(`${symbol} sanity check failed during cache refresh — keeping old value`, 'WARNING');
        }
    } else {
        console.warn(`[Cache] ⚠️ ${symbol} fetch failed — cache ${priceCache[symbol] ? 'using old value' : 'EMPTY'}`);
    }
}

// ─── Submit ───────────────────────────────────────────────────────────────────
let submitting = false;

async function submitCorrection(pairIds, prices, retries = 3) {
    if (submitting) return false;
    submitting = true;
    for (let i = 0; i < retries; i++) {
        try {
            const gasLimit = Math.min(3000000, 100000 + pairIds.length * 200000);
            const tx = await registry.submitPriceBatch(pairIds, prices, { gasLimit });
            console.log(`[Monitor] TX sent: ${tx.hash} (gas: ${gasLimit})`);
            await tx.wait();
            console.log(`[Monitor] TX confirmed: ${tx.hash}`);
            lastCorrection = tx.hash;
            submitting = false;
            await alert(`Submitted ${pairIds.length} correction(s) — TX: ${tx.hash}`, 'CORRECTION');
            return true;
        } catch (err) {
            console.error(`[TX] Attempt ${i + 1}/${retries} failed: ${err.message}`);
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

// ─── Fast check (every 5s) ────────────────────────────────────────────────────
let checkCount = 0;

async function fastCheck() {
    if (submitting) return;
    checkCount++;
    const isHeartbeat = checkCount % 12 === 0; // Log heartbeat every 60s (12 × 5s)

    try {
        const mismatches = [];
        let checkedCount = 0;
        let skippedCount = 0;

        for (const [symbol, pairId] of Object.entries(PAIR_IDS)) {
            try {
                const pair = await registry.getPair(pairId);
                const onChainPrice = pair.price;
                const lastUpdated = Number(pair.lastUpdated);
                const maxDeviation = Number(pair.maxDeviation);

                if (onChainPrice === 0n) { skippedCount++; continue; }

                const cachedPrice = getCachedPrice(symbol);
                if (!cachedPrice) { skippedCount++; continue; }

                checkedCount++;
                const diff = onChainPrice > cachedPrice ? onChainPrice - cachedPrice : cachedPrice - onChainPrice;
                const deviationBps = Number((diff * 10000n) / onChainPrice);
                const age = Math.floor(Date.now() / 1000) - lastUpdated;

                if (deviationBps >= CORRECTION_THRESHOLD_BPS) {
                    console.log(`[!] ${symbol} DEVIATION: ${(deviationBps / 100).toFixed(2)}% | on-chain=${ethers.formatUnits(onChainPrice, 18)} cached=${ethers.formatUnits(cachedPrice, 18)}`);
                    const freshPrice = await fetchApiPrice(symbol);
                    if (freshPrice) {
                        const freshDiff = onChainPrice > freshPrice ? onChainPrice - freshPrice : freshPrice - onChainPrice;
                        const freshDevBps = Number((freshDiff * 10000n) / onChainPrice);
                        if (freshDevBps >= CORRECTION_THRESHOLD_BPS) {
                            if (isSanePrice(symbol, freshPrice)) {
                                mismatches.push({ pairId, symbol, apiPrice: freshPrice });
                            } else {
                                await alert(`${symbol} correction skipped — sanity check failed on fresh price`, 'WARNING');
                            }
                        } else {
                            console.log(`  ${symbol}: Fresh check OK (${(freshDevBps / 100).toFixed(2)}%) — skipping`);
                        }
                    }
                }

                if (age > STALE_THRESHOLD) {
                    console.log(`[Stale] ${symbol} on-chain price is ${age}s old — forcing correction`);
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
                console.error(`[Check] ${symbol} error: ${err.message}`);
            }
        }

        if (mismatches.length > 0) {
            console.log(`[Monitor] Submitting ${mismatches.length} correction(s): ${mismatches.map(m => m.symbol).join(', ')}`);
            await submitCorrection(mismatches.map(m => m.pairId), mismatches.map(m => m.apiPrice));
        }

        lastCheck = new Date().toISOString();
        isHealthy = true;

        // Heartbeat every 60s so you know it's alive even when no corrections needed
        if (isHeartbeat) {
            const cached = Object.keys(priceCache).length;
            console.log(`[Heartbeat] ✅ Check #${checkCount} | ${checkedCount} checked | ${skippedCount} skipped (no cache) | ${cached}/${SYMBOLS.length} symbols cached | uptime: ${Math.floor(process.uptime() / 60)}m`);
        }

    } catch (err) {
        console.error(`[Monitor] Fatal check error: ${err.message}`);
        isHealthy = false;
    }
}

// ─── Keep alive ───────────────────────────────────────────────────────────────
function keepAlive() {
    setInterval(() => {
        fetch(`http://localhost:${PORT}/health`).catch(() => {});
    }, 25000);
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log(`[Monitor] Starting | Wallet: ${wallet.address}`);
console.log(`[Monitor] Symbol refresh: ${SYMBOL_REFRESH_INTERVAL}ms rolling | Check: ${CHECK_INTERVAL}ms | Cache TTL: ${CACHE_MAX_AGE / 1000}s`);
console.log(`[Monitor] Warming up cache... (${SYMBOLS.length} symbols × ${SYMBOL_REFRESH_INTERVAL}ms = ~${SYMBOLS.length}s to full population)`);

// Rolling refresh: 1 symbol per second
setInterval(refreshNextSymbol, SYMBOL_REFRESH_INTERVAL);

// On-chain deviation check every 5s
setInterval(fastCheck, CHECK_INTERVAL);

keepAlive();
