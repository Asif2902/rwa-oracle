import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

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

// ─── Primary + Backup Price Sources ─────────────────────────────────────────
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
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/CL=F" },
        { type: "stockprices", url: "https://stockprices.dev/api/stocks/CL" }
    ],
    GOLD: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F" },
        { type: "stockprices", url: "https://stockprices.dev/api/stocks/GC" }
    ],
    SILVER: [
        { type: "yahoo", url: "https://query1.finance.yahoo.com/v8/finance/chart/SI=F" },
        { type: "stockprices", url: "https://stockprices.dev/api/stocks/SI" }
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

// ─── Price Fetch with fallback sources ──────────────────────────────────────
async function fetchPrice(symbol) {
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
            const tx = await registry.submitPriceBatch(pairIds, prices);
            console.log(`[${new Date().toISOString()}] TX: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`Confirmed in block ${receipt.blockNumber}`);
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

// ─── Main update loop ───────────────────────────────────────────────────────
async function updatePrices() {
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
        await submitBatch(pairIds, prices);
    }
}

// ─── Start ──────────────────────────────────────────────────────────────────
setInterval(updatePrices, 60_000);
updatePrices();
console.log(`AchRWAOracle feeder running | RPC: ${RPC_URLS[0]} | Wallet: ${wallet.address}`);
