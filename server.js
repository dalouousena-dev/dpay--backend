const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("🔥 Unhandled Rejection:", err);
});
const app = express();
app.use(express.json());
/* ===== IMPORTANT FOR RENDER ===== */
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

/* ===== MIDDLEWARE ===== */
app.use(cors());

/* ===== SUPABASE INITIALIZATION ===== */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('✅ Supabase initialized at', supabaseUrl);
} else {
  console.warn('⚠️ Supabase credentials not found. Using file-based storage.');
}

/* ===== NOTCHPAY INITIALIZATION ===== */

const notchpayPublicKey = process.env.NOTCHPAY_PUBLIC_KEY;
const NOTCHPAY_API_KEY = process.env.NOTCHPAY_API_KEY;
const notchpayHashKey = process.env.NOTCHPAY_HASH_KEY;

if (!process.env.NOTCHPAY_API_KEY) {
  console.error("❌ NOTCHPAY_API_KEY missing");
}

// ===== FILE-BASED STORAGE (Fallback) =====

// in-memory storage (persisted to users.json)
const DATA_FILE = path.join(__dirname, 'users.json');
const ADMIN_TOKEN_FILE = path.join(__dirname, 'admin_token.json');

let users = [];            // regular user objects
let adminToken = null;       // simple admin session token
let pendingWithdrawals = [];  // withdrawal requests from users

function loadUsers() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      users = JSON.parse(raw) || [];
      console.log('Loaded', users.length, 'users from', DATA_FILE);
    }
  } catch (err) {
    console.error('Failed to load users file:', err);
    users = [];
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save users file:', err);
  }
}

function loadAdminToken() {
  try {
    if (fs.existsSync(ADMIN_TOKEN_FILE)) {
      const raw = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8');
      const data = JSON.parse(raw);
      adminToken = data.token;
      console.log('✅ Loaded admin token from', ADMIN_TOKEN_FILE);
    }
  } catch (err) {
    console.error('Failed to load admin token file:', err);
    adminToken = null;
  }
}

function saveAdminToken() {
  try {
    fs.writeFileSync(ADMIN_TOKEN_FILE, JSON.stringify({ token: adminToken }, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save admin token file:', err);
  }
}

// load persisted data at startup
loadUsers();
loadAdminToken();

// helper to create a simple token
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

// helper to create a UUID (v4)
function makeUUID() {
  // Use crypto.randomUUID if available (Node 15+), otherwise generate manually
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: Generate UUID v4 manually
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// helper to create a unique referral code
function makeReferralCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

// find user by auth token
function findUserByToken(token) {
  return users.find(u => u.token === token);
}

// find user by referral code
function findUserByReferralCode(code) {
  return users.find(
    u => u.referral_code === code || u.referralCode === code
  );
}

// calculate commission tier based on referral count
function getCommissionTier(referralCount) {
  if (referralCount >= 100) return { commissionPercent: 0.20, commission: '20%', daily: 6000, bonusAmount: 0, bonus: 'Elite Partner - VIP benefits', badge: '👑' };
  if (referralCount >= 51) return { commissionPercent: 0.15, commission: '15%', daily: 2250, bonusAmount: 15000, bonus: '15,000 FCFA bonus', badge: '💎' };
  if (referralCount >= 31) return { commissionPercent: 0.12, commission: '12%', daily: 840, bonusAmount: 5000, bonus: '5,000 FCFA bonus', badge: '🌟' };
  if (referralCount >= 16) return { commissionPercent: 0.10, commission: '10%', daily: 300, bonusAmount: 2000, bonus: '2,000 FCFA bonus', badge: '👨‍💼' };
  if (referralCount >= 6) return { commissionPercent: 0.07, commission: '7%', daily: 105, bonusAmount: 500, bonus: '500 FCFA bonus', badge: '👥' };
  if (referralCount >= 1) return { commissionPercent: 0.05, commission: '5%', daily: 25, bonusAmount: 0, bonus: 'Standard Member', badge: '👤' };
  return { commissionPercent: 0, commission: '0%', daily: 0, bonusAmount: 0, bonus: 'No referrals yet', badge: '👤' };
}

// Check if user reached a new tier and return bonus to credit
function checkTierUpgrade(previousReferralCount, newReferralCount) {
  const previousTier = getCommissionTier(previousReferralCount);
  const newTier = getCommissionTier(newReferralCount);
  // If bonus amount increased, return the difference
  if (newTier.bonusAmount > previousTier.bonusAmount) {
    return newTier.bonusAmount - previousTier.bonusAmount;
  }
  return 0;
}

// ===== SUPABASE HELPER FUNCTIONS =====

// Fetch user from Supabase or file fallback
async function getUserByToken(token) {
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('token', token)
      .single();
    if (!error) return data;
  }
  return findUserByToken(token);
}

// Fetch user by email
async function getUserByEmail(email) {
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    if (!error) return data;
  }
  return users.find(u => u.email === email);
}

// Create user in Supabase or file fallback
async function createUser(userData) {
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .insert([userData])
      .select()
      .single();
   
    console.error('Supabase insert error:', error);
  }
 
}

