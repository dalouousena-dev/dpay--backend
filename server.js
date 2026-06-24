const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

/* ===== IMPORTANT FOR RENDER ===== */
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

/* ===== MIDDLEWARE ===== */
const allowedOrigins = [
  'https://computerarchi.com',
  'http://localhost:3000',
  'http://localhost:5173',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json());

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

/* ===== ASHTECHPAY INITIALIZATION ===== */
const ashtechPublicKey = process.env.ASHTECHPAY_PUBLIC_KEY;
const ashtechSecretKey = process.env.ASHTECHPAY_SECRET_KEY;
const ashtechHpKey     = process.env.ASHTECHPAY_HP_KEY;

if (ashtechHpKey) {
  console.log('✅ AshtechPay initialized');
} else {
  console.warn('⚠️ AshtechPay credentials not found. Online payments will be disabled.');
}

// Map from AshtechPay payment_id → { userId, planId, amount, isUpgrade, previousPlan }
const pendingPaymentMap = {};

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

// Load all users from Supabase into memory so background jobs can process them
async function syncUsersFromSupabase() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('users').select('*');
    if (error || !data) return;
    data.forEach(dbUser => {
      const existing = users.find(u => u.id === dbUser.id);
      if (!existing) users.push(dbUser);
    });
    saveUsers();
    console.log(`✅ Synced ${data.length} users from Supabase into memory`);
  } catch (err) {
    console.error('Failed to sync users from Supabase:', err.message);
  }
}
// Run once at startup, then every 10 minutes to stay in sync
syncUsersFromSupabase();
setInterval(syncUsersFromSupabase, 10 * 60 * 1000);

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
  return users.find(u => (u.referralCode || u.referral_code) === code);
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

