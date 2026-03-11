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
const notchpaySecretKey = fs
  .readFileSync("/etc/secrets/NOTCHPAY_PRIVATE_KEY")
  .toString()
  .trim();
const notchpayHashKey = process.env.NOTCHPAY_HASH_KEY;

if (!notchpaySecretKey) {
  console.error("❌ NOTCHPAY_PRIVATE_KEY missing");
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
    if (!error) {
      // Also add to in-memory array for immediate lookups
      users.push(data);
      saveUsers();
      return data;
    }
    console.error('Supabase insert error:', error);
  }
  users.push(userData);
  saveUsers();
  return userData;
}

// Update user in Supabase or file fallback
async function updateUser(userId, updates) {
  if (supabase) {
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();
    if (!error) return data;
    console.error('Supabase update error:', error);
  }
  const user = users.find(u => u.id === userId);
  if (user) {
    Object.assign(user, updates);
    saveUsers();
  }
  return user;
}

// Log transaction in Supabase or file fallback
async function logTransaction(userId, type, amount, description = '') {
  if (supabase) {
    const { error } = await supabase
      .from('transactions')
      .insert([{
        user_id: userId,
        type,
        amount,
        description,
        status: 'completed'
      }]);
    if (error) console.error('Transaction log error:', error);
  }
}

 // ✅ REGISTER ROUTE ENDS HERE

/* LOGIN ROUTE STARTS HERE */

app.post('/api/auth/register', async (req, res) => {

  const { email, password, username, referralCode } = req.body;

  if (!email || !password || !username) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {

    const existingUser = await getUserByEmail(email);

    if (existingUser) {
      return res.status(409).json({ message: "User already exists" });
    }

    let referrerId = null;

    if (referralCode) {
      const referrer = findUserByReferralCode(referralCode);

      if (!referrer) {
        return res.status(400).json({ message: "Invalid referral code" });
      }

      referrerId = referrer.id;
    }

    const newUser = {
      id: makeUUID(),
      email,
      password,
      username,
      token: makeToken(),
      created_at: new Date().toISOString(),
      referral_code: makeReferralCode(),
      referrer_id: referrerId,
      referral_count: 0,
      wallet_balance: 0
    };

    const createdUser = await createUser(newUser);

    if (referrerId) {
      const referrer = users.find(u => u.id === referrerId);

      if (referrer) {
        referrer.referral_count = (referrer.referral_count || 0) + 1;
        saveUsers();
      }
    }

    return res.status(201).json({
      message: "User created",
      token: createdUser.token,
      userId: createdUser.id
    });

  } catch (err) {

    console.error("Registration error:", err);
    return res.status(500).json({ message: "Registration failed" });

  }

});
  // Check if user already exists
app.post('/api/auth/register', async (req, res) => {
  const { email, password, username } = req.body;
  const existingUser = await getUserByEmail(email);
  if (existingUser) {
    return res.status(409).json({ message: 'User already exists' });
  } 
  
  // Check if referral code is valid
  let referrerId = null;
  if (referralCode) {
    const referrer = findUserByReferralCode(referralCode);
    if (!referrer) {
      return res.status(400).json({ message: 'Invalid referral code' });
    }
    referrerId = referrer.id;
  }

  const newUser = {
    id: makeUUID(),  // Generate UUID for new user
    email,
    password,
    username,
    first_name: firstName || '',
    last_name: lastName || '',
    phone_number: phoneNumber || '',
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
    referral_count: 0,
  };
  
  try {
    const createdUser = await createUser(newUser);

    // If user was referred, increment referrer's referral count and check for tier bonuses
    if (referrerId) {
      const referrer = users.find(u => u.id === referrerId);
      if (referrer) {
        const previousCount = referrer.referral_count || 0;
        referrer.referral_count = previousCount + 1;
        // Check if referrer reached a new tier and credit bonus
        const tierBonus = checkTierUpgrade(previousCount, referrer.referral_count);
        if (tierBonus > 0) {
          referrer.wallet_balance = (referrer.wallet_balance || 0) + tierBonus;
          const tier = getCommissionTier(referrer.referral_count);
          await logTransaction(referrerId, 'referral_tier_bonus', tierBonus, `Tier upgrade bonus - reached ${tier.commission} commission tier`);
        }
        saveUsers();
      }
    }

    return res.status(201).json({ 
      message: 'User created', 
      token: createdUser.token,
      userId: createdUser.id 
    });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ message: 'Registration failed' });
  }
});