// Update user in Supabase or file fallback
async function updateUser(userId, updates) {
  if (!supabase) {
    throw new Error("Supabase not initialized");
  }

  const { data, error } = await supabase
    .from("users")
    .update(updates)
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    console.error("❌ updateUser failed:", error);
    throw error; // 🔴 NEVER swallow this
  }

  return data;
}
 // ✅ REGISTER ROUTE ENDS HERE

  // Check if user already exists
app.post('/api/auth/register', async (req, res) => {

  const { 
    email,
    password,
    username,
    firstName,
    lastName,
    phoneNumber,
    referralCode
  } = req.body;

  if (!email || !password || !username) {
    return res.status(400).json({
      message: "Email, username and password are required"
    });
  }

  try {

    const existingUser = await getUserByEmail(email);

    if (existingUser) {
      return res.status(409).json({
        message: "User already exists"
      });
    }

    let referrerId = null;

    if (referralCode) {

      const referrer = findUserByReferralCode(referralCode);

      if (!referrer) {
        return res.status(400).json({
          message: "Invalid referral code"
        });
      }

      referrerId = referrer.id;
    }

    const newUser = {
      id: makeUUID(),

      email,
      password,
      username,

      first_name: firstName || "",
      last_name: lastName || "",
      phone_number: phoneNumber || "",

      created_at: new Date().toISOString(),

      active_plan: null,
      next_purchase_window_ends: null,
      withdrawal_available_at: null,
      last_transaction_date: null,
      last_product_purchase: null,

      wallet_balance: 0,
      total_profits: 0,
      total_deposited: 0,

      token: makeToken(),

      referral_code: makeReferralCode(),
      referrer_id: referrerId,
      referral_count: 0
    };

    const createdUser = await createUser(newUser);

    // Handle referral bonuses
    if (referrerId) {

      const referrer = users.find(u => u.id === referrerId);

      if (referrer) {

        const previousCount = referrer.referral_count || 0;

        referrer.referral_count = previousCount + 1;

        const tierBonus = checkTierUpgrade(previousCount, referrer.referral_count);

        if (tierBonus > 0) {

          referrer.wallet_balance = (referrer.wallet_balance || 0) + tierBonus;

          const tier = getCommissionTier(referrer.referral_count);

          await logTransaction(
            referrerId,
            "referral_tier_bonus",
            tierBonus,
            `Tier upgrade bonus - reached ${tier.commission} commission tier`
          );
        }
      }
    }

    return res.status(201).json({
      message: "User created",
      token: createdUser.token,
      userId: createdUser.id
    });

  } catch (err) {

    console.error("Registration error:", err);

    return res.status(500).json({
      message: "Registration failed"
    });

  }

});
app.get("/api/payment-status", async (req, res) => {
  const ref = req.query.ref;

  if (!ref) {
    return res.status(400).json({ message: "Missing reference" });
  }

  const { data, error } = await supabase
    .from("pending_payments")
    .select("status, plan_id")
    .eq("notchpay_reference", ref)
    .single();

  if (error || !data) {
    return res.status(404).json({ message: "Payment not found" });
  }

  return res.json({
    status: data.status,
    plan: data.plan_id
  });
});

app.post('/api/auth/admin-login', async (req, res) => {
  try {

    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    // Read environment variables safely
    const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      console.error("Admin credentials not configured in environment variables");
      return res.status(500).json({ message: "Admin credentials not configured" });
    }

    // Normalize user input
    const inputEmail = email.trim().toLowerCase();
    const inputPassword = password.trim();

    console.log("Admin login attempt:");
    console.log("Input email:", inputEmail);
    console.log("Env email:", ADMIN_EMAIL);

    if (inputEmail === ADMIN_EMAIL && inputPassword === ADMIN_PASSWORD) {

      adminToken = makeToken();
      saveAdminToken();

      return res.json({
        message: "Admin login successful",
        token: adminToken
      });
    }

    return res.status(401).json({ message: "Invalid admin credentials" });

  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ message: "Server error during admin login" });
  }
});
// --- user/profile and transactions ---


app.get('/api/users/profile', async (req, res) => {
  try {

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        message: "Missing authorization token"
      });
    }

    const token = authHeader.split(" ")[1];

    console.log("TOKEN RECEIVED:", token);

    if (!token) {
      return res.status(401).json({
        message: "Invalid token"
      });
    }

    if (!supabase) {
      console.error("Supabase not initialized");
      return res.status(500).json({
        message: "Database connection error"
      });
    }

    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("token", token)
      .limit(1)
      .single();

    if (error || !data) {
      console.error("Supabase error:", error);
      return res.status(401).json({
        message: "Invalid or missing token"
      });
    }

    console.log("USER FOUND:", data.email);

    // remove password
    const { password, ...publicData } = data;

    // 🔵 map database field to frontend field
    const formattedUser = {
      ...publicData,
      activePlan: publicData.active_plan || null
    };

    return res.json(formattedUser);

  } catch (err) {

    console.error("Error fetching profile:", err);

    return res.status(500).json({
      message: "Error fetching profile"
    });

  }
});
// --- referral endpoints ---