// Apply referral commission to referrer — call after any plan purchase
function applyReferralCommission(purchaserUser, planAmount) {
  const referrerId = purchaserUser.referrer_id || purchaserUser.referrerId;
  if (!referrerId) return;
  const referrer = users.find(u => u.id === referrerId);
  if (!referrer) return;
  const count = referrer.referral_count || 0;
  const tier = getCommissionTier(count);
  const commissionAmount = Math.floor(planAmount * tier.commissionPercent);
  if (commissionAmount <= 0) return;
  const currentBal = referrer.walletBalance !== undefined ? referrer.walletBalance : (referrer.wallet_balance || 0);
  referrer.walletBalance = currentBal + commissionAmount;
  referrer.wallet_balance = referrer.walletBalance;
  referrer.total_profits = (referrer.total_profits || 0) + commissionAmount;
  logTransaction(referrer.id, 'referral_commission', commissionAmount,
    `Commission on plan purchase by ${purchaserUser.username || purchaserUser.email} (${tier.commission})`);
  if (supabase) {
    supabase.from('users').update({ wallet_balance: referrer.walletBalance, total_profits: referrer.total_profits }).eq('id', referrer.id)
      .then(({ error }) => { if (error) console.error('Error updating referrer wallet in Supabase:', error); });
  }
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

// --- auth endpoints ---

app.post('/api/auth/register', async (req, res) => {
  const { email, password, username, firstName, lastName, phoneNumber, referralCode } = req.body;
  if (!email || !password || !username) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  
  // Check if user already exists
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

  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = {
    id: makeUUID(),  // Generate UUID for new user
    email,
    password: hashedPassword,
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
        const currentBalance = referrer.walletBalance !== undefined ? referrer.walletBalance : (referrer.wallet_balance || 0);
        if (tierBonus > 0) {
          referrer.walletBalance = currentBalance + tierBonus;
          referrer.wallet_balance = referrer.walletBalance;
          referrer.total_profits = (referrer.total_profits || 0) + tierBonus;
          const tier = getCommissionTier(referrer.referral_count);
          await logTransaction(referrerId, 'referral_tier_bonus', tierBonus, `Tier upgrade bonus - reached ${tier.commission} commission tier`);
        }
        saveUsers();
        // Sync referral_count and balance to Supabase
        if (supabase) {
          supabase.from('users').update({
            referral_count: referrer.referral_count,
            wallet_balance: referrer.walletBalance !== undefined ? referrer.walletBalance : referrer.wallet_balance,
            total_profits: referrer.total_profits || 0,
          }).eq('id', referrerId).then(({ error }) => {
            if (error) console.error('Error updating referrer in Supabase:', error);
          });
        }
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

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await getUserByEmail(email);

  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const passwordMatch = user.password.startsWith('$2')
    ? await bcrypt.compare(password, user.password)
    : user.password === password; // legacy plain-text fallback for existing accounts

  if (!passwordMatch) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  
  // Ensure user has a token
  let token = user.token;
  if (!token) {
    token = makeToken();
  }
  await updateUser(user.id, { token, last_login: new Date().toISOString() });

  return res.json({ token });
});

app.post('/api/auth/admin-login', (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (email === adminEmail && password === adminPassword) {
    adminToken = makeToken();
    saveAdminToken();
    return res.json({ token: adminToken });
  }
  return res.status(401).json({ message: 'Invalid admin credentials' });
});

// --- user/profile and transactions ---

app.get('/api/users/profile', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  
  try {
    let user;
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
    if (!user) {
      user = findUserByToken(token);
    }
    if (!user) {
      return res.status(401).json({ message: 'Invalid or missing token' });
    }

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
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ message: 'Invalid or missing token' });

    // Query Supabase transactions table first
    if (supabase) {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (!error && data && data.length > 0) return res.json(data);
    }

    // Fallback: in-memory transaction array on the user object
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
    const referralLink = `${process.env.FRONTEND_URL || 'https://computerarchi.com/Dpay'}/register?ref=${referralCode}`;
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
  console.log('Received plan purchase request', req.body);
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  
  let user = findUserByToken(token);
  
  // Fallback: try Supabase if user not found in memory
  if (!user && supabase) {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('token', token)
        .single();
      if (!error && data) {
        user = data;
        // Normalize Supabase field names to camelCase for consistency
        if (user.wallet_balance !== undefined) user.walletBalance = user.wallet_balance;
        if (user.active_plan !== undefined) user.activePlan = user.active_plan;
        if (user.total_deposited !== undefined) user.totalDeposited = user.total_deposited;
        if (user.withdrawal_available_at !== undefined) user.withdrawalAvailableAt = user.withdrawal_available_at;
        if (user.last_transaction_date !== undefined) user.lastTransactionDate = user.last_transaction_date;
        if (user.first_name !== undefined) user.firstName = user.first_name;
        if (user.last_name !== undefined) user.lastName = user.last_name;
        if (user.phone_number !== undefined) user.phoneNumber = user.phone_number;
        if (user.referral_code !== undefined) user.referralCode = user.referral_code;
        if (user.referrer_id !== undefined) user.referrerId = user.referrer_id;
        if (user.referral_count !== undefined) user.referralCount = user.referral_count;
        // Also add to in-memory array for faster lookups
        users.push(user);
        saveUsers();
      }
    } catch (err) {
      console.warn('Supabase token lookup failed:', err.message);
    }
  }
  
  if (!user) {
    console.log('purchase denied, invalid token');
    return res.status(401).json({ message: 'Invalid or missing token' });
  }

  const { planId, amount, paymentMethod, isUpgrade, currentPlan: clientCurrentPlan } = req.body;
  if (!planId || !amount) {
    return res.status(400).json({ message: 'Missing plan details' });
  }

  // ── Upgrade validation ──
  const PLAN_ORDER_V = ['vip1', 'vip2', 'vip3', 'vip4', 'vip5', 'vip6', 'vip7'];
  const PLAN_PRICES_V = { vip1: 10000, vip2: 25000, vip3: 50000, vip4: 100000, vip5: 200000, vip6: 400000, vip7: 800000 };
  const currentPlan = user.activePlan || user.active_plan;
  const currentPlanIdx = currentPlan ? PLAN_ORDER_V.indexOf(currentPlan) : -1;
  const newPlanIdx = PLAN_ORDER_V.indexOf(planId);

  if (newPlanIdx === -1) {
    return res.status(400).json({ message: 'Invalid plan ID.' });
  }
  if (currentPlan && newPlanIdx <= currentPlanIdx) {
    return res.status(400).json({ message: 'You cannot downgrade. Please choose a higher VIP level to upgrade.' });
  }
  const upgrading = currentPlanIdx >= 0 && newPlanIdx > currentPlanIdx;
  const currentPlanPrice = upgrading ? (PLAN_PRICES_V[currentPlan] || 0) : 0;
  const expectedAmount = upgrading ? (PLAN_PRICES_V[planId] - currentPlanPrice) : PLAN_PRICES_V[planId];

  const now = new Date();

  // Redirect to AshtechPay hosted page
  if (!ashtechHpKey) {
    return res.status(500).json({ message: 'AshtechPay is not configured. Please contact support.' });
  }

  try {
    const ashtechPayload = {
      currency: 'XAF',
      amount: amount,
      description: upgrading
        ? `VIP Upgrade: ${currentPlan.toUpperCase()} → ${planId.toUpperCase()} (+${amount.toLocaleString()} FCFA)`
        : `VIP Plan - ${planId.toUpperCase()}`,
      is_fixed_amount: true
    };

    console.log('💳 Initiating AshtechPay payment for user:', user.id);
    console.log('   Amount:', amount, 'FCFA');
    console.log('   Plan:', planId);

    const ashtechResponse = await axios.post(
      'https://ashtechpay.top/api/v1/hosted-payment/create',
      ashtechPayload,
      {
        headers: {
          'Authorization': `Bearer ${ashtechHpKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const { payment_link, payment_id } = ashtechResponse.data;

    if (!payment_link || !payment_id) {
      throw new Error('AshtechPay did not return a payment link');
    }

    console.log('✅ AshtechPay payment created, payment_id:', payment_id);

    // Store mapping so the webhook can find this user/plan
    pendingPaymentMap[payment_id] = {
      userId: user.id,
      planId,
      amount,
      isUpgrade: upgrading,
      previousPlan: upgrading ? currentPlan : null,
      createdAt: now.toISOString()
    };

    // Also store on user object for fallback lookup
    user.pendingPurchase = {
      planId,
      amount,
      paymentId: payment_id,
      isUpgrade: upgrading,
      previousPlan: upgrading ? currentPlan : null,
      paymentMethod: 'AshtechPay',
      createdAt: now.toISOString(),
      verified: false,
    };
    saveUsers();

    return res.json({
      message: 'Payment redirect required',
      paymentUrl: payment_link,
      reference: payment_id,
      amount,
      planId,
      pending: true
    });
  } catch (error) {
    console.error('AshtechPay initialization error:', error.response?.data || error.message);
    return res.status(500).json({
      message: 'Failed to initialize payment',
      error: error.response?.data?.message || error.message
    });
  }

  // Otherwise assume instant activation (mobile money - Orange Money or MTN)
  user.walletBalance = (user.walletBalance || 0) + amount;
  user.activePlan = planId;
  user.active_plan = planId;
  user.totalDeposited = (user.totalDeposited || 0) + amount;
  user.total_deposited = user.totalDeposited;
  const withdrawalDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  user.withdrawalAvailableAt = withdrawalDate.toISOString();
  user.lastTransactionDate = now.toISOString();
  // Record transaction
  user.transactions = user.transactions || [];
  const txType = upgrading ? 'plan_upgrade' : 'plan_purchase';
  user.transactions.push({ id: crypto.randomBytes(8).toString('hex'), type: txType, planId, amount, paymentMethod, previousPlan: upgrading ? currentPlan : null, at: now.toISOString() });

  applyReferralCommission(user, amount);
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
      .eq('token', token)
      .then(({ error }) => {
        if (error) console.error('Error updating user in Supabase:', error);
      });
  }

  res.json({
    message: 'Plan purchased successfully',
    withdrawalAvailableAt: user.withdrawalAvailableAt,
    activePlan: user.activePlan,
    walletBalance: user.walletBalance,
  });
});

// ── Upgrade plan using wallet balance ──
app.post('/api/plans/upgrade-with-balance', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  let user = findUserByToken(token);

  if (!user && supabase) {
    try {
      const { data, error } = await supabase.from('users').select('*').eq('token', token).single();
      if (!error && data) {
        user = data;
        if (user.wallet_balance !== undefined) user.walletBalance = user.wallet_balance;
        if (user.active_plan !== undefined) user.activePlan = user.active_plan;
        if (user.total_deposited !== undefined) user.totalDeposited = user.total_deposited;
        users.push(user);
        saveUsers();
      }
    } catch (err) { console.warn('Supabase lookup failed:', err.message); }
  }

  if (!user) return res.status(401).json({ message: 'Invalid or missing token' });

  const { planId } = req.body;
  if (!planId) return res.status(400).json({ message: 'Missing planId' });

  const PLAN_ORDER_V = ['vip1','vip2','vip3','vip4','vip5','vip6','vip7'];
  const PLAN_PRICES_V = { vip1: 10000, vip2: 25000, vip3: 50000, vip4: 100000, vip5: 200000, vip6: 400000, vip7: 800000 };

  const currentPlan = user.activePlan || user.active_plan;
  const currentPlanIdx = currentPlan ? PLAN_ORDER_V.indexOf(currentPlan) : -1;
  const newPlanIdx = PLAN_ORDER_V.indexOf(planId);

  if (newPlanIdx === -1) return res.status(400).json({ message: 'Invalid plan ID.' });
  if (currentPlanIdx < 0) return res.status(400).json({ message: 'You need an active plan before upgrading.' });
  if (newPlanIdx <= currentPlanIdx) return res.status(400).json({ message: 'You cannot downgrade. Choose a higher VIP level.' });

  const newPlanPrice = PLAN_PRICES_V[planId];
  const currentPlanPrice = PLAN_PRICES_V[currentPlan] || 0;
  const upgradeAmount = newPlanPrice - currentPlanPrice;
  const requiredBalance = newPlanPrice * 1.5;
  const balance = user.walletBalance || user.wallet_balance || 0;

  if (balance < requiredBalance) {
    return res.status(400).json({
      message: `Insufficient balance. You need at least ${requiredBalance.toLocaleString()} FCFA (1.5× the plan price) to upgrade with your balance. You currently have ${balance.toLocaleString()} FCFA.`
    });
  }

  const now = new Date();
  user.walletBalance = balance - upgradeAmount;
  user.wallet_balance = user.walletBalance;
  user.activePlan = planId;
  user.active_plan = planId;
  user.total_deposited = (user.total_deposited || user.totalDeposited || 0) + upgradeAmount;
  user.totalDeposited = user.total_deposited;
  user.lastTransactionDate = now.toISOString();

  user.transactions = user.transactions || [];
  user.transactions.push({
    id: crypto.randomBytes(8).toString('hex'),
    type: 'plan_upgrade',
    planId,
    amount: upgradeAmount,
    previousPlan: currentPlan,
    paymentMethod: 'wallet',
    at: now.toISOString()
  });

  saveUsers();

  if (supabase) {
    supabase.from('users').update({
      active_plan: user.activePlan,
      wallet_balance: user.walletBalance,
      total_deposited: user.total_deposited,
      last_transaction_date: user.lastTransactionDate,
    }).eq('token', token).then(({ error }) => {
      if (error) console.error('Supabase update failed:', error);
    });
  }

  return res.json({
    message: `Successfully upgraded to ${planId.toUpperCase()}`,
    activePlan: user.activePlan,
    walletBalance: user.walletBalance,
  });
});

// Payment verification stub - in real app this would be called by payment gateway webhook

app.post('/api/payments/verify', (req, res) => {
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
  
  applyReferralCommission(user, user.pendingPurchase.amount);
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

// AshtechPay Webhook handler (shared logic)
async function handleAshtechWebhook(req, res) {
  console.log('🔔 AshtechPay webhook received');
  console.log('   Body:', JSON.stringify(req.body));

  // Verify webhook secret if configured
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const incomingSecret = req.headers['x-webhook-secret'] || req.headers['x-ashtechpay-secret'] || req.body?.secret;
    if (incomingSecret !== webhookSecret) {
      console.warn('⚠️ Webhook rejected: invalid secret');
      return res.status(401).json({ message: 'Unauthorized' });
    }
  }

  try {
    const body = req.body;

    // AshtechPay may send flat or nested format — normalise both
    const event      = body.event || body.type || '';
    const paymentId  = body.payment_id || body.data?.payment_id || body.id || '';
    const status     = body.status    || body.data?.status    || '';
    const amount     = body.amount    || body.data?.amount    || 0;

    const isSuccess = ['success', 'completed', 'successful', 'paid'].includes(String(status).toLowerCase())
      || ['payment.success', 'payment.completed', 'charge.success', 'payment.paid'].includes(String(event).toLowerCase());

    const isFailed = ['failed', 'cancelled', 'canceled'].includes(String(status).toLowerCase())
      || ['payment.failed', 'payment.cancelled', 'charge.failed'].includes(String(event).toLowerCase());

    if (!isSuccess && !isFailed) {
      console.log(`⚠️ Unhandled webhook event/status: event=${event} status=${status}`);
      return res.json({ message: 'Webhook received', event, status });
    }

    // Look up which user/plan this payment belongs to
    let pendingInfo = paymentId ? pendingPaymentMap[paymentId] : null;
    let user = null;

    if (pendingInfo) {
      user = users.find(u => u.id === pendingInfo.userId);
    }

    // Fallback: search users for matching pendingPurchase.paymentId
    if (!user && paymentId) {
      user = users.find(u => u.pendingPurchase?.paymentId === paymentId);
      if (user && user.pendingPurchase) {
        pendingInfo = {
          userId: user.id,
          planId: user.pendingPurchase.planId,
          amount: user.pendingPurchase.amount,
          isUpgrade: user.pendingPurchase.isUpgrade,
          previousPlan: user.pendingPurchase.previousPlan
        };
      }
    }

    if (isFailed) {
      console.log('❌ Payment failed, payment_id:', paymentId);
      if (user?.pendingPurchase) {
        delete user.pendingPurchase;
        saveUsers();
      }
      if (paymentId) delete pendingPaymentMap[paymentId];
      return res.json({ message: 'Payment failed notification received', status: 'failed' });
    }

    // isSuccess
    if (!pendingInfo || !user) {
      console.error('❌ Could not find user for payment_id:', paymentId);
      return res.status(404).json({ message: 'User or pending purchase not found' });
    }

    const { planId, isUpgrade, previousPlan } = pendingInfo;
    const finalAmount = pendingInfo.amount || amount;
    const now = new Date();
    const txType = isUpgrade ? 'plan_upgrade' : 'plan_purchase';

    console.log(`📦 Activating ${planId} for user ${user.email} — ${finalAmount} FCFA`);

    user.wallet_balance   = (user.wallet_balance || 0) + finalAmount;
    user.walletBalance    = user.wallet_balance;
    user.active_plan      = planId;
    user.activePlan       = planId;
    user.total_deposited  = (user.total_deposited || 0) + finalAmount;
    user.totalDeposited   = user.total_deposited;
    user.last_transaction_date  = now.toISOString();
    user.lastTransactionDate    = now.toISOString();
    user.withdrawal_available_at = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    user.withdrawalAvailableAt  = user.withdrawal_available_at;

    user.transactions = user.transactions || [];
    user.transactions.push({
      id: crypto.randomBytes(8).toString('hex'),
      type: txType,
      planId,
      amount: finalAmount,
      paymentMethod: 'AshtechPay',
      previousPlan: isUpgrade ? previousPlan : null,
      ashtechPaymentId: paymentId,
      at: now.toISOString(),
      status: 'verified'
    });

    applyReferralCommission(user, finalAmount);
    delete user.pendingPurchase;
    if (paymentId) delete pendingPaymentMap[paymentId];
    saveUsers();

    if (supabase) {
      supabase.from('users').update({
        active_plan: user.active_plan,
        wallet_balance: user.wallet_balance,
        total_deposited: user.total_deposited,
        withdrawal_available_at: user.withdrawal_available_at,
        last_transaction_date: user.last_transaction_date,
      }).eq('id', user.id).then(({ error }) => {
        if (error) console.warn('⚠️ Supabase update error:', error.message);
        else console.log('✅ Supabase updated for user:', user.id);
      });
    }

    console.log(`✅ PLAN ACTIVATED: user=${user.email} plan=${planId} amount=${finalAmount}`);
    return res.json({ message: 'Payment verified and plan activated', planId, amount: finalAmount, confirmed: true });

  } catch (error) {
    console.error('❌ AshtechPay webhook error:', error.message);
    res.status(500).json({ message: 'Internal server error' });
  }
}

// Keep old route active (configured in AshtechPay dashboard)
app.post('/api/webhooks/notchpay', handleAshtechWebhook);
// New canonical route (update in AshtechPay dashboard when ready)
app.post('/api/webhooks/ashtechpay', handleAshtechWebhook);

// Webhook health check
app.get('/api/webhooks/notchpay/health', (req, res) => {
  res.json({
    status: ashtechHpKey ? 'ready' : 'not-configured',
    provider: 'AshtechPay',
    hasHpKey: !!ashtechHpKey,
    hasSecretKey: !!ashtechSecretKey,
    message: ashtechHpKey ? 'AshtechPay webhook is configured and ready' : 'AshtechPay credentials are missing'
  });
});

// Payment status check - called by PaymentSuccess page after AshtechPay redirect
app.get('/api/payment-status', async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ message: 'Missing ref parameter' });

  // 1. Try to verify directly with AshtechPay status API
  if (ashtechSecretKey) {
    try {
      const ashtechRes = await axios.get(`https://ashtechpay.top/api/v1/hosted-payment/${ref}`, {
        headers: { 'Authorization': `Bearer ${ashtechSecretKey}` }
      });
      const payment = ashtechRes.data?.data || ashtechRes.data;
      if (payment && payment.status) {
        const isCompleted = ['success', 'completed', 'successful', 'paid'].includes(
          String(payment.status).toLowerCase()
        );
        if (isCompleted) {
          // Find associated plan from our pending map or user store
          const pending = pendingPaymentMap[ref];
          const planId = pending?.planId
            || users.find(u => u.pendingPurchase?.paymentId === ref)?.pendingPurchase?.planId
            || users.find(u => (u.transactions || []).some(t => t.ashtechPaymentId === ref))
                    ?.transactions?.find(t => t.ashtechPaymentId === ref)?.planId;
          console.log(`✅ Payment ${ref} verified via AshtechPay API - plan: ${planId}`);
          return res.json({ status: 'completed', plan: planId });
        }
        return res.json({ status: 'pending' });
      }
    } catch (err) {
      console.warn('AshtechPay direct verify failed, using local fallback:', err.message);
    }
  }

  // 2. Local fallback — ref is the payment_id (UUID from AshtechPay)
  try {
    // Check pending map
    const pending = pendingPaymentMap[ref];
    if (pending) {
      const user = users.find(u => u.id === pending.userId);
      if (user) {
        const tx = (user.transactions || []).find(t => t.ashtechPaymentId === ref);
        if (tx) return res.json({ status: 'completed', plan: tx.planId });
        if (user.pendingPurchase?.paymentId === ref) return res.json({ status: 'pending' });
      }
    }

    // Search all users for this payment_id
    const userWithTx = users.find(u =>
      (u.transactions || []).some(t => t.ashtechPaymentId === ref)
    );
    if (userWithTx) {
      const tx = userWithTx.transactions.find(t => t.ashtechPaymentId === ref);
      return res.json({ status: 'completed', plan: tx.planId });
    }

    const userPending = users.find(u => u.pendingPurchase?.paymentId === ref);
    if (userPending) return res.json({ status: 'pending' });

    // Supabase: if the plan is now active, the webhook already fired
    if (supabase && pending?.userId) {
      const { data } = await supabase.from('users').select('active_plan').eq('id', pending.userId).single();
      if (data?.active_plan) return res.json({ status: 'completed', plan: data.active_plan });
    }

    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('Payment status check error:', err);
    res.status(500).json({ message: 'Error checking payment status' });
  }
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
        u.total_profits = (u.total_profits || 0) + earningsAmount;
        u.lastEarningsCredit = now.toISOString();
        u.transactions = u.transactions || [];
        u.transactions.push({
          id: crypto.randomBytes(8).toString('hex'),
          type: 'referral_daily_earnings',
          amount: earningsAmount,
          at: now.toISOString()
        });
        if (supabase) {
          supabase.from('users').update({
            wallet_balance: u.wallet_balance,
            total_profits: u.total_profits,
          }).eq('id', u.id).then(({ error }) => {
            if (error) console.error('Daily earnings Supabase update error for', u.email, ':', error);
          });
        }
        changed = true;
        console.log(`Credited ${earningsAmount} FCFA daily earnings to user ${u.email} (Tier: ${tier.commission}, Referrals: ${referralCount})`);
      }
    }
  });
  
  if (changed) saveUsers();
}, 24 * 60 * 60 * 1000);  // Run once per day