app.post('/api/auth/admin-login', (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    if (
 email === process.env.ADMIN_EMAIL &&
 password === process.env.ADMIN_PASSWORD
) {
      adminToken = makeToken();
      saveAdminToken();
      return res.json({ token: adminToken });
    }

    return res.status(401).json({ message: "Invalid admin credentials" });

  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ message: "Server error during admin login" });
  }
});
// --- user/profile and transactions ---

app.get('/api/users/profile', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');

  console.log("TOKEN RECEIVED:", token);

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
    
    // Omit sensitive data
    const { password, ...publicData } = user;
    res.json(publicData);
  } catch (err) {
    console.error('Error fetching profile:', err);
    res.status(500).json({ message: 'Error fetching profile' });
  }
});

app.get('/api/transactions', async (req, res) => {
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
    res.json(user.transactions || []);
  } catch (err) {
    console.error('Error fetching transactions:', err);
    res.status(500).json({ message: 'Error fetching transactions' });
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

app.get('/api/referral/code', async (req, res) => {
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

    const referralCode = user.referral_code || user.referralCode;
   const referralLink = `${process.env.FRONTEND_URL || 'https://computerarchi.com/Dpay'}/#/register?ref=${referralCode}`;
    res.json({
      referralCode: referralCode,
      referralLink: referralLink,
    });
  } catch (err) {
    console.error('Error fetching referral code:', err);
    res.status(500).json({ message: 'Error fetching referral code' });
  }
});

// --- plan purchase endpoints ---
app.post('/api/plans/purchase', async (req, res) => {
  try {

    console.log('Received plan purchase request:', req.body);

    // Get authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Invalid or missing token' });
    }

    const token = authHeader.split(' ')[1];

    // Find user
    const user = findUserByToken(token);

    if (!user) {
      return res.status(401).json({ message: 'Invalid or missing token' });
    }

    const { planId, amount, paymentMethod } = req.body;

    if (!planId || !amount) {
      return res.status(400).json({ message: 'Missing plan details' });
    }

    const numericAmount = Number(amount);

    if (isNaN(numericAmount)) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    const now = new Date();

    // Ensure plans array exists
    if (!user.plans) {
      user.plans = [];
    }

    const newPlan = {
      planId,
      amount: numericAmount,
      paymentMethod: paymentMethod || "unknown",
      startDate: now,
      status: "active"
    };

    user.plans.push(newPlan);

    // Ensure notifications array exists
    if (!user.notifications) {
      user.notifications = [];
    }

    user.notifications.push({
      message: `Plan ${planId} activated successfully`,
      date: now
    });

    console.log(`Plan ${planId} activated for user:`, user.email);

    return res.json({
      success: true,
      message: "Plan activated successfully",
      plan: newPlan
    });

  } catch (error) {

    console.error("PURCHASE ERROR:", error);

    return res.status(500).json({
      message: "Server error while activating plan"
    });
  }
});

  try {

  user.pendingPurchase = {
    planId,
    amount,
    paymentMethod: 'Debit Card',
    createdAt: now.toISOString(),
    verified: false
  };

  saveUsers();

  const paymentRef = `PLAN_${user.id}_${Date.now()}`;

  const rawPhone = user.phone_number || user.phoneNumber || "";

  const phoneFormatted = rawPhone.startsWith("+237")
    ? rawPhone
    : `+237${rawPhone.replace(/^0/, "")}`;

  const notchpayPayload = {
    amount: Number(amount),
    currency: "XAF",
    reference: paymentRef,
    customer: {
      name:
        (user.first_name || user.firstName || "") +
        " " +
        (user.last_name || user.lastName || ""),
      email: user.email,
      phone: phoneFormatted
    },
    description: `Plan Purchase - ${planId}`,
    metadata: {
      userId: user.id,
      planId,
      originalAmount: amount
    }
  };

} catch (error) {

  console.error("Payment initialization error:", error);

  return res.status(500).json({
    message: "Failed to initialize payment"
  });

}
app.post('/api/payments/initialize', async (req, res) => {
try {
    const notchpayResponse = await axios.post(
      "https://api.notchpay.co/payments/initialize",
      notchpayPayload,
      {
        headers: {
          Authorization: `Bearer ${notchpaySecretKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json(notchpayResponse.data);

  } catch (error) {

    console.error("NOTCHPAY ERROR:", error.response?.data || error.message);

    return res.status(500).json({
      message: "Failed to initialize payment"
    });

  }
});
  /* =========================
     MOBILE MONEY / DIRECT
  ========================= */

  user.walletBalance = (user.walletBalance || 0) + amount;
  user.activePlan = planId;
  user.totalDeposited = (user.totalDeposited || 0) + amount;

  const withdrawalDate = new Date(
    now.getTime() + 30 * 24 * 60 * 60 * 1000
  );

  user.withdrawalAvailableAt = withdrawalDate.toISOString();
  user.lastTransactionDate = now.toISOString();

  user.transactions = user.transactions || [];

  user.transactions.push({
    id: crypto.randomBytes(8).toString('hex'),
    type: 'plan_purchase',
    planId,
    amount,
    paymentMethod,
    at: now.toISOString()
  });

  saveUsers();

  return res.json({
    message: 'Plan purchased successfully',
    withdrawalAvailableAt: user.withdrawalAvailableAt,
    activePlan: user.activePlan,
    walletBalance: user.walletBalance
  });

});

// Payment verification stub - in real app this would be called by payment gateway webhook

app.post('/api/payments/verify', async (req, res) => {
  const { userId, paymentId } = req.body;
  if (!userId || !paymentId) return res.status(400).json({ message: 'Missing parameters' });
  const user = users.find(u => u.id === userId);
  if (!user || !user.pendingPurchase) return res.status(404).json({ message: 'Pending purchase not found' });

  // mark as verified and activate plan
  user.pendingPurchase.verified = true;
  const now = new Date();
  user.activePlan = user.pendingPurchase.planId;
  user.walletBalance = (user.walletBalance || 0) + user.pendingPurchase.amount;
  user.totalDeposited = (user.totalDeposited || 0) + user.pendingPurchase.amount;
  user.lastTransactionDate = now.toISOString();
  user.withdrawalAvailableAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  // Record transaction
  user.transactions = user.transactions || [];
  user.transactions.push({ id: crypto.randomBytes(8).toString('hex'), type: 'plan_purchase', planId: user.pendingPurchase.planId, amount: user.pendingPurchase.amount, paymentMethod: user.pendingPurchase.paymentMethod, at: now.toISOString() });
  
  // Apply referral commission if user has a referrer
  if (user.referrer_id) {
    const referrer = users.find(u => u.id === user.referrer_id);
    if (referrer) {
      const tier = getCommissionTier(referrer.referral_count || 0);
      const commissionAmount = Math.floor(user.pendingPurchase.amount * tier.commissionPercent);
      if (commissionAmount > 0) {
        referrer.wallet_balance = (referrer.wallet_balance || 0) + commissionAmount;
        logTransaction(referrer.id, 'referral_commission', commissionAmount, `Commission on plan purchase by ${user.username || 'user'} (${tier.commission})`);
      }
    }
  }
  
  delete user.pendingPurchase;
  saveUsers();

  // Also update Supabase
  if (supabase) {
    supabase
      .from('users')
      .update({
        active_plan: user.activePlan,
        wallet_balance: user.walletBalance,
        total_deposited: user.totalDeposited,
        withdrawal_available_at: user.withdrawalAvailableAt,
        last_transaction_date: user.lastTransactionDate,
      })
      .eq('id', userId)
      .then(({ error }) => {
        if (error) console.error('Error updating user in Supabase:', error);
      });
  }

  return res.json({ message: 'Payment verified and plan activated', withdrawalAvailableAt: user.withdrawalAvailableAt, walletBalance: user.walletBalance });
});

// NotchPay Webhook - Handle payment success/failure events
app.post('/api/webhooks/notchpay', async (req, res) => {
  console.log('🔔 NotchPay webhook received');
  console.log('   Event:', req.body.event);
  console.log('   Reference:', req.body.data?.reference);
  
  try {
    const { event, data } = req.body;
    
    if (!event || !data) {
      console.warn('⚠️ Invalid webhook payload - missing event or data');
      return res.status(400).json({ message: 'Invalid webhook payload' });
    }
    
    // Verify webhook signature using hash key
    if (notchpayHashKey) {
      const webhookHash = req.headers['x-notchpay-signature'] || req.headers['x-webhook-signature'];
      
      if (!webhookHash) {
        console.warn('⚠️ Missing webhook signature header');
        // Continue anyway for testing, but log warning
      } else {
        const calculatedHash = crypto
          .createHmac('sha256', notchpayHashKey)
          .update(JSON.stringify(data))
          .digest('hex');
        
        if (webhookHash !== calculatedHash) {
          console.warn('❌ Invalid webhook signature:', webhookHash, 'vs', calculatedHash);
          return res.status(403).json({ message: 'Invalid signature' });
        }
        console.log('✅ Webhook signature verified');
      }
    }

    // Handle payment success events
    if (event === 'payment.success' || event === 'charge.success') {
      console.log('💰 Processing payment success event');
      
      const { reference, status, metadata } = data;
      
      // Validate payment status
      if (!status || (status !== 'successful' && status !== 'completed' && status !== 'success')) {
        console.warn(`⚠️ Payment status is not successful: ${status}`);
        return res.status(400).json({ message: `Payment status: ${status}` });
      }

      const { userId, planId, originalAmount } = metadata || {};
      
      if (!userId || !planId) {
        console.error('❌ Missing required metadata - userId:', userId, 'planId:', planId);
        return res.status(400).json({ message: 'Invalid metadata' });
      }

      const user = users.find(u => u.id === userId);
      if (!user) {
        console.error('❌ User not found:', userId);
        return res.status(404).json({ message: 'User not found' });
      }

      console.log(`👤 Found user: ${user.email}`);

      if (!user.pendingPurchase) {
        console.warn(`⚠️ No pending purchase for user ${userId}. Creating new plan activation.`);
        // Create pending purchase if it doesn't exist (fallback for webhook arriving before frontend request)
        user.pendingPurchase = {
          planId,
          amount: originalAmount,
          paymentMethod: 'Debit Card (NotchPay)',
          createdAt: new Date().toISOString(),
          verified: false,
        };
      }

      // Activate the pending purchase
      const now = new Date();
      const amount = user.pendingPurchase.amount || originalAmount;
      
      console.log(`📦 Activating ${planId} plan for ${amount} FCFA`);
      
      user.wallet_balance = (user.wallet_balance || 0) + amount;
      user.active_plan = planId;
      user.total_deposited = (user.total_deposited || 0) + amount;
      user.last_transaction_date = now.toISOString();
      user.withdrawal_available_at = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      
      // Record transaction
      user.transactions = user.transactions || [];
      user.transactions.push({ 
        id: crypto.randomBytes(8).toString('hex'), 
        type: 'plan_purchase', 
        planId, 
        amount,
        paymentMethod: 'Debit Card (NotchPay)',
        at: now.toISOString(),
        notchpayRef: reference,
        status: 'verified'
      });

      // Apply referral commission if user has a referrer
      if (user.referrer_id) {
        const referrer = users.find(u => u.id === user.referrer_id);
        if (referrer) {
          const tier = getCommissionTier(referrer.referral_count || 0);
          const commissionAmount = Math.floor(amount * tier.commissionPercent);
          if (commissionAmount > 0) {
            referrer.wallet_balance = (referrer.wallet_balance || 0) + commissionAmount;
            console.log(`💵 Referral commission: ${commissionAmount} FCFA (${tier.commission}) to referrer ${referrer.email}`);
            logTransaction(referrer.id, 'referral_commission', commissionAmount, `Commission on ${planId} purchase by ${user.username || user.email} (${tier.commission})`);
          }
        }
      }

      delete user.pendingPurchase;
      saveUsers();

      // Update Supabase asynchronously
      if (supabase) {
        supabase
          .from('users')
          .update({
            active_plan: user.active_plan,
            wallet_balance: user.wallet_balance,
            total_deposited: user.total_deposited,
            withdrawal_available_at: user.withdrawal_available_at,
            last_transaction_date: user.last_transaction_date,
          })
          .eq('id', userId)
          .then(({ error }) => {
            if (error) {
              console.warn('⚠️ Error updating Supabase:', error.message);
            } else {
              console.log('✅ Supabase updated for user:', userId);
            }
          });
      }

      console.log(`✅ PAYMENT VERIFIED AND PLAN ACTIVATED`);
      console.log(`   User: ${user.email}`);
      console.log(`   Plan: ${planId}`);
      console.log(`   Amount: ${amount} FCFA`);
      console.log(`   Reference: ${reference}`);
      console.log(`   Withdrawal available: ${user.withdrawal_available_at}`);
      
      return res.json({ 
        message: 'Payment verified successfully', 
        userId, 
        planId,
        amount,
        confirmed: true
      });
    }

    // Handle payment failure events
    if (event === 'payment.failed' || event === 'charge.failed') {
      console.log('❌ Payment failed event received');
      
      const { reference, status, metadata } = data;
      const { userId } = metadata || {};
      
      console.log(`   Reference: ${reference}`);
      console.log(`   Status: ${status}`);
      console.log(`   User: ${userId}`);
      
      const user = users.find(u => u.id === userId);
      if (user && user.pendingPurchase) {
        console.log(`   Cleaning up pending purchase for user: ${user.email}`);
        delete user.pendingPurchase;
        saveUsers();
      }

      return res.json({ 
        message: 'Payment failed notification received',
        reference,
        status: 'failed'
      });
    }

    // Log unhandled events for debugging
    console.log(`⚠️ Unhandled webhook event type: ${event}`);
    res.json({ message: 'Webhook processed', event });
    
  } catch (error) {
    console.error('❌ NotchPay webhook error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Health check endpoint for NotchPay webhook configuration
app.get('/api/webhooks/notchpay/health', (req, res) => {
  const isConfigured = !!(notchpayHashKey && notchpaySecretKey);
  res.json({
    status: isConfigured ? 'ready' : 'not-configured',
    hasHashKey: !!notchpayHashKey,
    hasSecretKey: !!notchpaySecretKey,
    message: isConfigured ? 'NotchPay webhook is configured and ready' : 'NotchPay credentials are missing'
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

// Background job to notify users when withdrawal becomes available
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
        // placeholder for real email sending
        console.log(`Notify user ${u.email}: withdrawal available`);
      }
    }
  });
  if (changed) saveUsers();
}, 60 * 1000);

// Background job for daily referral earnings - runs every 24 hours
setInterval(() => {
  const now = new Date();
  let changed = false;
  
  users.forEach(u => {
    const referralCount = u.referral_count || 0;
    if (referralCount > 0) {
      const tier = getCommissionTier(referralCount);
      const lastEarningsCredit = u.lastEarningsCredit ? new Date(u.lastEarningsCredit) : null;
      const daysPassed = lastEarningsCredit ? Math.floor((now - lastEarningsCredit) / (1000 * 60 * 60 * 24)) : 1;
      
      // Credit daily earnings if at least 1 day has passed
      if (daysPassed >= 1 && tier.daily > 0) {
        const earningsAmount = Math.floor(tier.daily * daysPassed); // Allow multiple days of earnings if interval was missed
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
        console.log(`Credited ${earningsAmount} FCFA daily earnings to user ${u.email} (Tier: ${tier.commission}, Referrals: ${referralCount})`);
      }
    }
  });
  
  if (changed) saveUsers();
}, 24 * 60 * 60 * 1000);  // Run once per day

// --- products list (server-side) ---
// replicate frontend PRODUCTS for server-side validation
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

// Get VIP benefits (purchase discount and sell bonus) based on active plan
function getVipBenefits(planId) {
  const level = vipLevel(planId);
  const benefits = {
    0: { purchaseDiscount: 0, sellBonus: 0 },      // No plan
    1: { purchaseDiscount: 0.05, sellBonus: 0.02 }, // VIP1: 5% discount, 2% bonus
    2: { purchaseDiscount: 0.10, sellBonus: 0.05 }, // VIP2: 10% discount, 5% bonus
    3: { purchaseDiscount: 0.15, sellBonus: 0.08 }, // VIP3: 15% discount, 8% bonus
    4: { purchaseDiscount: 0.20, sellBonus: 0.10 }, // VIP4: 20% discount, 10% bonus
    5: { purchaseDiscount: 0.25, sellBonus: 0.15 }  // VIP5: 25% discount, 15% bonus
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
  if (product.minVip && vipLevel(user.activePlan) < vipLevel(product.minVip)) {
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

  const balance = user.walletBalance || 0;
  
  // Apply VIP purchase discount
  const vipBenefits = getVipBenefits(user.activePlan);
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

  saveUsers();

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
  const vipBenefits = getVipBenefits(user.activePlan);
  const bonusAmount = Math.floor(baseAmount * vipBenefits.sellBonus);
  const saleAmount = baseAmount + bonusAmount;
  user.walletBalance = (user.walletBalance || 0) + saleAmount;
  user.ownedProducts[productId] = owned - 1;

  const now = new Date();
  user.transactions = user.transactions || [];
  user.transactions.push({ id: crypto.randomBytes(8).toString('hex'), type: 'product_sell', productId, amount: saleAmount, at: now.toISOString() });

  saveUsers();

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

app.post('/api/users/request-withdrawal', (req, res) => {
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
    
    // Try to fetch from Supabase first
    if (supabase) {
      const { data, error } = await supabase
        .from('users')
        .select('id, email, username, phone_number, active_plan, next_purchase_window_ends, withdrawal_available_at, created_at, wallet_balance, total_profits, total_deposited, is_active');
      
      if (error) {
        console.warn('⚠️ Supabase error fetching users, falling back to file storage:', error.message);
      } else if (data && data.length > 0) {
        console.log('✅ Successfully fetched', data.length, 'users from Supabase');
        // Map Supabase data to expected frontend format
        usersData = data.map(u => ({
          id: u.id,
          email: u.email,
          username: u.username,
          phoneNumber: u.phone_number,
          activePlan: u.active_plan,
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
    
    // Fallback to file-based storage if Supabase is not available or empty
    console.log('📁 Using file-based storage, found', users.length, 'users');
    usersData = users.map(u => ({
      id: u.id,
      email: u.email,
      username: u.username,
      phoneNumber: u.phoneNumber,
      activePlan: u.activePlan,
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
    // Even if there's an error, try to return file-based data as last resort
    try {
      const fallbackUsers = users.map(u => ({
        id: u.id,
        email: u.email,
        username: u.username,
        phoneNumber: u.phoneNumber,
        activePlan: u.activePlan,
        walletBalance: u.walletBalance || 0
      }));
      return res.json(fallbackUsers);
    } catch (fallbackErr) {
      console.error('❌ Fallback failed:', fallbackErr);
      res.status(500).json({ message: 'Failed to fetch users', error: err.message });
    }
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
        .select('walletBalance')
        .eq('id', withdrawal.userId)
        .single();
      
      if (user) {
        const newBalance = (user.walletBalance || 0) - withdrawal.amount;
        await supabase
          .from('users')
          .update({ walletBalance: newBalance })
          .eq('id', withdrawal.userId);
      }
      
      // Update withdrawal status
      const { data: updated, error: uError } = await supabase
        .from('withdrawal_requests')
        .update({ status: 'approved', approvedAt: new Date().toISOString() })
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
      if (!withdrawal) return res.status(404).json({ message: 'Withdrawal request not found' });
      if (withdrawal.status !== 'pending') return res.status(400).json({ message: 'Withdrawal already processed' });
      
      const user = users.find(u => u.id === withdrawal.userId);
      if (user) {
        user.walletBalance -= withdrawal.amount;
        saveUsers();
      }
      
      withdrawal.status = 'approved';
      withdrawal.approvedAt = new Date().toISOString();
      console.log(`Withdrawal approved: ${requestId}`);
      return res.json({ message: 'Withdrawal approved successfully', withdrawal });
    }
  } catch (err) {
    console.error('Error approving withdrawal:', err);
    res.status(500).json({ message: 'Failed to approve withdrawal' });
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
    return res.status(400).json({ message: "Missing credentials" });
  }

  try {

    let user = await getUserByEmail(email);

    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (user.password !== password) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // generate new session token
    const newToken = makeToken();
    user.token = newToken;

    await updateUser(user.id, { token: newToken });

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





















