app.get('/api/referral/stats', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  
  try {
    let user;
    user = findUserByToken(token);
    if (!user) {
      if (supabase) {
        const { data, error } = await supabase
          .from('users')
          .select('*')
          .eq('token', token)
          .single();
        if (!error && data) {
          user = data;
        }
      }
    }
    if (!user) {
      return res.status(401).json({ message: 'Invalid or missing token' });
    }

    const referralCount = user.referral_count || user.referralCount || 0;
    const tier = getCommissionTier(referralCount);

    res.json({
      referralCode: user.referral_code || user.referralCode,
      referralCount: referralCount,
      commission: tier.commission,
      dailyEarnings: tier.daily,
      bonus: tier.bonus,
      badge: tier.badge,
    });
  } catch (err) {
    console.error('Error fetching referral stats:', err);
    res.status(500).json({ message: 'Error fetching referral stats' });
  }
});

app.post("/api/plans/purchase", async (req, res) => {
  try {
    const { planId } = req.body;
    let email = req.body.email;

    const apiKey = process.env.NOTCHPAY_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ message: "Server configuration error" });
    }

    if (!planId) {
      return res.status(400).json({ message: "Plan ID is required" });
    }

    // 🔥 NEVER trust frontend amount
    const PLAN_PRICES = {
      vip1: 10000,
      vip2: 25000
    };

    const amount = PLAN_PRICES[planId];

    if (!amount) {
      return res.status(400).json({ message: "Invalid plan" });
    }

    // Extract email from token if missing
    if (!email) {
      const authHeader = req.headers.authorization;

      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const token = authHeader.split(" ")[1];
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          email = decoded.email;
        } catch (err) {
          console.log("⚠ Could not decode token:", err.message);
        }
      }
    }

    if (!email) {
      return res.status(400).json({
        message: "User email is required for payment"
      });
    }

    const merchantReference = `plan_${planId}_${Date.now()}`;

    // ✅ store BEFORE payment
    await supabase.from("pending_payments").insert({
      merchant_reference: merchantReference,
      user_email: email,
      plan_id: planId,
      amount: amount,
      status: "pending"
    });

    const baseURL = apiKey.startsWith("sk_test")
      ? "https://apisandbox.notchpay.co"
      : "https://api.notchpay.co";


const successUrl = `https://computerarchi.com/?ref=${merchantReference}`;
// ⚠️ change this to your real frontend URL when deployed

const paymentData = {
  amount,
  currency: "XAF",
  description: `Purchase of plan ${planId}`,
   email,
  callback: "https://dpaybackend.onrender.com/api/notchpay/webhook", // webhook (keep)
return_url: successUrl, 

  
  metadata: {
    merchant_reference: merchantReference,
    email,
    planId
  }
};

    const response = await fetch(`${baseURL}/payments`, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(paymentData)
    });

    let data;

    try {
      data = await response.json();
    } catch (err) {
      console.error("❌ Failed to parse NotchPay response:", err);
      return res.status(500).json({
        message: "Invalid response from payment provider"
      });
    }

    console.log("NOTCHPAY INIT RESPONSE:", JSON.stringify(data, null, 2));

    if (!response.ok && data.code !== 201) {
      return res.status(500).json({
        message: "NotchPay initialization failed",
        notchpay_response: data
      });
    }

    const paymentUrl = data?.authorization_url;

    if (!paymentUrl) {
      console.error("❌ Missing payment URL:", data);
      return res.status(500).json({
        message: "Payment URL missing",
        notchpay_response: data
      });
    }

    const reference =
      data?.transaction?.reference ||
      data?.reference ||
      merchantReference;

    // ✅ link notchpay reference
    await supabase
      .from("pending_payments")
      .update({ notchpay_reference: reference })
      .eq("merchant_reference", merchantReference);

    const redirectAfterPayment = `https://computerarchi.com/?ref=${merchantReference}`;

// Force redirect param into checkout URL
const finalPaymentUrl = `${paymentUrl}?return_url=${encodeURIComponent(redirectAfterPayment)}`;

return res.json({
  success: true,
  paymentUrl: finalPaymentUrl,
  reference
});

  } catch (err) {
    console.error("❌ Plan purchase error:", err);

    return res.status(500).json({
      message: "Payment initialization failed"
    });
  }
});

app.get("/api/notchpay/callback", async (req, res) => {
  try {
    const { reference } = req.query;

    if (!reference) {
      return res.status(400).send("Missing reference");
    }

    console.log("🔁 Callback hit with reference:", reference);

    const apiKey = process.env.NOTCHPAY_API_KEY;

    const baseURL = apiKey.startsWith("sk_test")
      ? "https://apisandbox.notchpay.co"
      : "https://api.notchpay.co";

    // 🔍 VERIFY PAYMENT DIRECTLY
    const verifyResponse = await fetch(`${baseURL}/payments/${reference}`, {
      method: "GET",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json"
      }
    });

    const data = await verifyResponse.json();

    if (!verifyResponse.ok) {
      console.error("❌ Verification failed:", data);
      return res.redirect(`https://computerarchi.com/payment-error`);
    }

    const payment = data.transaction || data;

    if (!payment) {
      return res.redirect(`https://computerarchi.com/payment-error`);
    }

    // ⚠️ DO NOT trust blindly
    if (!["complete", "completed", "success"].includes(payment.status)) {
      return res.redirect(`https://computerarchi.com/payment-pending`);
    }

    console.log("✅ Payment verified via callback:", reference);

    // 🔁 OPTIONAL SAFETY: ensure DB is updated
    const { data: pending } = await supabase
      .from("pending_payments")
      .select("*")
      .eq("notchpay_reference", reference)
      .single();

    if (pending && pending.status !== "completed") {
      await supabase
        .from("pending_payments")
        .update({ status: "completed" })
        .eq("notchpay_reference", reference);

      await supabase
        .from("users")
        .update({
          active_plan: pending.plan_id
        })
        .eq("email", pending.user_email);

      console.log("⚡ Fallback update executed");
    }

    // ✅ FINAL REDIRECT TO FRONTEND
    return res.redirect(`https://computerarchi.com/?ref=${reference}&status=success`);

  } catch (err) {
    console.error("🔥 Callback error:", err);
    return res.redirect(`https://computerarchi.com/payment-error`);
  }
});