// Background job: execute pending sell orders after their 13-day countdown — runs every hour
setInterval(() => {
  const now = new Date();
  let changed = false;

  users.forEach(u => {
    const pendingSells = u.pendingSells || [];
    const dueSells = pendingSells.filter(ps => ps.status === 'pending' && new Date(ps.sellAt) <= now);
    if (dueSells.length === 0) return;

    const activePlan = u.activePlan || u.active_plan;
    const vipBenefits = getVipBenefits(activePlan);

    for (const ps of dueSells) {
      const product = PRODUCTS.find(p => p.id === ps.productId);
      const price = (product ? product.price : null) || ps.productPrice;
      const profitAmount = Math.floor(price * 13 / 30);
      const vipBonus = Math.floor(price * vipBenefits.sellBonus);
      const saleAmount = price + profitAmount + vipBonus;
      const earnedProfit = profitAmount + vipBonus;

      const currentBal = u.walletBalance !== undefined ? u.walletBalance : (u.wallet_balance || 0);
      u.walletBalance = currentBal + saleAmount;
      u.wallet_balance = u.walletBalance;
      u.total_profits = (u.total_profits || 0) + earnedProfit;

      ps.status = 'completed';
      ps.completedAt = now.toISOString();
      ps.saleAmount = saleAmount;
      ps.profitEarned = earnedProfit;

      u.transactions = u.transactions || [];
      u.transactions.push({
        id: crypto.randomBytes(8).toString('hex'),
        type: 'product_sell',
        productId: ps.productId,
        amount: saleAmount,
        profit: earnedProfit,
        at: now.toISOString(),
        description: `System sold ${ps.productName} — profit: ${earnedProfit.toLocaleString()} FCFA`
      });

      u.notifications = u.notifications || [];
      u.notifications.push({
        id: crypto.randomBytes(8).toString('hex'),
        type: 'sell_complete',
        message: `✅ Your ${ps.productName} was sold by the system! ${saleAmount.toLocaleString()} FCFA credited to your wallet (profit: ${earnedProfit.toLocaleString()} FCFA).`,
        at: now.toISOString(),
      });

      if (supabase) {
        supabase.from('users').update({
          wallet_balance: u.walletBalance,
          total_profits: u.total_profits,
        }).eq('id', u.id).then(({ error }) => {
          if (error) console.error('Sell job Supabase update error for', u.email, ':', error);
        });
      }

      changed = true;
      console.log(`System sold ${ps.productName} for ${u.email} — ${saleAmount} FCFA (profit: ${earnedProfit} FCFA)`);
    }
  });

  if (changed) saveUsers();
}, 60 * 60 * 1000); // Run every hour

