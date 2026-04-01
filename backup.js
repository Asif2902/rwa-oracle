import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;
const ARCANSCAN_API = "https://testnet.arcscan.app/api/v2";

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
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const registryAbi = [
    "function submitPrice(uint256 pairId, uint256 price) external",
    "function submitPriceBatch(uint256[] calldata pairIds, uint256[] calldata prices) external",
    "function isSubmitter(address) view returns (bool)"
];
const registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);

let active = false;
const INACTIVITY_THRESHOLD = 300; // 5 minutes in seconds

// Check if primary oracle has submitted recently
async function checkPrimaryActivity() {
    try {
        const res = await fetch(`${ARCANSCAN_API}/addresses/${REGISTRY_ADDRESS}/transactions?filter=to`);
        const data = await res.json();
        
        if (!data.items || data.items.length === 0) {
            return { active: false, lastTx: null, age: Infinity };
        }
        
        const lastTx = data.items[0];
        const lastTxTime = new Date(lastTx.timestamp).getTime() / 1000;
        const age = Math.floor(Date.now() / 1000) - lastTxTime;
        
        return {
            active: age < INACTIVITY_THRESHOLD,
            lastTx: lastTx.hash,
            age: age
        };
    } catch (err) {
        console.error(`[${new Date().toISOString()}] API error:`, err.message);
        return { active: false, lastTx: null, age: Infinity, error: err.message };
    }
}

async function fetchPrice(symbol) {
    try {
        const res = await fetch(ENDPOINTS[symbol], {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const data = await res.json();
        const price = data.chart.result[0].meta.regularMarketPrice;
        if (!price) throw new Error(`No price for ${symbol}`);
        return ethers.parseUnits(price.toString(), 18);
    } catch (err) {
        console.error(`Error fetching ${symbol}:`, err.message);
        return null;
    }
}

async function submitPrices() {
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
        try {
            const tx = await registry.submitPriceBatch(pairIds, prices);
            console.log(`[${new Date().toISOString()}] BACKUP TX: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`Confirmed in block ${receipt.blockNumber}`);
            pairIds.forEach((id, i) => {
                console.log(`  ${Object.keys(PAIR_IDS).find(k => PAIR_IDS[k] === id)}: ${ethers.formatUnits(prices[i], 18)}`);
            });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] Error:`, err.message);
        }
    }
}

async function monitor() {
    const status = await checkPrimaryActivity();
    
    console.log(`[${new Date().toISOString()}] Primary status: ${status.active ? 'ACTIVE' : 'INACTIVE'} (last tx ${status.age}s ago)`);
    
    if (!status.active) {
        if (!active) {
            console.log(`[${new Date().toISOString()}] ⚠️ PRIMARY DOWN - BACKUP ACTIVATED`);
            active = true;
        }
        await submitPrices();
    } else {
        if (active) {
            console.log(`[${new Date().toISOString()}] ✅ PRIMARY BACK ONLINE - BACKUP STANDBY`);
            active = false;
        }
    }
}

// Check every 30 seconds
setInterval(monitor, 30_000);
monitor();

console.log('AchRWAOracle backup server running...');
console.log('Wallet:', wallet.address);