app.get("/api/payments/check/:reference", async (req, res) => {
  try {
    const { reference } = req.params;

    if (!reference) {
      return res.status(400).json({ message: "Missing reference" });
    }

    const apiKey = process.env.NOTCHPAY_API_KEY;

    const baseURL = apiKey.startsWith("sk_test")
      ? "https://apisandbox.notchpay.co"
      : "https://api.notchpay.co";

    const endpoint = `${baseURL}/payments/${reference}`;

    const verifyResponse = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json"
      }
    });

    const verifyData = await verifyResponse.json();

    if (!verifyResponse.ok) {
      console.error("NotchPay verification failed:", verifyData);
      return res.status(400).json({
        message: "Verification failed",
        notchpay: verifyData
      });
    }

    const transaction = verifyData.transaction || verifyData;

    if (!transaction) {
      return res.status(400).json({ message: "Transaction missing" });
    }

    // Not completed yet
    if (!["complete", "completed", "success"].includes(transaction.status)) {
      return res.json({ status: transaction.status });
    }

    const amount = Number(transaction.amount) || 0;

    const email =
      transaction.customer_email ||
      transaction.customer?.email ||
      transaction.metadata?.email ||
      null;

    // ✅ Fetch user correctly
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (userError || !user) {
      return res.status(404).json({ message: "User not found" });
    }

    const newTotalDeposited = (user.total_deposited || 0) + amount;
    const newWalletBalance = (user.wallet_balance || 0) + amount;

    // ✅ Update user
    await supabase
      .from("users")
      .update({
        active_plan: planId,
        wallet_balance: newWalletBalance,
        total_deposited: newTotalDeposited,
        withdrawal_available_at: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        )
      })
      .eq("email", email);

    // ✅ Log transaction
    await supabase
      .from("transactions")
      .insert({
        user_email: email,
        type: "plan_purchase",
        description: `Purchase of plan ${planId}`,
        amount: amount,
        status: "completed",
        reference: transaction.reference,
        at: new Date()
      });

    console.log("✅ Plan activated via polling:", email, planId);

    return res.json({
      status: "complete",
      reference: transaction.reference
    });

  } catch (err) {
    console.error("❌ Payment polling error:", err);

    return res.status(500).json({
      message: "Verification error"
    });
  }
});


// Payment verification stub - in real app this would be called by payment gateway webhook

app.post("/api/notchpay/webhook", async (req, res) => {
  try {
    console.log("🔔 NotchPay callback received:", JSON.stringify(req.body, null, 2));

    const event = req.body.event;
    const payment = req.body.data;

    if (!payment) {
      console.error("❌ Missing payment data");
      return res.status(400).json({ message: "Invalid payload" });
    }

    // Ignore irrelevant events
    if (!event || !event.includes("payment")) {
      console.log("⏭ Ignored non-payment event:", event);
      return res.sendStatus(200);
    }

    // Only process successful payments
    const validStatuses = ["complete", "completed", "success"];
    if (!validStatuses.includes(payment.status)) {
      console.log("⏭ Ignored payment with status:", payment.status);
      return res.sendStatus(200);
    }

    const notchpayRef = payment.reference;

    if (!notchpayRef) {
      console.error("❌ Missing payment reference");
      return res.sendStatus(400);
    }

    console.log("🔎 Processing reference:", notchpayRef);

    // 🔥 FIND PAYMENT USING NOTCHPAY REFERENCE
    const { data: pendingPayment, error } = await supabase
      .from("pending_payments")
      .select("*")
      .eq("notchpay_reference", notchpayRef)
      .single();

    if (error || !pendingPayment) {
      console.error("❌ Pending payment not found:", notchpayRef);
      return res.status(404).json({ message: "Pending payment not found" });
    }

    // Prevent double processing
    if (pendingPayment.status === "completed") {
      console.log("⚠️ Already processed:", notchpayRef);
      return res.sendStatus(200);
    }

const expectedAmount = pendingPayment.amount; // or whatever column you store

if (payment.amount !== expectedAmount) {
  console.error("❌ Amount mismatch:", {
    expected: expectedAmount,
    received: payment.amount
  });
  return res.sendStatus(400);
}
    // Update payment
    const { error: updateError } = await supabase
      .from("pending_payments")
      .update({
        status: "completed",
        completed_at: new Date().toISOString()
      })
      .eq("notchpay_reference", notchpayRef);

    if (updateError) {
      console.error("❌ Failed to update pending payment:", updateError);
      return res.sendStatus(500);
    }

    // Update user
    const { error: userError } = await supabase
      .from("users")
      .update({
        active_plan: pendingPayment.plan_id
      })
      .eq("email", pendingPayment.user_email);

    if (userError) {
      console.error("❌ Failed to update user:", userError);
      return res.sendStatus(500);
    }
    await supabase.from("transactions").insert({
  user_email: pendingPayment.user_email,
  amount: payment.amount,
  type: "plan_purchase",
  reference: notchpayRef,
  status: "completed"
});

    console.log("✅ Payment fully processed:", {
      reference: notchpayRef,
      email: pendingPayment.user_email,
      plan: pendingPayment.plan_id
    });

    return res.sendStatus(200);

  } catch (err) {
    console.error("🔥 Webhook crash:", err);
    return res.sendStatus(500);
  }
});