// --- products list (server-side) ---
// replicate frontend PRODUCTS for server-side validation
const PRODUCTS = [
  { id: 1, name: '📱 Smartphone', price: 10000, minVip: null },
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
  { id: 15, name: '🏢 Real Estate Access', price: 300000, minVip: 'vip6' },
  { id: 16, name: '🎭 Entertainment Package', price: 250000, minVip: 'vip6' },
  { id: 17, name: '🏊 Resort Membership', price: 350000, minVip: 'vip6' },
  { id: 18, name: '💼 Business Package', price: 500000, minVip: 'vip7' },
  { id: 19, name: '🌟 Platinum Benefits', price: 600000, minVip: 'vip7' },
  { id: 20, name: '🎯 Elite Access', price: 700000, minVip: 'vip7' },
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
    5: { purchaseDiscount: 0.25, sellBonus: 0.15 }, // VIP5: 25% discount, 15% bonus
    6: { purchaseDiscount: 0.30, sellBonus: 0.20 }, // VIP6: 30% discount, 20% bonus
    7: { purchaseDiscount: 0.35, sellBonus: 0.25 }  // VIP7: 35% discount, 25% bonus
  };
  return benefits[level] || benefits[0];
}

// endpoint for purchasing a product
app.post('/api/products/buy', async (req, res) => {
  console.log('Received product purchase request', req.body);
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  let user = null;
  if (supabase) {
    const { data, error } = await supabase.from('users').select('*').eq('token', token).single();
    if (!error && data) user = data;
  }
  if (!user) user = findUserByToken(token);
  if (!user) {
    console.log('product purchase denied, invalid token');
    return res.status(401).json({ message: 'Invalid or missing token' });
  }
  if (user.wallet_balance !== undefined) user.walletBalance = user.wallet_balance;
  if (user.active_plan !== undefined) user.activePlan = user.active_plan;
  if (user.next_purchase_window_ends !== undefined) user.nextPurchaseWindowEnds = user.next_purchase_window_ends;
  if (user.owned_products !== undefined) user.ownedProducts = user.owned_products;
  if (user.total_product_purchases !== undefined) user.totalProductPurchases = user.total_product_purchases;

  const { productId } = req.body;
  if (productId == null) {
    return res.status(400).json({ message: 'Missing productId' });
  }

  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return res.status(404).json({ message: 'Product not found' });

  // Normalize camelCase / snake_case fields that may differ based on storage path
  const activePlan = user.activePlan || user.active_plan;
  const nextPurchaseWindow = user.nextPurchaseWindowEnds || user.next_purchase_window_ends;

  // ensure user has required VIP level
  if (product.minVip && vipLevel(activePlan) < vipLevel(product.minVip)) {
    return res.status(403).json({ message: `Requires ${product.minVip.toUpperCase()} membership` });
  }

  // enforce 13-day cooldown: if nextPurchaseWindowEnds exists and is in the future, block purchase
  if (nextPurchaseWindow) {
    const nextWindow = new Date(nextPurchaseWindow);
    const now = new Date();
    if (nextWindow > now) {
      const diff = nextWindow.getTime() - now.getTime();
      return res.status(429).json({ message: 'Next purchase window not yet open', retryAfterMs: diff, nextPurchaseWindowEnds: nextPurchaseWindow });
    }
  }

  const balance = user.walletBalance !== undefined ? user.walletBalance : (user.wallet_balance || 0);

  // Apply VIP purchase discount
  const vipBenefits = getVipBenefits(activePlan);
  const discountAmount = Math.floor(product.price * vipBenefits.purchaseDiscount);
  const finalPrice = product.price - discountAmount;

  if (balance < finalPrice) {
    return res.status(400).json({ message: 'Insufficient balance' });
  }

  // deduct discounted price and update purchase timestamps
  const newBalance = balance - finalPrice;
  user.walletBalance = newBalance;
  user.wallet_balance = newBalance;
  const now = new Date();
  user.lastProductPurchase = now.toISOString();
  user.last_product_purchase = user.lastProductPurchase;
  user.nextPurchaseWindowEnds = new Date(now.getTime() + 13 * 24 * 60 * 60 * 1000).toISOString();
  user.next_purchase_window_ends = user.nextPurchaseWindowEnds;

  // track owned products
  user.ownedProducts = user.ownedProducts || {};
  user.ownedProducts[productId] = (user.ownedProducts[productId] || 0) + 1;
  user.totalProductPurchases = (user.totalProductPurchases || 0) + 1;

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
        owned_products: user.ownedProducts,
        total_product_purchases: user.totalProductPurchases,
      })
      .eq('token', token)
      .then(({ error }) => {
        if (error) console.error('Error updating user in Supabase after buy:', error);
      });
  }

  return res.json({ message: 'Product purchased successfully', walletBalance: user.walletBalance, lastProductPurchase: user.lastProductPurchase, nextPurchaseWindowEnds: user.nextPurchaseWindowEnds, totalProductPurchases: user.totalProductPurchases });
});

