import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.RPC_URL;
const MONITOR_KEY = process.env.MONITOR_KEY;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;

const PAIR_IDS = {
    AAPL: 1,
    GOOGL: 2,
    WTI: 3,
    GOLD: 4,
    SILVER: 5
};

const ENDPOINTS = {
    AAPL: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
    GOOGL: "https://query1.finance.yahoo.com/v8/finance/chart/GOOGL",
    WTI: "https://query1.finance.yahoo.com/v8/finance/chart/CL=F",
    GOLD: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F",
    SILVER: "https://query1.finance.yahoo.com/v8/finance/chart/SI=F"
};

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(MONITOR_KEY, provider);
const registryAbi = [
    "function submitPrice(uint256 pairId, uint256 price) external",
    "function submitPriceBatch(uint256[] calldata pairIds, uint256[] calldata prices) external",
    "function isSubmitter(address) view returns (bool)",
    "function pairCount() view returns (uint256)",
    "function getPair(uint256 pairId) view returns (tuple(uint256 pairId, string name, string symbol, uint8 category, string priceSource, string description, address synth, uint256 price, uint256 lastUpdated, uint256 maxStaleness, uint256 maxDeviation, bool active, bool frozen, uint256 createdAt))"
];
const registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);

const DEVIATION_THRESHOLD = 5_000; // 50% in BPS (5000 = 50%)

async function fetchApiPrice(symbol) {
    try {
        const res = await fetch(ENDPOINTS[symbol], {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const data = await res.json();
        const price = data.chart.result[0].meta.regularMarketPrice;
        if (!price) throw new Error(`No price for ${symbol}`);
        return ethers.parseUnits(price.toString(), 18);
    } catch (err) {
        console.error(`[Monitor] API error ${symbol}:`, err.message);
        return null;
    }
}

async function monitor() {
    console.log(`[${new Date().toISOString()}] Monitor checking...`);
    
    const mismatches = [];
    
    for (const [symbol, pairId] of Object.entries(PAIR_IDS)) {
        try {
            // Get on-chain price
            const pair = await registry.getPair(pairId);
            const onChainPrice = pair.price;
            const lastUpdated = Number(pair.lastUpdated);
            
            // Skip if never updated
            if (onChainPrice === 0n) {
                console.log(`  ${symbol}: No on-chain price yet`);
                continue;
            }
            
            // Fetch API price
            const apiPrice = await fetchApiPrice(symbol);
            if (!apiPrice) continue;
            
            // Calculate deviation
            const diff = onChainPrice > apiPrice ? onChainPrice - apiPrice : apiPrice - onChainPrice;
            const deviationBps = Number((diff * 10000n) / onChainPrice);
            const age = Math.floor(Date.now() / 1000) - lastUpdated;
            
            console.log(`  ${symbol}: on-chain=${ethers.formatUnits(onChainPrice, 18)} api=${ethers.formatUnits(apiPrice, 18)} dev=${(deviationBps/100).toFixed(2)}% age=${age}s`);
            
            // Check for mismatches
            if (deviationBps >= DEVIATION_THRESHOLD) {
                console.log(`  ⚠️ ${symbol} DEVIATION TOO HIGH: ${(deviationBps/100).toFixed(2)}%`);
                mismatches.push({ pairId, symbol, apiPrice, deviation: deviationBps });
            }
            
            // Also flag if price is stale (>5 min old)
            if (age > 300) {
                console.log(`  ⚠️ ${symbol} STALE: ${age}s old`);
                mismatches.push({ pairId, symbol, apiPrice, deviation: 0, stale: true });
            }
        } catch (err) {
            console.error(`  ${symbol} error:`, err.message);
        }
    }
    
    // Submit corrections for mismatches
    if (mismatches.length > 0) {
        const pairIds = mismatches.map(m => m.pairId);
        const prices = mismatches.map(m => m.apiPrice);
        
        console.log(`[${new Date().toISOString()}] Submitting ${mismatches.length} corrections...`);
        try {
            const tx = await registry.submitPriceBatch(pairIds, prices);
            console.log(`TX: ${tx.hash}`);
            await tx.wait();
            console.log(`Confirmed!`);
            mismatches.forEach(m => {
                console.log(`  Fixed ${m.symbol}: ${ethers.formatUnits(m.apiPrice, 18)}`);
            });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] Submit error:`, err.message);
        }
    }
}

// Check every 30 seconds
setInterval(monitor, 30_000);
monitor();

console.log('AchRWAOracle monitor running...');