app.get("/api/transactions", async (req, res) => {
  try {

    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        message: "Failed to fetch transactions",
        error
      });
    }

    res.json(data);

  } catch (err) {

    console.error("Transaction fetch error:", err);

    res.status(500).json({
      message: "Server error"
    });

  }
});


app.get("/api/users/profile", async (req, res) => {
  try {

    // Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Missing authorization token" });
    }

    const token = authHeader.split(" ")[1];

    // Fetch user
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("token", token)
      .single();

    if (error || !user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Return fields using database names
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,

      active_plan: user.active_plan,
      wallet_balance: user.wallet_balance,
      total_deposited: user.total_deposited,
      total_profits: user.total_profits,

      withdrawal_available_at: user.withdrawal_available_at,
      last_transaction_date: user.last_transaction_date,
      last_product_purchase: user.last_product_purchase,

      created_at: user.created_at,
      referral_code: user.referral_code,
      is_active: user.is_active
    });

  } catch (err) {

    console.error("Profile error:", err);

    res.status(500).json({ message: "Failed to load profile" });

  }
});

// Health check endpoint for NotchPay webhook configuration
app.get('/api/webhooks/notchpay/health', (req, res) => {

  const notchpayHashKey = process.env.NOTCHPAY_HASH_KEY;
  const notchpayApiKey = process.env.NOTCHPAY_API_KEY;

  const isConfigured = !!(notchpayHashKey && notchpayApiKey);

  res.json({
    status: isConfigured ? 'ready' : 'not-configured',
    hasHashKey: !!notchpayHashKey,
    hasSecretKey: !!notchpayApiKey,
    message: isConfigured
      ? 'NotchPay webhook is configured and ready'
      : 'NotchPay credentials are missing'
  });

});

// Notifications endpoint
app.get('/api/notifications', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const user = findUserByToken(token);

  if (!user) return res.status(401).json({ message: 'Invalid or missing token' });

  res.json({ notifications: user.notifications || [] });
});


// 🔵 BACKGROUND JOB 1: Withdrawal notifications (runs every minute)
setInterval(() => {
  const now = new Date();
  let changed = false;

  users.forEach(u => {
    if (u.withdrawalAvailableAt && !u.notifiedWithdrawal) {
      const when = new Date(u.withdrawalAvailableAt);

      if (when <= now) {
        u.notifications = u.notifications || [];

        const note = {
          id: crypto.randomBytes(8).toString('hex'),
          type: 'withdrawal_available',
          message: 'Your withdrawal is now available.',
          at: now.toISOString(),
        };

        u.notifications.push(note);
        u.notifiedWithdrawal = true;
        changed = true;

        console.log(`Notify user ${u.email}: withdrawal available`);
      }
    }
  });

  if (changed) saveUsers();

}, 60 * 1000); // ✅ CLOSED


// 🔵 BACKGROUND JOB 2: Daily referral earnings (runs every 24h)
setInterval(() => {
  const now = new Date();
  let changed = false;

  users.forEach(u => {
    const referralCount = u.referral_count || 0;

    if (referralCount > 0) {
      const tier = getCommissionTier(referralCount);

      const lastEarningsCredit = u.lastEarningsCredit
        ? new Date(u.lastEarningsCredit)
        : null;

      const daysPassed = lastEarningsCredit
        ? Math.floor((now - lastEarningsCredit) / (1000 * 60 * 60 * 24))
        : 1;

      if (daysPassed >= 1 && tier.daily > 0) {
        const earningsAmount = Math.floor(tier.daily * daysPassed);

        u.wallet_balance = (u.wallet_balance || 0) + earningsAmount;
        u.lastEarningsCredit = now.toISOString();

        u.transactions = u.transactions || [];
        u.transactions.push({
          id: crypto.randomBytes(8).toString('hex'),
          type: 'referral_daily_earnings',
          amount: earningsAmount,
          at: now.toISOString()
        });

        changed = true;

        console.log(
          `Credited ${earningsAmount} FCFA to ${u.email} (Tier: ${tier.commission})`
        );
      }
    }
  });

  if (changed) saveUsers();

}, 24 * 60 * 60 * 1000); // ✅ CLOSED