// endpoint: user requests the system to sell their product (starts 13-day countdown)
app.post('/api/products/sell', async (req, res) => {
  console.log('Received sell request', req.body);
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  let user = findUserByToken(token);
  if (!user && supabase) {
    const { data, error } = await supabase.from('users').select('*').eq('token', token).single();
    if (!error && data) {
      user = data;
      if (user.owned_products && !user.ownedProducts) user.ownedProducts = user.owned_products;
      if (user.active_plan && !user.activePlan) user.activePlan = user.active_plan;
      if (user.wallet_balance !== undefined && user.walletBalance === undefined) user.walletBalance = user.wallet_balance;
    }
  }
  if (!user) return res.status(401).json({ message: 'Invalid or missing token' });

  const { productId } = req.body;
  if (productId == null) return res.status(400).json({ message: 'Missing productId' });

  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return res.status(404).json({ message: 'Product not found' });

  user.ownedProducts = user.ownedProducts || {};
  const owned = user.ownedProducts[productId] || 0;
  if (owned <= 0) return res.status(400).json({ message: 'You do not own this product' });

  // Check if this product is already in pending sell
  user.pendingSells = user.pendingSells || [];
  const alreadyPending = user.pendingSells.find(ps => ps.productId === productId && ps.status === 'pending');
  if (alreadyPending) {
    return res.status(400).json({
      message: 'This product is already queued for sale.',
      pendingSell: alreadyPending
    });
  }

  // Create pending sell order — system will execute after 13 days
  const now = new Date();
  const sellAt = new Date(now.getTime() + 13 * 24 * 60 * 60 * 1000);
  const pendingSell = {
    id: `ps_${Date.now()}_${productId}`,
    productId,
    productName: product.name,
    productPrice: product.price,
    requestedAt: now.toISOString(),
    sellAt: sellAt.toISOString(),
    status: 'pending'
  };

  user.pendingSells.push(pendingSell);

  // Move product out of "owned" into "pending sell" so it can't be sold twice
  user.ownedProducts[productId] = owned - 1;
  user.owned_products = user.ownedProducts;

  saveUsers();

  return res.json({
    message: 'Sell order placed. The system will sell your product in 13 days.',
    pendingSell,
    sellAt: sellAt.toISOString()
  });
});

