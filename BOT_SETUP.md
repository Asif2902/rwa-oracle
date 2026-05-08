# Telegram Bot Setup Guide

## Features
- `/ok` - Check if oracle, monitor, backup services are active
- `/balance` - Check wallet balances for all services
- Automatic low balance alerts every 10 minutes (alerts when balance < 0.1 ETH by default)

## Setup Steps

### 1. Create a Telegram Bot
1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
4. Add to your `.env`:
   ```
   TG_TOKEN=your-bot-token-here
   ```

### 2. Get Your Chat ID
1. Start a chat with your new bot (click the link BotFather gave you)
2. Send `/start` to your bot
3. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Look for `"chat":{"id":...}` - this is your chat ID
5. Add to your `.env`:
   ```
   TG_CHAT_ID=your-chat-id-here
   ```

### 3. Configure Environment
Update your `.env` file with required variables:
```
# Telegram Bot (required)
TG_TOKEN=your-telegram-bot-token
TG_CHAT_ID=your-telegram-chat-id

# Wallet Addresses (public addresses for balance checks - no private keys needed)
ORACLE_ADDRESS=0xYourOracleWalletAddress
MONITOR_ADDRESS=0xYourMonitorWalletAddress
# BACKUP_ADDRESS=0x...  # Optional - only if you want to monitor backup wallet

# RPC URL (for balance checks)
RPC_URL=https://rpc.testnet.arc.network
```

### 4. Running the Bot

**Option A: Standalone**
```bash
npm run bot
```

**Option B: With PM2 (recommended for production)**
```bash
npm run pm2
```
This starts oracle, monitor, backup, and bot together.

**Check bot status:**
```bash
npm run pm2:status
```

**View bot logs:**
```bash
pm2 logs bot
```

## Usage

In your Telegram chat with the bot:
- Send `/ok` - Shows status of oracle, monitor, backup services
- Send `/balance` - Shows all wallet balances
- Send `/help` - Shows available commands

The bot will automatically send alerts when any wallet balance drops below 20 ETH.

## Notes
- The bot checks balances every 10 minutes
- Low balance alerts have a 1-hour cooldown to prevent spam
- **No IP addresses exposed**: Service URLs are hardcoded (localhost) - no env vars needed
- **Uses public wallet addresses**: No private keys needed for balance monitoring
- The `/ok` command checks oracle (3000) and monitor (3001) automatically
- Low balance threshold is hardcoded to 20 USDC
- Default ports when running locally:
  - Oracle: 3000
  - Monitor: 3001
  - Backup: 3002 (different VPS)
  - Bot: 8080