// 🔵 PRODUCTS (OUTSIDE of intervals — this was wrongly nested before)
const PRODUCTS = [
  { id: 1, name: '📱 Smartphone', price: 5000, minVip: null },
  { id: 2, name: '🎧 Headphones', price: 2000, minVip: null },
  { id: 3, name: '💻 Laptop', price: 25000, minVip: 'vip2' },
  { id: 4, name: '📷 Camera', price: 15000, minVip: 'vip2' },
  { id: 5, name: '⌚ Smartwatch', price: 8000, minVip: 'vip2' },
  { id: 6, name: '🎮 Gaming Console', price: 12000, minVip: 'vip3' },
  { id: 7, name: '📺 Smart TV', price: 35000, minVip: 'vip3' },
  { id: 8, name: '🎹 Digital Piano', price: 20000, minVip: 'vip3' },
  { id: 9, name: '🏎️ Premium Electronics', price: 45000, minVip: 'vip4' },
  { id: 10, name: '💎 Jewelry', price: 50000, minVip: 'vip4' },
  { id: 11, name: '✈️ Travel Vouchers', price: 30000, minVip: 'vip4' },
  { id: 12, name: '💍 Luxury Items', price: 100000, minVip: 'vip5' },
  { id: 13, name: '🛥️ Exclusive Access', price: 150000, minVip: 'vip5' },
  { id: 14, name: '🌍 Global Benefits', price: 200000, minVip: 'vip5' },
];