// Get user's pending sell orders
app.get('/api/products/pending-sells', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });
  const pendingSells = (user.pendingSells || []).filter(ps => ps.status === 'pending');
  return res.json(pendingSells);
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

  // Block duplicate pending requests — check both in-memory and Supabase
  const alreadyPendingMemory = pendingWithdrawals.find(w => w.userId === user.id && w.status === 'pending');
  if (alreadyPendingMemory) {
    return res.status(400).json({ message: 'You already have a pending withdrawal request. Please wait for admin review.' });
  }
  if (supabase) {
    const { data: existingPending } = await supabase
      .from('withdrawal_requests')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .limit(1);
    if (existingPending && existingPending.length > 0) {
      return res.status(400).json({ message: 'You already have a pending withdrawal request. Please wait for admin review.' });
    }
  }

  // Check product purchase requirement (must have bought at least 3 times)
  const totalPurchases = user.totalProductPurchases || user.total_product_purchases || 0;
  if (totalPurchases < 3) {
    return res.status(403).json({
      message: `You need to purchase products at least 3 times before withdrawing. You have made ${totalPurchases} purchase(s) so far.`
    });
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

  const balance = user.walletBalance !== undefined ? user.walletBalance : (user.wallet_balance || 0);
  const maxWithdrawal = Math.floor(balance * 0.5);
  if (amount <= 0 || amount > maxWithdrawal) {
    return res.status(400).json({ message: `You can only withdraw up to 50% of your balance. Maximum allowed: ${maxWithdrawal.toLocaleString()} FCFA` });
  }

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

  // Persist to Supabase using snake_case column names
  if (supabase) {
    supabase
      .from('withdrawal_requests')
      .insert([{
        id: withdrawalRequest.id,
        user_id: user.id,
        username: user.username,
        email: user.email,
        amount: withdrawalRequest.amount,
        phone_number: phoneNumber,
        payment_method: paymentMethod,
        status: 'pending',
      }])
      .then(({ error }) => {
        if (error) console.error('Error saving withdrawal to Supabase:', error);
        else console.log('✅ Withdrawal request saved to Supabase');
      });
  }

  return res.json({
    message: 'Withdrawal request submitted. Admin will review shortly.',
    requestId: withdrawalRequest.id,
    withdrawal: withdrawalRequest
  });
});

