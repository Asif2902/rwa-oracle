import fetch from 'node-fetch';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
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
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const registryAbi = [
    "function submitPrice(uint256 pairId, uint256 price) external",
    "function submitPriceBatch(uint256[] calldata pairIds, uint256[] calldata prices) external",
    "function isSubmitter(address) view returns (bool)",
    "function pairCount() view returns (uint256)",
    "function getPair(uint256 pairId) view returns (tuple(uint256 pairId, string name, string symbol, uint8 category, string priceSource, string description, address synth, uint256 price, uint256 lastUpdated, uint256 maxStaleness, uint256 maxDeviation, bool active, bool frozen, uint256 createdAt))",
    "function getProtocolStats() view returns (uint256, uint256, uint256, uint256, address, address, bool)"
];
const registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);

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

async function updatePrices() {
    const pairIds = [];
    const prices = [];

    for (let symbol of Object.keys(PAIR_IDS)) {
        const price = await fetchPrice(symbol);
        if (price) {
            pairIds.push(PAIR_IDS[symbol]);
            prices.push(price);
        }
    }

    if (pairIds.length > 0) {
        try {
            const tx = await registry.submitPriceBatch(pairIds, prices);
            console.log(`[${new Date().toISOString()}] TX: ${tx.hash}`);
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

setInterval(updatePrices, 60_000);
updatePrices();

console.log('AchRWAOracle price feeder running...');