function vipLevel(planId) {
  if (!planId) return 0;
  const n = parseInt(String(planId).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function getVipBenefits(planId) {
  const level = vipLevel(planId);
  const benefits = {
    0: { purchaseDiscount: 0, sellBonus: 0 },
    1: { purchaseDiscount: 0.05, sellBonus: 0.02 },
    2: { purchaseDiscount: 0.10, sellBonus: 0.05 },
    3: { purchaseDiscount: 0.15, sellBonus: 0.08 },
    4: { purchaseDiscount: 0.20, sellBonus: 0.10 },
    5: { purchaseDiscount: 0.25, sellBonus: 0.15 }
  };
  return benefits[level] || benefits[0];
}

// endpoint for purchasing a product
app.post('/api/products/buy', async (req, res) => {
  console.log('Received product purchase request', req.body);
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const user = findUserByToken(token);
  if (!user) {
    console.log('product purchase denied, invalid token');
    return res.status(401).json({ message: 'Invalid or missing token' });
  }

  const { productId } = req.body;
  if (productId == null) {
    return res.status(400).json({ message: 'Missing productId' });
  }

  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return res.status(404).json({ message: 'Product not found' });

  // ensure user has required VIP level
  if (product.minVip && vipLevel(user.active_Plan) < vipLevel(product.minVip)) {
    return res.status(403).json({ message: `Requires ${product.minVip.toUpperCase()} membership` });
  }

  // enforce 13-day cooldown: if nextPurchaseWindowEnds exists and is in the future, block purchase
  if (user.nextPurchaseWindowEnds) {
    const nextWindow = new Date(user.nextPurchaseWindowEnds);
    const now = new Date();
    if (nextWindow > now) {
      const diff = nextWindow.getTime() - now.getTime();
      return res.status(429).json({ message: 'Next purchase window not yet open', retryAfterMs: diff, nextPurchaseWindowEnds: user.nextPurchaseWindowEnds });
    }
  }
  
  // Apply VIP purchase discount
  const vipBenefits = getVipBenefits(user.active_Plan);
  const discountAmount = Math.floor(product.price * vipBenefits.purchaseDiscount);
  const finalPrice = product.price - discountAmount;
  
  if (balance < finalPrice) {
    return res.status(400).json({ message: 'Insufficient balance' });
  }

  // deduct discounted price and update purchase timestamps
  user.walletBalance = balance - finalPrice;
  const now = new Date();
  user.lastProductPurchase = now.toISOString();
  user.nextPurchaseWindowEnds = new Date(now.getTime() + 13 * 24 * 60 * 60 * 1000).toISOString();

  // track owned products
  user.ownedProducts = user.ownedProducts || {};
  user.ownedProducts[productId] = (user.ownedProducts[productId] || 0) + 1;

  user.transactions = user.transactions || [];
  user.transactions.push({ id: crypto.randomBytes(8).toString('hex'), type: 'product_purchase', productId, amount: finalPrice, at: now.toISOString() });


  // Also update Supabase
  if (supabase) {
    supabase
      .from('users')
      .update({
        wallet_balance: user.walletBalance,
        last_product_purchase: user.lastProductPurchase,
        next_purchase_window_ends: user.nextPurchaseWindowEnds,
      })
      .eq('token', token)
      .then(({ error }) => {
        if (error) console.error('Error updating user in Supabase:', error);
      });
  }

  return res.json({ message: 'Product purchased successfully', walletBalance: user.walletBalance, lastProductPurchase: user.lastProductPurchase, nextPurchaseWindowEnds: user.nextPurchaseWindowEnds });
});

// endpoint for selling a product back to platform
app.post('/api/products/sell', async (req, res) => {
  console.log('Received product sell request', req.body);
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Invalid or missing token' });

  const { productId } = req.body;
  if (productId == null) return res.status(400).json({ message: 'Missing productId' });

  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return res.status(404).json({ message: 'Product not found' });

  user.ownedProducts = user.ownedProducts || {};
  const owned = user.ownedProducts[productId] || 0;
  if (owned <= 0) return res.status(400).json({ message: 'You do not own this product' });

  // compute sale amount (platform buys back at 80% of price + VIP sell bonus)
  const baseAmount = Math.floor(product.price * 0.8);
  const vipBenefits = getVipBenefits(user.active_Plan);
  const bonusAmount = Math.floor(baseAmount * vipBenefits.sellBonus);
  const saleAmount = baseAmount + bonusAmount;
  user.walletBalance = (user.walletBalance || 0) + saleAmount;
  user.ownedProducts[productId] = owned - 1;

  const now = new Date();
  user.transactions = user.transactions || [];
  user.transactions.push({ id: crypto.randomBytes(8).toString('hex'), type: 'product_sell', productId, amount: saleAmount, at: now.toISOString() });



  // Also update Supabase
  if (supabase) {
    supabase
      .from('users')
      .update({
        wallet_balance: user.walletBalance,
      })
      .eq('token', token)
      .then(({ error }) => {
        if (error) console.error('Error updating user in Supabase:', error);
      });
  }

  return res.json({ message: 'Product sold successfully', walletBalance: user.walletBalance, saleAmount, ownedLeft: user.ownedProducts[productId] });
});

// --- withdrawal endpoints ---

app.post('/api/users/request-withdrawal', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const user = findUserByToken(token);
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { amount, phoneNumber, paymentMethod } = req.body;
  
  if (!amount || !phoneNumber || !paymentMethod) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  // Check if user can withdraw (after 30 days)
  const withdrawalEligibleDate = user.withdrawalAvailableAt 
    ? new Date(user.withdrawalAvailableAt)
    : new Date(new Date(user.createdAt).getTime() + 30 * 24 * 60 * 60 * 1000);
  
  if (new Date() < withdrawalEligibleDate) {
    return res.status(403).json({ 
      message: 'You can only withdraw after 30 days',
      eligibleAt: withdrawalEligibleDate
    });
  }

  // Validate withdrawal amount
  if (amount <= 0 || amount > user.walletBalance) {
    return res.status(400).json({ message: 'Invalid withdrawal amount' });
  }

  // Create withdrawal request
  const withdrawalRequest = {
    id: `wr_${Date.now()}_${user.id}`,
    userId: user.id,
    username: user.username,
    email: user.email,
    amount: parseInt(amount),
    phoneNumber,
    paymentMethod,
    timestamp: new Date().toISOString(),
    status: 'pending'
  };

  pendingWithdrawals.push(withdrawalRequest);
  console.log(`Withdrawal request created: ${withdrawalRequest.id} for user ${user.email}`);

  return res.json({ 
    message: 'Withdrawal request submitted. Admin will review shortly.',
    requestId: withdrawalRequest.id
  });
});

// --- admin endpoints ---

app.get('/api/admin/users', async (req, res) => {

  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');

  if (token !== adminToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {

    let usersData = [];

    // Try Supabase first
    if (supabase) {

      const { data, error } = await supabase
        .from('users')
        .select('*');

      if (error) {
        console.warn('⚠️ Supabase error fetching users:', error.message);
      } else if (data) {

        console.log('✅ Users fetched from Supabase:', data.length);

        usersData = data.map(u => ({
          id: u.id,
          email: u.email,
          username: u.username,
          phoneNumber: u.phone_number,
          active_Plan: u.active_plan,
          nextPurchaseWindowEnds: u.next_purchase_window_ends,
          withdrawalAvailableAt: u.withdrawal_available_at,
          createdAt: u.created_at,
          walletBalance: u.wallet_balance,
          totalProfits: u.total_profits,
          totalDeposited: u.total_deposited,
          isActive: u.is_active
        }));

        return res.json(usersData);
      }

    }

    // fallback to file storage
    console.log('📁 Using file-based storage:', users.length);

    usersData = users.map(u => ({
      id: u.id,
      email: u.email,
      username: u.username,
      phoneNumber: u.phoneNumber,
      active_Plan: u.active_Plan,
      nextPurchaseWindowEnds: u.nextPurchaseWindowEnds,
      withdrawalAvailableAt: u.withdrawalAvailableAt,
      createdAt: u.createdAt,
      walletBalance: u.walletBalance || 0,
      totalProfits: u.totalProfits || 0,
      totalDeposited: u.totalDeposited || 0,
      isActive: u.isActive || true
    }));

    return res.json(usersData);

  } catch (err) {

    console.error('❌ Error fetching admin users:', err);

    res.status(500).json({
      message: 'Failed to fetch users',
      error: err.message
    });

  }

});

app.get('/api/admin/pending-withdrawals', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (token !== adminToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('status', 'pending');
      if (error) throw error;
      return res.json(data || []);
    } else {
      // Fallback to in-memory storage
      const pending = pendingWithdrawals.filter(w => w.status === 'pending');
      return res.json(pending);
    }
  } catch (err) {
    console.error('Error fetching pending withdrawals:', err);
    res.status(500).json({ message: 'Failed to fetch withdrawals' });
  }
});

