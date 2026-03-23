require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "db.json");

// ─── Dodo Payments Config ───────────────────────────────────────────────────
const DODO_API_BASE = "https://api.dodopayments.com";
const DODO_API_KEY = process.env.DODO_API_KEY;
const DODO_WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const PLANS = {
  starter: {
    name: "Starter",
    productId: process.env.STARTER_PRODUCT_ID,
    price: 9,
    coins: 1000,
  },
  pro: {
    name: "Pro",
    productId: process.env.PRO_PRODUCT_ID,
    price: 29,
    coins: 5000,
  },
};

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// Raw body for webhook signature verification
app.use("/api/webhooks/dodo", express.raw({ type: "application/json" }));

// JSON for all other routes
app.use((req, res, next) => {
  if (req.path === "/api/webhooks/dodo") return next();
  express.json()(req, res, next);
});

// ─── Simple JSON "Database" ─────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      user: {
        email: "test@example.com",
        name: "Test User",
        coins: 0,
        plan: null, // null | "starter" | "pro"
        subscriptionId: null,
        pendingDowngradeTo: null, // plan key if downgrade scheduled
        totalCoinsUsed: 0,
      },
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── Dodo API Helper ────────────────────────────────────────────────────────
async function dodoRequest(method, endpoint, body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${DODO_API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${DODO_API_BASE}${endpoint}`, options);
  const data = await res.json();

  if (!res.ok) {
    console.error("Dodo API error:", data);
    throw new Error(data.message || "Dodo API request failed");
  }
  return data;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /api/state — Return current user state
app.get("/api/state", (req, res) => {
  const db = loadDB();
  res.json({
    ...db.user,
    plans: PLANS,
  });
});

// POST /api/create-checkout — Create Dodo subscription checkout
app.post("/api/create-checkout", async (req, res) => {
  const { planKey } = req.body;
  const plan = PLANS[planKey];

  if (!plan) return res.status(400).json({ error: "Invalid plan" });
  if (!plan.productId)
    return res
      .status(500)
      .json({ error: `Missing product ID for plan: ${planKey}. Set ${planKey.toUpperCase()}_PRODUCT_ID in .env` });

  const db = loadDB();
  const user = db.user;

  try {
    // Create subscription checkout via Dodo
    const checkout = await dodoRequest("POST", "/subscriptions", {
      billing: {
        city: "San Francisco",
        country: "US",
        state: "CA",
        street: "123 Test St",
        zipcode: "94105",
      },
      customer: {
        email: user.email,
        name: user.name,
        create_new_customer: false,
      },
      payment_link: true,
      product_id: plan.productId,
      quantity: 1,
      return_url: `${BASE_URL}/?payment=success&plan=${planKey}`,
      metadata: {
        planKey,
        userId: "test-user",
      },
    });

    res.json({ checkoutUrl: checkout.payment_link, subscriptionId: checkout.subscription_id });
  } catch (err) {
    console.error("Checkout creation failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/change-plan — Upgrade or downgrade subscription
app.post("/api/change-plan", async (req, res) => {
  const { planKey } = req.body;
  const plan = PLANS[planKey];

  if (!plan) return res.status(400).json({ error: "Invalid plan" });

  const db = loadDB();
  const user = db.user;

  if (!user.subscriptionId) {
    return res.status(400).json({ error: "No active subscription" });
  }

  const currentPlanPrice = PLANS[user.plan]?.price || 0;
  const isUpgrade = plan.price > currentPlanPrice;

  try {
    // Dodo Change Plan API
    const result = await dodoRequest(
      "PATCH",
      `/subscriptions/${user.subscriptionId}/change-plan`,
      {
        product_id: plan.productId,
        quantity: 1,
        // Upgrade: charge immediately. Downgrade: credit on next cycle.
        proration_billing_mode: isUpgrade
          ? "difference_immediately"
          : "difference_immediately",
        on_payment_failure: "prevent_change",
      }
    );

    if (isUpgrade) {
      // Upgrade: apply immediately + grant coins
      db.user.plan = planKey;
      db.user.coins += plan.coins;
      db.user.pendingDowngradeTo = null;
      saveDB(db);

      res.json({
        success: true,
        message: `Upgraded to ${plan.name}! +${plan.coins} coins added.`,
        isUpgrade: true,
        newCoins: db.user.coins,
      });
    } else {
      // Downgrade: schedule for next billing cycle (don't change plan yet)
      db.user.pendingDowngradeTo = planKey;
      saveDB(db);

      res.json({
        success: true,
        message: `Downgrade to ${plan.name} scheduled. Takes effect at next billing cycle.`,
        isUpgrade: false,
        pendingDowngrade: planKey,
      });
    }
  } catch (err) {
    console.error("Plan change failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/use-coin — Deduct 1 coin
app.post("/api/use-coin", (req, res) => {
  const db = loadDB();
  const user = db.user;

  if (user.coins <= 0) {
    return res.status(400).json({ error: "No coins left! Buy a plan to get more." });
  }

  db.user.coins -= 1;
  db.user.totalCoinsUsed += 1;
  saveDB(db);

  res.json({
    success: true,
    coins: db.user.coins,
    totalCoinsUsed: db.user.totalCoinsUsed,
  });
});

// POST /api/reset — Reset user state (dev helper)
app.post("/api/reset", (req, res) => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  loadDB(); // recreates fresh
  res.json({ success: true, message: "State reset to fresh" });
});

// ─── Webhook Handler ─────────────────────────────────────────────────────────
app.post("/api/webhooks/dodo", (req, res) => {
  const rawBody = req.body;
  const signature = req.headers["webhook-signature"];
  const timestamp = req.headers["webhook-timestamp"];
  const webhookId = req.headers["webhook-id"];

  // Verify signature
  if (DODO_WEBHOOK_SECRET) {
    try {
      const signedContent = `${webhookId}.${timestamp}.${rawBody.toString()}`;
      const secretBytes = Buffer.from(DODO_WEBHOOK_SECRET.split("_")[1] || DODO_WEBHOOK_SECRET, "base64");
      const expectedSig = crypto
        .createHmac("sha256", secretBytes)
        .update(signedContent)
        .digest("base64");

      const sigList = signature.split(" ");
      const isValid = sigList.some((sig) => {
        const [, sigValue] = sig.split(",");
        return sigValue === expectedSig;
      });

      if (!isValid) {
        console.error("Invalid webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
    } catch (err) {
      console.error("Signature verification error:", err.message);
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  console.log(`📨 Webhook received: ${event.type}`, JSON.stringify(event.data, null, 2));

  const db = loadDB();

  switch (event.type) {
    // ── Subscription activated (new purchase or renewal) ─────────────────
    case "subscription.active": {
      const sub = event.data;
      const productId = sub.product_id;

      // Find which plan matches this product
      const planKey = Object.keys(PLANS).find(
        (k) => PLANS[k].productId === productId
      );
      if (!planKey) break;

      const plan = PLANS[planKey];

      // Check if this is a renewal (same plan) or new subscription
      const isRenewal = db.user.subscriptionId === sub.subscription_id;

      if (isRenewal) {
        // On renewal, if there was a pending downgrade — apply it now
        if (db.user.pendingDowngradeTo) {
          const downgradePlan = PLANS[db.user.pendingDowngradeTo];
          db.user.plan = db.user.pendingDowngradeTo;
          db.user.coins += downgradePlan.coins;
          db.user.pendingDowngradeTo = null;
          console.log(`✅ Downgrade applied to ${db.user.plan}`);
        } else {
          // Regular renewal: top up coins
          db.user.coins += plan.coins;
          console.log(`🔄 Renewal: +${plan.coins} coins for ${planKey}`);
        }
      } else {
        // New subscription
        db.user.plan = planKey;
        db.user.coins += plan.coins;
        db.user.subscriptionId = sub.subscription_id;
        console.log(`✅ New subscription: ${planKey} (+${plan.coins} coins)`);
      }

      saveDB(db);
      break;
    }

    // ── Plan changed (Dodo confirms the plan change) ──────────────────────
    case "subscription.plan_changed": {
      const sub = event.data;
      console.log(`📋 Plan changed event received for sub ${sub.subscription_id}`);
      break;
    }

    // ── Subscription cancelled or expired ─────────────────────────────────
    case "subscription.cancelled":
    case "subscription.expired": {
      db.user.plan = null;
      db.user.subscriptionId = null;
      db.user.pendingDowngradeTo = null;
      saveDB(db);
      console.log(`❌ Subscription ended`);
      break;
    }

    // ── Payment failed ─────────────────────────────────────────────────────
    case "payment.failed": {
      console.log(`⚠️ Payment failed for subscription`);
      break;
    }

    default:
      console.log(`ℹ️ Unhandled event: ${event.type}`);
  }

  res.json({ received: true });
});

// ─── Start Server ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🪙 Dodo Coins running on http://localhost:${PORT}`);
  console.log(`📦 Plans:`, Object.keys(PLANS).map((k) => `${k}=${PLANS[k].productId || "⚠️ NOT SET"}`).join(", "));
});
