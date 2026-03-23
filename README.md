# 🪙 CoinDrop — Dodo Payments Prototype

A single-page coin spending app to test Dodo Payments subscription upgrade/downgrade flow.

---

## What It Does

- User buys a plan (Starter $9/mo or Pro $29/mo) via Dodo Payments checkout
- Coins are credited on successful payment via webhook
- User clicks the big coin button to spend 1 coin per click
- User can upgrade (immediate) or downgrade (next billing cycle)

---

## Setup in 5 Steps

### Step 1 — Dodo Dashboard: Create Products

1. Go to https://app.dodopayments.com
2. Switch to **Test Mode** (top right toggle)
3. Go to **Products → New Product**
4. Create **Starter Plan**:
   - Name: Starter
   - Type: Subscription
   - Price: $9.00 / month
   - Copy the Product ID → this is your `STARTER_PRODUCT_ID`
5. Create **Pro Plan**:
   - Name: Pro
   - Type: Subscription
   - Price: $29.00 / month
   - Copy the Product ID → this is your `PRO_PRODUCT_ID`

### Step 2 — Dodo Dashboard: Get API Key

1. Go to **Developer → API Keys**
2. Create a **Test** API key
3. Copy it → this is your `DODO_API_KEY`

### Step 3 — Deploy to Railway

```bash
# Clone/push to GitHub first, then:
railway login
railway init
railway up
```

Or connect your GitHub repo in Railway dashboard.

After deploy, copy your Railway URL: `https://your-app.up.railway.app`

### Step 4 — Set Environment Variables in Railway

In Railway dashboard → your service → Variables, add:

```
DODO_API_KEY=sk_test_...
DODO_WEBHOOK_SECRET=...  (set this after step 5)
STARTER_PRODUCT_ID=prod_...
PRO_PRODUCT_ID=prod_...
BASE_URL=https://your-app.up.railway.app
```

### Step 5 — Dodo Dashboard: Create Webhook

1. Go to **Developer → Webhooks → Add Endpoint**
2. URL: `https://your-app.up.railway.app/api/webhooks/dodo`
3. Events to subscribe:
   - `subscription.active`
   - `subscription.plan_changed`
   - `subscription.cancelled`
   - `payment.failed`
4. Copy the **Signing Secret** → add as `DODO_WEBHOOK_SECRET` in Railway

---

## Test Cards (Dodo Test Mode)

| Card Number         | Result  |
|---------------------|---------|
| 4242 4242 4242 4242 | Success |
| 4000 0000 0000 0002 | Decline |

Use any future expiry date and any 3-digit CVV.

---

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/state` | GET | Get current coins, plan, stats |
| `/api/use-coin` | POST | Deduct 1 coin |
| `/api/create-checkout` | POST | Start Dodo subscription checkout |
| `/api/change-plan` | POST | Upgrade or schedule downgrade |
| `/api/webhooks/dodo` | POST | Dodo webhook receiver |
| `/api/reset` | POST | Dev: reset all state |

---

## Upgrade vs Downgrade Logic

| Action | Behavior |
|--------|----------|
| Upgrade (Starter → Pro) | Immediate charge via Dodo `difference_immediately`, coins added instantly |
| Downgrade (Pro → Starter) | Scheduled via Dodo, takes effect at next billing cycle |
| Renewal | Coins topped up automatically on each successful renewal webhook |

---

## Local Dev

```bash
cp .env.example .env
# Fill in .env values
npm install
npm run dev
```

Use [ngrok](https://ngrok.com) to expose your local server for webhooks:
```bash
ngrok http 3000
# Use the ngrok URL as BASE_URL and webhook endpoint in Dodo dashboard
```