// User's own withdrawal history
app.get('/api/users/my-withdrawals', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  try {
    if (supabase) {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (!error && data && data.length > 0) return res.json(data);
    }
    // Fallback: in-memory
    const userWithdrawals = pendingWithdrawals
      .filter(w => w.userId === user.id)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return res.json(userWithdrawals);
  } catch (err) {
    console.error('Error fetching user withdrawals:', err);
    res.status(500).json({ message: 'Error fetching withdrawals' });
  }
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

app.post('/api/admin/modify-withdrawal', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (token !== adminToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { requestId, amount, phoneNumber, paymentMethod, adminNote } = req.body;
  if (!requestId) return res.status(400).json({ message: 'requestId is required' });

  try {
    if (supabase) {
      const { data: existing, error: fError } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('id', requestId)
        .single();

      if (fError || !existing) return res.status(404).json({ message: 'Withdrawal request not found' });
      if (existing.status !== 'pending') return res.status(400).json({ message: 'Can only modify pending withdrawals' });

      const updates = {};
      if (amount !== undefined && amount !== '') updates.amount = parseInt(amount);
      if (phoneNumber !== undefined && phoneNumber !== '') updates.phoneNumber = phoneNumber;
      if (paymentMethod !== undefined && paymentMethod !== '') updates.paymentMethod = paymentMethod;
      if (adminNote !== undefined) updates.adminNote = adminNote;
      // Preserve original values on first modification
      if (!existing.originalAmount) updates.originalAmount = existing.amount;
      if (!existing.originalPhoneNumber) updates.originalPhoneNumber = existing.phoneNumber;
      updates.adminModified = true;

      const { data: updated, error: uError } = await supabase
        .from('withdrawal_requests')
        .update(updates)
        .eq('id', requestId)
        .select()
        .single();

      if (uError) {
        // Supabase may reject unknown columns — fall back to in-memory only
        const memW = pendingWithdrawals.find(w => w.id === requestId);
        if (memW) {
          memW.originalAmount = memW.originalAmount || memW.amount;
          memW.originalPhoneNumber = memW.originalPhoneNumber || memW.phoneNumber;
          if (amount !== undefined && amount !== '') memW.amount = parseInt(amount);
          if (phoneNumber !== undefined && phoneNumber !== '') memW.phoneNumber = phoneNumber;
          if (paymentMethod !== undefined && paymentMethod !== '') memW.paymentMethod = paymentMethod;
          if (adminNote !== undefined) memW.adminNote = adminNote;
          memW.adminModified = true;
        }
        return res.json({ message: 'Withdrawal updated (memory)', withdrawal: memW || {} });
      }

      const memW = pendingWithdrawals.find(w => w.id === requestId);
      if (memW) Object.assign(memW, updates);

      return res.json({ message: 'Withdrawal updated', withdrawal: updated });
    } else {
      const withdrawal = pendingWithdrawals.find(w => w.id === requestId);
      if (!withdrawal) return res.status(404).json({ message: 'Withdrawal request not found' });
      if (withdrawal.status !== 'pending') return res.status(400).json({ message: 'Can only modify pending withdrawals' });

      withdrawal.originalAmount = withdrawal.originalAmount || withdrawal.amount;
      withdrawal.originalPhoneNumber = withdrawal.originalPhoneNumber || withdrawal.phoneNumber;
      if (amount !== undefined && amount !== '') withdrawal.amount = parseInt(amount);
      if (phoneNumber !== undefined && phoneNumber !== '') withdrawal.phoneNumber = phoneNumber;
      if (paymentMethod !== undefined && paymentMethod !== '') withdrawal.paymentMethod = paymentMethod;
      if (adminNote !== undefined) withdrawal.adminNote = adminNote;
      withdrawal.adminModified = true;

      return res.json({ message: 'Withdrawal updated', withdrawal });
    }
  } catch (err) {
    console.error('Error modifying withdrawal:', err);
    res.status(500).json({ message: 'Failed to modify withdrawal' });
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
      const userId = withdrawal.user_id || withdrawal.userId;
      const { data: userData } = await supabase
        .from('users')
        .select('wallet_balance')
        .eq('id', userId)
        .single();

      if (userData) {
        const newBalance = (userData.wallet_balance || 0) - withdrawal.amount;
        await supabase
          .from('users')
          .update({ wallet_balance: newBalance })
          .eq('id', userId);
        // Also update in-memory
        const memUser = users.find(u => u.id === userId);
        if (memUser) {
          memUser.wallet_balance = newBalance;
          memUser.walletBalance = newBalance;
          saveUsers();
        }
      }

      // Update withdrawal status
      const { data: updated, error: uError } = await supabase
        .from('withdrawal_requests')
        .update({ status: 'approved', approved_at: new Date().toISOString() })
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

app.post('/api/admin/block-user', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (token !== adminToken) return res.status(401).json({ message: 'Unauthorized' });

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ message: 'userId is required' });

  try {
    await updateUser(userId, { is_active: false, status: 'blocked' });
    return res.json({ message: 'User blocked successfully' });
  } catch (err) {
    console.error('Error blocking user:', err);
    return res.status(500).json({ message: 'Failed to block user' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});