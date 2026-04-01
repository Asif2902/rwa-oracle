import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

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
        { type: "stockprices", url: "https://stockprices.dev/api/stocks/AAPL" }
    ],
    GOOGL: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GOOGL" },
        { type: "stockprices", url: "https://stockprices.dev/api/stocks/GOOGL" }
    ],
    WTI: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/CL=F" }
    ],
    GOLD: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F" }
    ],
    SILVER: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/SI=F" }
    ]
};

let currentRpcIndex = 0;
function getProvider() {
    return new ethers.JsonRpcProvider(RPC_URLS[currentRpcIndex % RPC_URLS.length]);
}
function rotateRpc() {
    currentRpcIndex++;
    return getProvider();
}

let provider = getProvider();
let wallet = new ethers.Wallet(MONITOR_KEY, provider);
const registryAbi = [
    "function submitPriceBatch(uint256[] calldata pairIds, uint256[] calldata prices) external",
    "function getPair(uint256 pairId) view returns (tuple(uint256 pairId, string name, string symbol, uint8 category, string priceSource, string description, address synth, uint256 price, uint256 lastUpdated, uint256 maxStaleness, uint256 maxDeviation, bool active, bool frozen, uint256 createdAt))"
];
let registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);

const DEVIATION_THRESHOLD = 5_000;

async function fetchApiPrice(symbol) {
    const sources = PRICE_SOURCES[symbol];
    for (const source of sources) {
        try {
            const res = await fetch(source.url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(10000)
            });
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
            console.error(`[Monitor] ${source.type} failed for ${symbol}: ${err.message}`);
        }
    }
    return null;
}

async function submitCorrection(pairIds, prices, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await registry.submitPriceBatch(pairIds, prices);
            console.log(`TX: ${tx.hash}`);
            await tx.wait();
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
    return false;
}

async function monitor() {
    console.log(`[${new Date().toISOString()}] Checking...`);
    const mismatches = [];

    for (const [symbol, pairId] of Object.entries(PAIR_IDS)) {
        try {
            const pair = await registry.getPair(pairId);
            const onChainPrice = pair.price;
            const lastUpdated = Number(pair.lastUpdated);

            if (onChainPrice === 0n) continue;

            const apiPrice = await fetchApiPrice(symbol);
            if (!apiPrice) continue;

            const diff = onChainPrice > apiPrice ? onChainPrice - apiPrice : apiPrice - onChainPrice;
            const deviationBps = Number((diff * 10000n) / onChainPrice);
            const age = Math.floor(Date.now() / 1000) - lastUpdated;

            console.log(`  ${symbol}: on-chain=${ethers.formatUnits(onChainPrice, 18)} api=${ethers.formatUnits(apiPrice, 18)} dev=${(deviationBps / 100).toFixed(2)}% age=${age}s`);

            if (deviationBps >= DEVIATION_THRESHOLD) {
                console.log(`  ⚠️ ${symbol} DEVIATION: ${(deviationBps / 100).toFixed(2)}%`);
                mismatches.push({ pairId, symbol, apiPrice });
            }
            if (age > 300) {
                console.log(`  ⚠️ ${symbol} STALE: ${age}s`);
                mismatches.push({ pairId, symbol, apiPrice });
            }
        } catch (err) {
            console.error(`  ${symbol} error:`, err.message);
        }
    }

    if (mismatches.length > 0) {
        const pairIds = mismatches.map(m => m.pairId);
        const prices = mismatches.map(m => m.apiPrice);
        console.log(`[${new Date().toISOString()}] Submitting ${mismatches.length} corrections...`);
        await submitCorrection(pairIds, prices);
    }
}

setInterval(monitor, 30_000);
monitor();
console.log(`AchRWAOracle monitor running | Wallet: ${wallet.address}`);