app.post('/api/admin/approve-withdrawal', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');

  if (token !== adminToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { requestId } = req.body;

  try {
    if (supabase) {
      // Get withdrawal request
      const { data: withdrawal, error: wError } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('id', requestId)
        .single();

      if (wError || !withdrawal) {
        return res.status(404).json({ message: 'Withdrawal request not found' });
      }

      if (withdrawal.status !== 'pending') {
        return res.status(400).json({ message: 'Withdrawal already processed' });
      }

      // Deduct from user wallet
      const { data: user } = await supabase
        .from('users')
        .select('wallet_balance') // ✅ FIX column name
        .eq('id', withdrawal.userId)
        .single();

      if (user) {
        const newBalance = (user.wallet_balance || 0) - withdrawal.amount;

        await supabase
          .from('users')
          .update({ wallet_balance: newBalance }) // ✅ FIX column name
          .eq('id', withdrawal.userId);
      }

      // Update withdrawal status
      const { data: updated, error: uError } = await supabase
        .from('withdrawal_requests')
        .update({
          status: 'approved',
          approvedAt: new Date().toISOString()
        })
        .eq('id', requestId)
        .select()
        .single();

      if (uError) throw uError;

      console.log(`Withdrawal approved: ${requestId}`);

      return res.json({
        message: 'Withdrawal approved successfully',
        withdrawal: updated
      });

    } else {
      // Fallback to in-memory storage
      const withdrawal = pendingWithdrawals.find(w => w.id === requestId);

      if (!withdrawal) {
        return res.status(404).json({ message: 'Withdrawal request not found' });
      }

      if (withdrawal.status !== 'pending') {
        return res.status(400).json({ message: 'Withdrawal already processed' });
      }

      withdrawal.status = 'approved';
      withdrawal.approvedAt = new Date().toISOString();

      console.log(`Withdrawal approved: ${requestId}`);

      return res.json({
        message: 'Withdrawal approved successfully',
        withdrawal
      });
    }

  } catch (err) {
    console.error('❌ Error approving withdrawal:', err);
    return res.status(500).json({ message: 'Failed to approve withdrawal' });
  }
});

app.post('/api/admin/reject-withdrawal', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (token !== adminToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { requestId, reason } = req.body;
  
  try {
    if (supabase) {
      // Get withdrawal request
      const { data: withdrawal, error: wError } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('id', requestId)
        .single();
      
      if (wError || !withdrawal) {
        return res.status(404).json({ message: 'Withdrawal request not found' });
      }
      
      if (withdrawal.status !== 'pending') {
        return res.status(400).json({ message: 'Withdrawal already processed' });
      }
      
      // Update withdrawal status
      const { data: updated, error: uError } = await supabase
        .from('withdrawal_requests')
        .update({ 
          status: 'rejected', 
          rejectedAt: new Date().toISOString(),
          rejectionReason: reason || 'No reason provided'
        })
        .eq('id', requestId)
        .select()
        .single();
      
      if (uError) throw uError;
      
      console.log(`Withdrawal rejected: ${requestId}`);
      return res.json({ 
        message: 'Withdrawal rejected',
        withdrawal: updated
      });
    } else {
      // Fallback to in-memory storage
      const withdrawal = pendingWithdrawals.find(w => w.id === requestId);
      if (!withdrawal) return res.status(404).json({ message: 'Withdrawal request not found' });
      if (withdrawal.status !== 'pending') return res.status(400).json({ message: 'Withdrawal already processed' });
      
      withdrawal.status = 'rejected';
      withdrawal.rejectedAt = new Date().toISOString();
      withdrawal.rejectionReason = reason || 'No reason provided';
      console.log(`Withdrawal rejected: ${requestId}`);
      return res.json({ message: 'Withdrawal rejected', withdrawal });
    }
  } catch (err) {
    console.error('Error rejecting withdrawal:', err);
    res.status(500).json({ message: 'Failed to reject withdrawal' });
  }
});

/* ===============================
   HEALTH CHECK
================================ */

app.get("/", (req, res) => {
  res.json({
    status: "DPAY backend running",
    time: new Date().toISOString()
  });
});

/* ===============================
   AUTH LOGIN
================================ */
app.post('/api/auth/login', async (req, res) => {

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      message: "Missing credentials"
    });
  }

  try {

    // find user in database
    const user = await getUserByEmail(email);

    if (!user) {
      return res.status(401).json({
        message: "Invalid email or password"
      });
    }

    // verify password
    if (user.password !== password) {
      return res.status(401).json({
        message: "Invalid email or password"
      });
    }

    // generate new token
    const newToken = makeToken();

    // update token in Supabase
    const { data, error } = await supabase
      .from("users")
      .update({ token: newToken })
      .eq("id", user.id)
      .select()
      .maybeSingle();

    if (error) {
      console.error("Supabase update error:", error);
      return res.status(500).json({
        message: "Failed to update session token"
      });
    }

    console.log("TOKEN SAVED:", newToken);

    return res.json({
      message: "Login successful",
      token: newToken,
      userId: user.id
    });

  } catch (err) {

    console.error("Login error:", err);

    return res.status(500).json({
      message: "Login failed"
    });

  }

});

/* ===============================
   GLOBAL ERROR HANDLER
================================ */
app.use((err, req, res, next) => {
  console.error("🔥 Server error:", err);
  res.status(500).json({ message: "Internal server error" });
});

/* ===============================
   START SERVER
================================ */
app.listen(PORT, () => {
  console.log("====================================");
  console.log(`🚀 DPAY backend running on port ${PORT}`);
  console.log("====================================");
});
