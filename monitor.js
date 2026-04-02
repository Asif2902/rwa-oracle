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

// ─── RPC Fallback ───────────────────────────────────────────────────────────
const RPC_URLS = [
    process.env.RPC_URL,
    "https://rpc.blockdaemon.testnet.arc.network",
    "https://rpc.drpc.testnet.arc.network",
    "https://rpc.quicknode.testnet.arc.network"
].filter(Boolean);

const MONITOR_KEY = process.env.MONITOR_KEY;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;

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
let wallet = new ethers.Wallet(MONITOR_KEY, provider);
const registryAbi = [
    "function submitPriceBatch(uint256[] calldata pairIds, uint256[] calldata prices) external",
    "function getPair(uint256 pairId) view returns (tuple(uint256 pairId, string name, string symbol, uint8 category, string priceSource, string description, address synth, uint256 price, uint256 lastUpdated, uint256 maxStaleness, uint256 maxDeviation, bool active, bool frozen, uint256 createdAt))"
];
let registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);

const DEVIATION_THRESHOLD = 10; // 0.1% = 10 basis points
const PRICE_CACHE_TTL = 10_000; // Refresh API prices every 10 seconds
const CHECK_INTERVAL = 500; // Compare on-chain every 0.5 seconds (block time)
const STALE_THRESHOLD = 300; // 5 minutes

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
    // Fetch one symbol at a time with small delay to avoid burst
    for (const symbol of symbols) {
        const price = await fetchApiPrice(symbol);
        if (price) {
            priceCache[symbol] = { price, fetchedAt: Date.now() };
        }
        await new Promise(r => setTimeout(r, 200)); // 200ms between each symbol
    }
    lastCacheRefresh = Date.now();
}

function getCachedPrice(symbol) {
    const cached = priceCache[symbol];
    if (!cached) return null;
    // Use cache if fresh (< 15s old), otherwise return null to trigger refresh
    if (Date.now() - cached.fetchedAt < 15_000) return cached.price;
    return null;
}

// ─── Submit ──────────────────────────────────────────────────────────────────
let submitting = false;

async function submitCorrection(pairIds, prices, retries = 3) {
    if (submitting) return false;
    submitting = true;
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await registry.submitPriceBatch(pairIds, prices);
            console.log(`[Monitor] TX: ${tx.hash}`);
            await tx.wait();
            lastCorrection = tx.hash;
            submitting = false;
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
    return false;
}

// ─── Fast check (every 0.5s) - uses cached prices ───────────────────────────
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
                if (!cachedPrice) continue; // No cache, wait for refresh

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
                            mismatches.push({ pairId, symbol, apiPrice: freshPrice });
                        } else {
                            console.log(`  ${symbol}: Fresh check OK (${(freshDevBps / 100).toFixed(4)}%), skipping`);
                        }
                    }
                }

                if (age > STALE_THRESHOLD) {
                    const freshPrice = await fetchApiPrice(symbol);
                    if (freshPrice) mismatches.push({ pairId, symbol, apiPrice: freshPrice });
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
console.log(`[Monitor] Fast check: ${CHECK_INTERVAL}ms | Cache refresh: ${PRICE_CACHE_TTL/1000}s | Threshold: ${DEVIATION_THRESHOLD/100}%`);

// Refresh cache every 10s
refreshPriceCache();
setInterval(refreshPriceCache, PRICE_CACHE_TTL);

// Fast on-chain check every 0.5s using cached prices
setInterval(fastCheck, CHECK_INTERVAL);

keepAlive();
