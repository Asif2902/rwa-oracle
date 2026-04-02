# AchRWA Oracle — Security & Monitoring Architecture

## Overview

The AchRWA price oracle system is designed with **zero single points of failure**. Three independent services run on separate VPS servers, each with a different private key, across multiple RPC providers and price data sources.

---

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   ORACLE    │     │   MONITOR   │     │   BACKUP    │
│   (VPS 1)   │     │   (VPS 2)   │     │   (Railway)   │
│             │     │             │     │             │
│ Submits     │     │ Detects     │     │ Takes over  │
│ prices      │     │ deviations  │     │ if primary  │
│ every 60s   │     │ & stale     │     │ goes down   │
│             │     │ prices      │     │             │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │    ┌──────────────┴──────────────┐    │
       └────│      AchRWAOracle.sol       │────┘
            │   0x76398cfa...5ABdB        │
            └─────────────────────────────┘
```

---

## Components

### 1. Oracle (Primary Price Feeder)

| Property | Value |
|----------|-------|
| **File** | `oracle.js` |
| **Host** | VPS 1 |
| **Wallet** | `0x20262821B19ADf7BC1f61bEd48f5D254898E42B4` |
| **Role** | Authorized price submitter |
| **Interval** | Every 60 seconds |

**What it does:**
- Fetches real-time prices for 5 RWA pairs (AAPL, GOOGL, WTI, Gold, Silver)
- Submits prices to the on-chain oracle via `submitPriceBatch()`
- Uses 4 RPC endpoints with automatic failover
- Retries failed transactions up to 3 times with RPC rotation

**Price Sources (per asset):**

| Asset | Primary | Backup 1 | Backup 2 |
|-------|---------|----------|----------|
| AAPL | Yahoo Finance | Yahoo query2 | stockprices.dev |
| GOOGL | Yahoo Finance | Yahoo query2 | stockprices.dev |
| WTI | Yahoo Finance | Yahoo query2 | — |
| Gold | Yahoo Finance | Yahoo query2 | — |
| Silver | Yahoo Finance | Yahoo query2 | — |

---

### 2. Monitor (Deviation & Staleness Watcher)

| Property | Value |
|----------|-------|
| **File** | `monitor.js` |
| **Host** | VPS 2 |
| **Wallet** | `0x6e0df2d65d309b55B217B5237657302386E75584` |
| **Role** | Authorized price submitter (backup) |
| **Interval** | Every 30 seconds |

**What it does:**
- Reads on-chain prices from the oracle contract
- Fetches current prices from external APIs
- Compares on-chain vs API prices
- **If deviation ≥ 50%**: Immediately submits the correct price
- **If price is stale (>5 min)**: Immediately submits a fresh price
- Detects compromised or malfunctioning oracle submissions

**Detection logic:**
```
deviation = |on_chain_price - api_price| / on_chain_price * 10000 (BPS)
if deviation ≥ 5000 BPS (50%) → submit correction
if age > 300 seconds → submit correction
```

---

### 3. Backup (Failover Server)

| Property | Value |
|----------|-------|
| **File** | `backup.js` |
| **Host** | Railway |
| **Wallet** | `0x6e0df2d65d309b55B217B5237657302386E75584` |
| **Role** | Failover price submitter |
| **Interval** | Every 30 seconds |

**What it does:**
- Monitors the oracle contract on-chain via ArcScan API
- Checks if any transaction was submitted in the last 5 minutes
- **If no tx in 5 min**: Takes over and submits prices
- **If primary comes back online**: Returns to standby mode

**Detection logic:**
```
last_tx_age = now - last_transaction_timestamp
if last_tx_age > 300 seconds → ACTIVATE backup
if last_tx_age < 300 seconds → DEACTIVATE backup
```

---

## RPC Redundancy

All services use 4 RPC endpoints with automatic failover:

| Priority | Provider | URL |
|----------|----------|-----|
| 1 | Arc Official | `https://rpc.testnet.arc.network` |
| 2 | Blockdaemon | `https://rpc.blockdaemon.testnet.arc.network` |
| 3 | dRPC | `https://rpc.drpc.testnet.arc.network` |
| 4 | QuickNode | `https://rpc.quicknode.testnet.arc.network` |

---

## Failure Scenarios & Response

| Failure | Detected By | Response Time | Action |
|---------|-------------|---------------|--------|
| Oracle VPS crashes | Backup | 5 min | Backup takes over |
| RPC endpoint down | Oracle | Immediate | Switch to next RPC |
| Yahoo Finance down | Oracle | Immediate | Use backup price source |
| Price manipulated | Monitor | 30 sec | Submit correct price |
| Gas runs out | Oracle/Backup | Next tx | Log error, alert |
| Network partition | Backup | 5 min | Backup activates |
| Private key compromise | Monitor | 30 sec | Monitor corrects prices |

---

## Smart Contract Addresses

| Contract | Address |
|----------|---------|
| **AchRWAOracle** | `0x76398cfa526D4a76EaEC0c4709d6B7C966E5ABdB` |
| **Network** | Arc Testnet (Chain ID: 5042002) |
| **Explorer** | [testnet.arcscan.app](https://testnet.arcscan.app) |

---

## Authorized Submitters

| Role | Address | Key Owner |
|------|---------|-----------|
| Primary Oracle | `0x20262821B19ADf7BC1f61bEd48f5D254898E42B4` | VPS 1 |
| Monitor | `0x6e0df2d65d309b55B217B5237657302386E75584` | VPS 2 |
| Backup | `0x6e0df2d65d309b55B217B5237657302386E75584` | Railway |

---

## PM2 Process Management

All services run under PM2 for auto-restart:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

This ensures services survive:
- Process crashes (auto-restart)
- Server reboots (startup script)
- Memory leaks (restart at 200MB)

---

## Deployment

```bash
# VPS 1 — Oracle
git clone https://github.com/Asif2902/rwa-oracle.git
cd rwa-oracle && npm install
cp .env.example .env && nano .env
pm2 start oracle.js --name oracle

# VPS 2 — Monitor
git clone https://github.com/Asif2902/rwa-oracle.git
cd rwa-oracle && npm install
cp .env.example .env && nano .env
pm2 start monitor.js --name monitor

# VPS 3 — Backup
git clone https://github.com/Asif2902/rwa-oracle.git
cd rwa-oracle && npm install
cp .env.example .env && nano .env
pm2 start backup.js --name backup
```

---

## Summary

**No single point of failure.** The system can survive:
- Any one VPS going down
- Any one RPC provider failing
- Any one price source going offline
- Any one private key being compromised
- Any one server rebooting

The oracle will continue submitting accurate prices as long as at least one service is running.
