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
    "function submitPriceBatch(uint256[] calldata pairIds, uint256[] calldata prices) external"
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
            console.log(`Submitted prices at ${new Date().toISOString()}:`, pairIds.map((id,i) => `${id}=${ethers.formatUnits(prices[i],18)}`));
            await tx.wait();
        } catch (err) {
            console.error("Error submitting prices:", err.message);
        }
    }
}

setInterval(updatePrices, 60_000);

updatePrices();

console.log('Oracle service running...');
