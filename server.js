const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
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

/* ===== SUPABASE ===== */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('✅ Supabase initialized at', supabaseUrl);
} else {
  console.error('❌ Supabase credentials missing — all endpoints will fail!');
}

/* ===== ASHTECHPAY ===== */
const ashtechPublicKey = process.env.ASHTECHPAY_PUBLIC_KEY;
const ashtechSecretKey = process.env.ASHTECHPAY_SECRET_KEY;
const ashtechHpKey     = process.env.ASHTECHPAY_HP_KEY;

if (ashtechHpKey) {
  console.log('✅ AshtechPay initialized');
} else {
  console.warn('⚠️ AshtechPay credentials not found. Online payments will be disabled.');
}

// Transient map: payment_id → { userId, planId, amount, isUpgrade, previousPlan }
const pendingPaymentMap = {};

// Admin session token (volatile — admin re-logs after server restart)
let adminToken = null;

/* ===== HELPER FUNCTIONS ===== */

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function makeReferralCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

function getCommissionTier(referralCount) {
  if (referralCount >= 100) return { commissionPercent: 0.20, commission: '20%', daily: 6000, bonusAmount: 0, bonus: 'Elite Partner - VIP benefits', badge: '👑' };
  if (referralCount >= 51)  return { commissionPercent: 0.15, commission: '15%', daily: 2250, bonusAmount: 15000, bonus: '15,000 FCFA bonus', badge: '💎' };
  if (referralCount >= 31)  return { commissionPercent: 0.12, commission: '12%', daily: 840,  bonusAmount: 5000,  bonus: '5,000 FCFA bonus',  badge: '🌟' };
  if (referralCount >= 16)  return { commissionPercent: 0.10, commission: '10%', daily: 300,  bonusAmount: 2000,  bonus: '2,000 FCFA bonus',  badge: '👨‍💼' };
  if (referralCount >= 6)   return { commissionPercent: 0.07, commission: '7%',  daily: 105,  bonusAmount: 500,   bonus: '500 FCFA bonus',    badge: '👥' };
  if (referralCount >= 1)   return { commissionPercent: 0.05, commission: '5%',  daily: 25,   bonusAmount: 0,     bonus: 'Standard Member',   badge: '👤' };
  return { commissionPercent: 0, commission: '0%', daily: 0, bonusAmount: 0, bonus: 'No referrals yet', badge: '👤' };
}

function checkTierUpgrade(previousCount, newCount) {
  const prev = getCommissionTier(previousCount);
  const next = getCommissionTier(newCount);
  return next.bonusAmount > prev.bonusAmount ? next.bonusAmount - prev.bonusAmount : 0;
}

/* ===== SUPABASE HELPERS ===== */

async function getUserByToken(token) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('users').select('*').eq('token', token).single();
  if (error) return null;
  return data;
}

async function getUserByEmail(email) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('users').select('*').eq('email', email).single();
  if (error) return null;
  return data;
}

async function updateUser(userId, updates) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('users').update(updates).eq('id', userId).select().single();
  if (error) throw error;
  return data;
}

async function logTransaction(userId, type, amount, description = '') {
  if (!supabase) return;
  const { error } = await supabase.from('transactions').insert([{ user_id: userId, type, amount, description, status: 'completed' }]);
  if (error) console.error('Transaction log error:', error);
}

async function applyReferralCommission(purchaserId, planAmount) {
  if (!supabase) return;
  const { data: purchaser } = await supabase.from('users').select('referrer_id, username, email').eq('id', purchaserId).single();
  if (!purchaser?.referrer_id) return;
  const { data: referrer } = await supabase.from('users').select('id, email, wallet_balance, total_profits, referral_count').eq('id', purchaser.referrer_id).single();
  if (!referrer) return;
  const tier = getCommissionTier(referrer.referral_count || 0);
  const commissionAmount = Math.floor(planAmount * tier.commissionPercent);
  if (commissionAmount <= 0) return;
  await supabase.from('users').update({
    wallet_balance: (referrer.wallet_balance || 0) + commissionAmount,
    total_profits: (referrer.total_profits || 0) + commissionAmount,
  }).eq('id', referrer.id);
  await logTransaction(referrer.id, 'referral_commission', commissionAmount,
    `Commission on plan purchase by ${purchaser.username || purchaser.email} (${tier.commission})`);
  console.log(`Commission ${commissionAmount} FCFA credited to referrer ${referrer.email}`);
}

/* ===== AUTH ENDPOINTS ===== */

app.post('/api/auth/register', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });

  const { email, password, username, firstName, lastName, phoneNumber, referralCode } = req.body;
  if (!email || !password || !username) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  // Check if user already exists
  const existing = await getUserByEmail(email);
  if (existing) return res.status(409).json({ message: 'User already exists' });

  // Validate referral code
  let referrerId = null;
  if (referralCode) {
    const { data: referrer } = await supabase.from('users').select('id, referral_count, wallet_balance, total_profits').eq('referral_code', referralCode).single();
    if (!referrer) return res.status(400).json({ message: 'Invalid referral code' });
    referrerId = referrer.id;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = {
    email,
    password: hashedPassword,
    username,
    first_name: firstName || '',
    last_name: lastName || '',
    phone_number: phoneNumber || '',
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
    const { data: createdUser, error: insertError } = await supabase.from('users').insert([newUser]).select().single();
    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return res.status(500).json({ message: 'Registration failed' });
    }

    // Increment referrer count and credit tier bonus if applicable
    if (referrerId) {
      const { data: referrer } = await supabase.from('users').select('referral_count, wallet_balance, total_profits').eq('id', referrerId).single();
      if (referrer) {
        const previousCount = referrer.referral_count || 0;
        const newCount = previousCount + 1;
        const tierBonus = checkTierUpgrade(previousCount, newCount);
        const updates = {
          referral_count: newCount,
        };
        if (tierBonus > 0) {
          updates.wallet_balance = (referrer.wallet_balance || 0) + tierBonus;
          updates.total_profits = (referrer.total_profits || 0) + tierBonus;
          const tier = getCommissionTier(newCount);
          await logTransaction(referrerId, 'referral_tier_bonus', tierBonus, `Tier upgrade bonus — reached ${tier.commission} commission tier`);
        }
        await supabase.from('users').update(updates).eq('id', referrerId);
      }
    }

    return res.status(201).json({ message: 'User created', token: createdUser.token, userId: createdUser.id });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ message: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });

  const { email, password } = req.body;
  const user = await getUserByEmail(email);
  if (!user) return res.status(401).json({ message: 'Invalid credentials' });

  const passwordMatch = user.password.startsWith('$2')
    ? await bcrypt.compare(password, user.password)
    : user.password === password;

  if (!passwordMatch) return res.status(401).json({ message: 'Invalid credentials' });

  const token = user.token || makeToken();
  await supabase.from('users').update({ token, last_login: new Date().toISOString() }).eq('id', user.id);

  return res.json({ token });
});

app.post('/api/auth/admin-login', (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (email === adminEmail && password === adminPassword) {
    adminToken = makeToken();
    return res.json({ token: adminToken });
  }
  return res.status(401).json({ message: 'Invalid admin credentials' });
});

/* ===== USER / PROFILE ===== */

app.get('/api/users/profile', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ message: 'Invalid or missing token' });
    const { password, ...publicData } = user;
    res.json(publicData);
  } catch (err) {
    console.error('Error fetching profile:', err);
    res.status(500).json({ message: 'Error fetching profile' });
  }
});

/* ===== TRANSACTIONS ===== */

app.get('/api/transactions', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ message: 'Invalid or missing token' });
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching transactions:', err);
    res.status(500).json({ message: 'Error fetching transactions' });
  }
});

/* ===== REFERRAL ===== */

app.get('/api/referral/stats', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ message: 'Invalid or missing token' });
    const referralCount = user.referral_count || 0;
    const tier = getCommissionTier(referralCount);
    res.json({
      referralCode: user.referral_code,
      referralCount,
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
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ message: 'Invalid or missing token' });
    const referralLink = `${process.env.FRONTEND_URL || 'https://computerarchi.com/Dpay'}/register?ref=${user.referral_code}`;
    res.json({ referralCode: user.referral_code, referralLink });
  } catch (err) {
    console.error('Error fetching referral code:', err);
    res.status(500).json({ message: 'Error fetching referral code' });
  }
});

/* ===== PLAN PURCHASE ===== */

const PLAN_ORDER   = ['vip1', 'vip2', 'vip3', 'vip4', 'vip5', 'vip6', 'vip7'];
const PLAN_PRICES  = { vip1: 10000, vip2: 25000, vip3: 50000, vip4: 100000, vip5: 200000, vip6: 400000, vip7: 800000 };

app.post('/api/plans/purchase', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  console.log('Received plan purchase request', req.body);
  const token = (req.headers.authorization || '').replace('Bearer ', '');

  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Invalid or missing token' });

  const { planId, amount, paymentMethod } = req.body;
  if (!planId || !amount) return res.status(400).json({ message: 'Missing plan details' });

  const currentPlan    = user.active_plan;
  const currentPlanIdx = currentPlan ? PLAN_ORDER.indexOf(currentPlan) : -1;
  const newPlanIdx     = PLAN_ORDER.indexOf(planId);

  if (newPlanIdx === -1) return res.status(400).json({ message: 'Invalid plan ID.' });
  if (currentPlan && newPlanIdx <= currentPlanIdx) return res.status(400).json({ message: 'You cannot downgrade. Please choose a higher VIP level.' });

  const upgrading         = currentPlanIdx >= 0 && newPlanIdx > currentPlanIdx;
  const currentPlanPrice  = upgrading ? (PLAN_PRICES[currentPlan] || 0) : 0;
  const now               = new Date();

  // ── AshtechPay hosted payment ──
  if (!ashtechHpKey) return res.status(500).json({ message: 'AshtechPay is not configured. Please contact support.' });

  try {
    const ashtechPayload = {
      currency: 'XAF',
      amount,
      description: upgrading
        ? `VIP Upgrade: ${currentPlan.toUpperCase()} → ${planId.toUpperCase()} (+${amount.toLocaleString()} FCFA)`
        : `VIP Plan - ${planId.toUpperCase()}`,
      is_fixed_amount: true,
    };

    console.log('💳 Initiating AshtechPay payment for user:', user.id, 'amount:', amount, 'plan:', planId);

    const ashtechResponse = await axios.post(
      'https://ashtechpay.top/api/v1/hosted-payment/create',
      ashtechPayload,
      { headers: { 'Authorization': `Bearer ${ashtechHpKey}`, 'Content-Type': 'application/json' } }
    );

    const { payment_link, payment_id } = ashtechResponse.data;
    if (!payment_link || !payment_id) throw new Error('AshtechPay did not return a payment link');

    console.log('✅ AshtechPay payment created, payment_id:', payment_id);

    pendingPaymentMap[payment_id] = {
      userId: user.id,
      planId,
      amount,
      isUpgrade: upgrading,
      previousPlan: upgrading ? currentPlan : null,
      createdAt: now.toISOString(),
    };

    return res.json({ message: 'Payment redirect required', paymentUrl: payment_link, reference: payment_id, amount, planId, pending: true });
  } catch (error) {
    console.error('AshtechPay initialization error:', error.response?.data || error.message);
    return res.status(500).json({ message: 'Failed to initialize payment', error: error.response?.data?.message || error.message });
  }
});

/* ===== UPGRADE WITH WALLET BALANCE ===== */

app.post('/api/plans/upgrade-with-balance', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');

  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Invalid or missing token' });

  const { planId } = req.body;
  if (!planId) return res.status(400).json({ message: 'Missing planId' });

  const currentPlan    = user.active_plan;
  const currentPlanIdx = currentPlan ? PLAN_ORDER.indexOf(currentPlan) : -1;
  const newPlanIdx     = PLAN_ORDER.indexOf(planId);

  if (newPlanIdx === -1)     return res.status(400).json({ message: 'Invalid plan ID.' });
  if (currentPlanIdx < 0)   return res.status(400).json({ message: 'You need an active plan before upgrading.' });
  if (newPlanIdx <= currentPlanIdx) return res.status(400).json({ message: 'You cannot downgrade. Choose a higher VIP level.' });

  const newPlanPrice  = PLAN_PRICES[planId];
  const currentPrice  = PLAN_PRICES[currentPlan] || 0;
  const upgradeAmount = newPlanPrice - currentPrice;
  const requiredBalance = newPlanPrice * 1.5;
  const balance = user.wallet_balance || 0;

  if (balance < requiredBalance) {
    return res.status(400).json({
      message: `Insufficient balance. You need at least ${requiredBalance.toLocaleString()} FCFA (1.5× the plan price) to upgrade. You have ${balance.toLocaleString()} FCFA.`,
    });
  }

  const now = new Date();
  try {
    const updated = await updateUser(user.id, {
      active_plan:            planId,
      wallet_balance:         balance - upgradeAmount,
      total_deposited:        (user.total_deposited || 0) + upgradeAmount,
      last_transaction_date:  now.toISOString(),
    });

    await logTransaction(user.id, 'plan_upgrade', upgradeAmount, `Upgraded from ${currentPlan} to ${planId} via wallet`);

    return res.json({ message: `Successfully upgraded to ${planId.toUpperCase()}`, activePlan: planId, walletBalance: updated.wallet_balance });
  } catch (err) {
    console.error('Upgrade error:', err);
    res.status(500).json({ message: 'Failed to upgrade plan' });
  }
});

/* ===== PAYMENT VERIFY (manual stub) ===== */

app.post('/api/payments/verify', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const { userId, paymentId } = req.body;
  if (!userId || !paymentId) return res.status(400).json({ message: 'Missing parameters' });

  const pending = pendingPaymentMap[paymentId];
  if (!pending) return res.status(404).json({ message: 'Pending purchase not found' });

  const now = new Date();
  try {
    const { planId, isUpgrade, previousPlan, amount } = pending;
    const { data: userData } = await supabase.from('users').select('wallet_balance, total_deposited').eq('id', userId).single();
    if (!userData) return res.status(404).json({ message: 'User not found' });

    const withdrawalDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await updateUser(userId, {
      active_plan:               planId,
      wallet_balance:            (userData.wallet_balance || 0) + amount,
      total_deposited:           (userData.total_deposited || 0) + amount,
      withdrawal_available_at:   withdrawalDate.toISOString(),
      last_transaction_date:     now.toISOString(),
    });

    await logTransaction(userId, isUpgrade ? 'plan_upgrade' : 'plan_purchase', amount, `Plan ${planId} activated via manual verify`);
    await applyReferralCommission(userId, amount);

    delete pendingPaymentMap[paymentId];
    const { data: updatedUser } = await supabase.from('users').select('wallet_balance, withdrawal_available_at').eq('id', userId).single();
    return res.json({ message: 'Payment verified and plan activated', withdrawalAvailableAt: updatedUser?.withdrawal_available_at, walletBalance: updatedUser?.wallet_balance });
  } catch (err) {
    console.error('Payment verify error:', err);
    res.status(500).json({ message: 'Failed to verify payment' });
  }
});

/* ===== ASHTECHPAY WEBHOOK ===== */

async function handleAshtechWebhook(req, res) {
  console.log('🔔 AshtechPay webhook received');
  console.log('   Body:', JSON.stringify(req.body));

  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const incoming = req.headers['x-webhook-secret'] || req.headers['x-ashtechpay-secret'] || req.body?.secret;
    if (incoming !== webhookSecret) {
      console.warn('⚠️ Webhook rejected: invalid secret');
      return res.status(401).json({ message: 'Unauthorized' });
    }
  }

  try {
    const body      = req.body;
    const event     = body.event || body.type || '';
    const paymentId = body.payment_id || body.data?.payment_id || body.id || '';
    const status    = body.status    || body.data?.status    || '';
    const amount    = body.amount    || body.data?.amount    || 0;

    const isSuccess = ['success', 'completed', 'successful', 'paid'].includes(String(status).toLowerCase())
      || ['payment.success', 'payment.completed', 'charge.success', 'payment.paid'].includes(String(event).toLowerCase());
    const isFailed  = ['failed', 'cancelled', 'canceled'].includes(String(status).toLowerCase())
      || ['payment.failed', 'payment.cancelled', 'charge.failed'].includes(String(event).toLowerCase());

    if (!isSuccess && !isFailed) {
      console.log(`⚠️ Unhandled webhook event/status: event=${event} status=${status}`);
      return res.json({ message: 'Webhook received', event, status });
    }

    if (isFailed) {
      console.log('❌ Payment failed, payment_id:', paymentId);
      if (paymentId) delete pendingPaymentMap[paymentId];
      return res.json({ message: 'Payment failed notification received', status: 'failed' });
    }

    // isSuccess — find pending info
    let pendingInfo = paymentId ? pendingPaymentMap[paymentId] : null;

    if (!pendingInfo) {
      console.error('❌ Could not find pending purchase for payment_id:', paymentId);
      return res.status(404).json({ message: 'Pending purchase not found' });
    }

    const { userId, planId, isUpgrade, previousPlan } = pendingInfo;
    const finalAmount = pendingInfo.amount || amount;
    const now         = new Date();

    const { data: userData } = await supabase.from('users').select('email, wallet_balance, total_deposited').eq('id', userId).single();
    if (!userData) return res.status(404).json({ message: 'User not found' });

    console.log(`📦 Activating ${planId} for user ${userData.email} — ${finalAmount} FCFA`);

    const withdrawalDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await updateUser(userId, {
      active_plan:               planId,
      wallet_balance:            (userData.wallet_balance || 0) + finalAmount,
      total_deposited:           (userData.total_deposited || 0) + finalAmount,
      withdrawal_available_at:   withdrawalDate.toISOString(),
      last_transaction_date:     now.toISOString(),
    });

    await logTransaction(userId, isUpgrade ? 'plan_upgrade' : 'plan_purchase', finalAmount,
      `Plan ${planId} activated via AshtechPay — payment_id: ${paymentId}`);
    await applyReferralCommission(userId, finalAmount);

    delete pendingPaymentMap[paymentId];
    console.log(`✅ PLAN ACTIVATED: user=${userData.email} plan=${planId} amount=${finalAmount}`);
    return res.json({ message: 'Payment verified and plan activated', planId, amount: finalAmount, confirmed: true });

  } catch (error) {
    console.error('❌ AshtechPay webhook error:', error.message);
    res.status(500).json({ message: 'Internal server error' });
  }
}

app.post('/api/webhooks/notchpay',   handleAshtechWebhook);
app.post('/api/webhooks/ashtechpay', handleAshtechWebhook);

app.get('/api/webhooks/notchpay/health', (req, res) => {
  res.json({
    status:       ashtechHpKey ? 'ready' : 'not-configured',
    provider:     'AshtechPay',
    hasHpKey:     !!ashtechHpKey,
    hasSecretKey: !!ashtechSecretKey,
    message:      ashtechHpKey ? 'AshtechPay webhook is configured and ready' : 'AshtechPay credentials are missing',
  });
});

/* ===== PAYMENT STATUS ===== */

app.get('/api/payment-status', async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ message: 'Missing ref parameter' });

  // 1. Verify directly with AshtechPay
  if (ashtechSecretKey) {
    try {
      const ashtechRes = await axios.get(`https://ashtechpay.top/api/v1/hosted-payment/${ref}`, {
        headers: { 'Authorization': `Bearer ${ashtechSecretKey}` },
      });
      const payment = ashtechRes.data?.data || ashtechRes.data;
      if (payment?.status) {
        const isCompleted = ['success', 'completed', 'successful', 'paid'].includes(String(payment.status).toLowerCase());
        if (isCompleted) {
          const pending = pendingPaymentMap[ref];
          console.log(`✅ Payment ${ref} verified via AshtechPay API — plan: ${pending?.planId}`);
          return res.json({ status: 'completed', plan: pending?.planId });
        }
        return res.json({ status: 'pending' });
      }
    } catch (err) {
      console.warn('AshtechPay direct verify failed, using local fallback:', err.message);
    }
  }

  // 2. Local fallback
  try {
    const pending = pendingPaymentMap[ref];
    if (pending && supabase) {
      const { data } = await supabase.from('users').select('active_plan').eq('id', pending.userId).single();
      if (data?.active_plan === pending.planId) return res.json({ status: 'completed', plan: data.active_plan });
    }
    if (pending) return res.json({ status: 'pending' });

    // Check transactions in Supabase for this payment
    if (supabase) {
      const { data: txs } = await supabase.from('transactions').select('*').ilike('description', `%${ref}%`).limit(1);
      if (txs && txs.length > 0) return res.json({ status: 'completed' });
    }

    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('Payment status check error:', err);
    res.status(500).json({ message: 'Error checking payment status' });
  }
});

/* ===== NOTIFICATIONS ===== */

app.get('/api/notifications', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Invalid or missing token' });
  res.json({ notifications: user.notifications || [] });
});

/* ===== PRODUCTS ===== */

const PRODUCTS = [
  { id: 1,  name: '📱 Smartphone',         price: 10000,  minVip: null    },
  { id: 2,  name: '🎧 Headphones',          price: 2000,   minVip: null    },
  { id: 3,  name: '💻 Laptop',              price: 25000,  minVip: 'vip2'  },
  { id: 4,  name: '📷 Camera',              price: 15000,  minVip: 'vip2'  },
  { id: 5,  name: '⌚ Smartwatch',           price: 8000,   minVip: 'vip2'  },
  { id: 6,  name: '🎮 Gaming Console',      price: 12000,  minVip: 'vip3'  },
  { id: 7,  name: '📺 Smart TV',            price: 35000,  minVip: 'vip3'  },
  { id: 8,  name: '🎹 Digital Piano',       price: 20000,  minVip: 'vip3'  },
  { id: 9,  name: '🏎️ Premium Electronics', price: 45000,  minVip: 'vip4'  },
  { id: 10, name: '💎 Jewelry',             price: 50000,  minVip: 'vip4'  },
  { id: 11, name: '✈️ Travel Vouchers',     price: 30000,  minVip: 'vip4'  },
  { id: 12, name: '💍 Luxury Items',        price: 100000, minVip: 'vip5'  },
  { id: 13, name: '🛥️ Exclusive Access',    price: 150000, minVip: 'vip5'  },
  { id: 14, name: '🌍 Global Benefits',     price: 200000, minVip: 'vip5'  },
  { id: 15, name: '🏢 Real Estate Access',  price: 300000, minVip: 'vip6'  },
  { id: 16, name: '🎭 Entertainment',       price: 250000, minVip: 'vip6'  },
  { id: 17, name: '🏊 Resort Membership',   price: 350000, minVip: 'vip6'  },
  { id: 18, name: '💼 Business Package',    price: 500000, minVip: 'vip7'  },
  { id: 19, name: '🌟 Platinum Benefits',   price: 600000, minVip: 'vip7'  },
  { id: 20, name: '🎯 Elite Access',        price: 700000, minVip: 'vip7'  },
];

function vipLevel(planId) {
  if (!planId) return 0;
  const n = parseInt(String(planId).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

app.post('/api/products/buy', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  console.log('Received product purchase request', req.body);
  const token = (req.headers.authorization || '').replace('Bearer ', '');

  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Invalid or missing token' });

  const { productId } = req.body;
  if (productId == null) return res.status(400).json({ message: 'Missing productId' });

  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return res.status(404).json({ message: 'Product not found' });

  const activePlan         = user.active_plan;
  const nextPurchaseWindow = user.next_purchase_window_ends;

  if (product.minVip && vipLevel(activePlan) < vipLevel(product.minVip)) {
    return res.status(403).json({ message: `Requires ${product.minVip.toUpperCase()} membership` });
  }

  if (nextPurchaseWindow && new Date(nextPurchaseWindow) > new Date()) {
    const diff = new Date(nextPurchaseWindow).getTime() - Date.now();
    return res.status(429).json({ message: 'Next purchase window not yet open', retryAfterMs: diff, nextPurchaseWindowEnds: nextPurchaseWindow });
  }

  const balance    = user.wallet_balance || 0;
  const finalPrice = product.price;
  if (balance < finalPrice) return res.status(400).json({ message: 'Insufficient balance' });

  const now             = new Date();
  const ownedProducts   = user.owned_products || {};
  ownedProducts[productId] = (ownedProducts[productId] || 0) + 1;
  const nextWindow      = new Date(now.getTime() + 13 * 24 * 60 * 60 * 1000).toISOString();
  const totalPurchases  = (user.total_product_purchases || 0) + 1;

  try {
    await updateUser(user.id, {
      wallet_balance:            balance - finalPrice,
      last_product_purchase:     now.toISOString(),
      next_purchase_window_ends: nextWindow,
      owned_products:            ownedProducts,
      total_product_purchases:   totalPurchases,
    });

    await logTransaction(user.id, 'product_purchase', finalPrice, `Purchased product #${productId} — ${product.name}`);

    return res.json({
      message:               'Product purchased successfully',
      walletBalance:         balance - finalPrice,
      lastProductPurchase:   now.toISOString(),
      nextPurchaseWindowEnds: nextWindow,
      totalProductPurchases: totalPurchases,
    });
  } catch (err) {
    console.error('Product purchase error:', err);
    res.status(500).json({ message: 'Purchase failed' });
  }
});

app.post('/api/products/sell', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  console.log('Received sell request', req.body);
  const token = (req.headers.authorization || '').replace('Bearer ', '');

  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Invalid or missing token' });

  const { productId } = req.body;
  if (productId == null) return res.status(400).json({ message: 'Missing productId' });

  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return res.status(404).json({ message: 'Product not found' });

  const ownedProducts = user.owned_products || {};
  const owned         = ownedProducts[productId] || 0;
  if (owned <= 0) return res.status(400).json({ message: 'You do not own this product' });

  const pendingSells = user.pending_sells || [];
  const alreadyPending = pendingSells.find(ps => ps.productId === productId && ps.status === 'pending');
  if (alreadyPending) return res.status(400).json({ message: 'This product is already queued for sale.', pendingSell: alreadyPending });

  const now    = new Date();
  const sellAt = new Date(now.getTime() + 13 * 24 * 60 * 60 * 1000);
  const pendingSell = {
    id:          `ps_${Date.now()}_${productId}`,
    productId,
    productName:  product.name,
    productPrice: product.price,
    requestedAt:  now.toISOString(),
    sellAt:       sellAt.toISOString(),
    status:       'pending',
  };

  pendingSells.push(pendingSell);
  ownedProducts[productId] = owned - 1;

  try {
    await updateUser(user.id, { owned_products: ownedProducts, pending_sells: pendingSells });
    return res.json({ message: 'Sell order placed. The system will sell your product in 13 days.', pendingSell, sellAt: sellAt.toISOString() });
  } catch (err) {
    console.error('Sell error:', err);
    res.status(500).json({ message: 'Failed to place sell order' });
  }
});

app.get('/api/products/pending-sells', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user  = await getUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });
  const pendingSells = (user.pending_sells || []).filter(ps => ps.status === 'pending');
  return res.json(pendingSells);
});

/* ===== WITHDRAWALS ===== */

app.post('/api/users/request-withdrawal', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user  = await getUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  const { amount, phoneNumber, paymentMethod } = req.body;
  if (!amount || !phoneNumber || !paymentMethod) return res.status(400).json({ message: 'Missing required fields' });

  // Block duplicate pending requests
  const { data: existingPending } = await supabase
    .from('withdrawal_requests')
    .select('id')
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .limit(1);
  if (existingPending && existingPending.length > 0) {
    return res.status(400).json({ message: 'You already have a pending withdrawal request. Please wait for admin review.' });
  }

  // Require at least 3 product purchases
  const totalPurchases = user.total_product_purchases || 0;
  if (totalPurchases < 3) {
    return res.status(403).json({ message: `You need to purchase products at least 3 times before withdrawing. You have made ${totalPurchases} purchase(s) so far.` });
  }

  // Require 30-day lock
  const withdrawalEligibleDate = user.withdrawal_available_at
    ? new Date(user.withdrawal_available_at)
    : new Date((user.created_at ? new Date(user.created_at) : new Date()).getTime() + 30 * 24 * 60 * 60 * 1000);

  if (new Date() < withdrawalEligibleDate) {
    return res.status(403).json({ message: 'You can only withdraw after 30 days', eligibleAt: withdrawalEligibleDate });
  }

  const balance       = user.wallet_balance || 0;
  const maxWithdrawal = Math.floor(balance * 0.5);
  if (amount <= 0 || amount > maxWithdrawal) {
    return res.status(400).json({ message: `You can only withdraw up to 50% of your balance. Maximum: ${maxWithdrawal.toLocaleString()} FCFA` });
  }

  const withdrawalId = `wr_${Date.now()}_${user.id}`;
  try {
    const { error } = await supabase.from('withdrawal_requests').insert([{
      id:             withdrawalId,
      user_id:        user.id,
      username:       user.username,
      email:          user.email,
      amount:         parseInt(amount),
      phone_number:   phoneNumber,
      payment_method: paymentMethod,
      status:         'pending',
    }]);
    if (error) throw error;
    console.log(`Withdrawal request created: ${withdrawalId} for user ${user.email}`);
    return res.json({ message: 'Withdrawal request submitted. Admin will review shortly.', requestId: withdrawalId });
  } catch (err) {
    console.error('Error saving withdrawal:', err);
    res.status(500).json({ message: 'Failed to submit withdrawal request' });
  }
});

app.get('/api/users/my-withdrawals', async (req, res) => {
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user  = await getUserByToken(token);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const { data, error } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    console.error('Error fetching user withdrawals:', err);
    res.status(500).json({ message: 'Error fetching withdrawals' });
  }
});

/* ===== ADMIN ===== */

function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token !== adminToken) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });

  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, username, phone_number, active_plan, next_purchase_window_ends, withdrawal_available_at, created_at, wallet_balance, total_profits, total_deposited, is_active');
    if (error) throw error;
    const usersData = (data || []).map(u => ({
      id:                      u.id,
      email:                   u.email,
      username:                u.username,
      phoneNumber:             u.phone_number,
      activePlan:              u.active_plan,
      nextPurchaseWindowEnds:  u.next_purchase_window_ends,
      withdrawalAvailableAt:   u.withdrawal_available_at,
      createdAt:               u.created_at,
      walletBalance:           u.wallet_balance,
      totalProfits:            u.total_profits,
      totalDeposited:          u.total_deposited,
      isActive:                u.is_active,
    }));
    return res.json(usersData);
  } catch (err) {
    console.error('❌ Error fetching admin users:', err);
    res.status(500).json({ message: 'Failed to fetch users', error: err.message });
  }
});

app.get('/api/admin/pending-withdrawals', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });

  try {
    const { data, error } = await supabase.from('withdrawal_requests').select('*').eq('status', 'pending');
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    console.error('Error fetching pending withdrawals:', err);
    res.status(500).json({ message: 'Failed to fetch withdrawals' });
  }
});

app.post('/api/admin/modify-withdrawal', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });

  const { requestId, amount, phoneNumber, paymentMethod, adminNote } = req.body;
  if (!requestId) return res.status(400).json({ message: 'requestId is required' });

  try {
    const { data: existing, error: fError } = await supabase
      .from('withdrawal_requests').select('*').eq('id', requestId).single();
    if (fError || !existing) return res.status(404).json({ message: 'Withdrawal request not found' });
    if (existing.status !== 'pending') return res.status(400).json({ message: 'Can only modify pending withdrawals' });

    const updates = { admin_modified: true };
    if (amount !== undefined && amount !== '')           updates.amount         = parseInt(amount);
    if (phoneNumber !== undefined && phoneNumber !== '') updates.phone_number   = phoneNumber;
    if (paymentMethod !== undefined && paymentMethod !== '') updates.payment_method = paymentMethod;
    if (adminNote !== undefined)                        updates.admin_note     = adminNote;
    if (!existing.original_amount)                      updates.original_amount       = existing.amount;
    if (!existing.original_phone_number)                updates.original_phone_number = existing.phone_number;

    const { data: updated, error: uError } = await supabase
      .from('withdrawal_requests').update(updates).eq('id', requestId).select().single();
    if (uError) throw uError;

    return res.json({ message: 'Withdrawal updated', withdrawal: updated });
  } catch (err) {
    console.error('Error modifying withdrawal:', err);
    res.status(500).json({ message: 'Failed to modify withdrawal' });
  }
});

app.post('/api/admin/approve-withdrawal', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });

  const { requestId } = req.body;
  try {
    const { data: withdrawal, error: wError } = await supabase
      .from('withdrawal_requests').select('*').eq('id', requestId).single();
    if (wError || !withdrawal) return res.status(404).json({ message: 'Withdrawal request not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ message: 'Withdrawal already processed' });

    // Deduct from user wallet
    const userId = withdrawal.user_id;
    const { data: userData } = await supabase.from('users').select('wallet_balance').eq('id', userId).single();
    if (userData) {
      await supabase.from('users').update({ wallet_balance: (userData.wallet_balance || 0) - withdrawal.amount }).eq('id', userId);
    }

    const { data: updated, error: uError } = await supabase
      .from('withdrawal_requests')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', requestId).select().single();
    if (uError) throw uError;

    console.log(`Withdrawal approved: ${requestId}`);
    return res.json({ message: 'Withdrawal approved successfully', withdrawal: updated });
  } catch (err) {
    console.error('Error approving withdrawal:', err);
    res.status(500).json({ message: 'Failed to approve withdrawal' });
  }
});

app.post('/api/admin/reject-withdrawal', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });

  const { requestId, reason } = req.body;
  try {
    const { data: withdrawal, error: wError } = await supabase
      .from('withdrawal_requests').select('*').eq('id', requestId).single();
    if (wError || !withdrawal) return res.status(404).json({ message: 'Withdrawal request not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ message: 'Withdrawal already processed' });

    const { data: updated, error: uError } = await supabase
      .from('withdrawal_requests')
      .update({ status: 'rejected', rejected_at: new Date().toISOString(), rejection_reason: reason || 'No reason provided' })
      .eq('id', requestId).select().single();
    if (uError) throw uError;

    console.log(`Withdrawal rejected: ${requestId}`);
    return res.json({ message: 'Withdrawal rejected', withdrawal: updated });
  } catch (err) {
    console.error('Error rejecting withdrawal:', err);
    res.status(500).json({ message: 'Failed to reject withdrawal' });
  }
});

app.post('/api/admin/block-user', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!supabase) return res.status(503).json({ message: 'Database not configured' });

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

/* ===== BACKGROUND JOBS ===== */

// Notify users when withdrawal becomes available (every minute)
setInterval(async () => {
  if (!supabase) return;
  const now = new Date();
  try {
    const { data: usersToNotify } = await supabase
      .from('users')
      .select('id, email, notifications, withdrawal_available_at')
      .eq('notified_withdrawal', false)
      .not('withdrawal_available_at', 'is', null)
      .lte('withdrawal_available_at', now.toISOString());

    if (!usersToNotify || usersToNotify.length === 0) return;

    for (const u of usersToNotify) {
      const notifications = u.notifications || [];
      notifications.push({
        id:      crypto.randomBytes(8).toString('hex'),
        type:    'withdrawal_available',
        message: 'Your withdrawal is now available.',
        at:      now.toISOString(),
      });
      await supabase.from('users').update({ notifications, notified_withdrawal: true }).eq('id', u.id);
      console.log(`Notify user ${u.email}: withdrawal available`);
    }
  } catch (err) {
    console.error('Withdrawal notification job error:', err.message);
  }
}, 60 * 1000);

// Daily referral earnings (every 24 hours)
setInterval(async () => {
  if (!supabase) return;
  const now = new Date();
  try {
    const { data: usersWithReferrals } = await supabase
      .from('users')
      .select('id, email, wallet_balance, total_profits, referral_count, last_earnings_credit')
      .gt('referral_count', 0);

    if (!usersWithReferrals || usersWithReferrals.length === 0) return;

    for (const u of usersWithReferrals) {
      const tier              = getCommissionTier(u.referral_count || 0);
      const lastCredit        = u.last_earnings_credit ? new Date(u.last_earnings_credit) : null;
      const daysPassed        = lastCredit ? Math.floor((now - lastCredit) / (1000 * 60 * 60 * 24)) : 1;
      if (daysPassed < 1 || tier.daily <= 0) continue;

      const earningsAmount = Math.floor(tier.daily * daysPassed);
      await supabase.from('users').update({
        wallet_balance:       (u.wallet_balance || 0) + earningsAmount,
        total_profits:        (u.total_profits || 0) + earningsAmount,
        last_earnings_credit: now.toISOString(),
      }).eq('id', u.id);
      await logTransaction(u.id, 'referral_daily_earnings', earningsAmount, `Daily referral earnings (${u.referral_count} referrals)`);
      console.log(`Credited ${earningsAmount} FCFA daily earnings to user ${u.email}`);
    }
  } catch (err) {
    console.error('Daily earnings job error:', err.message);
  }
}, 24 * 60 * 60 * 1000);

// Execute pending sell orders after 13-day countdown (every hour)
setInterval(async () => {
  if (!supabase) return;
  const now = new Date();
  try {
    const { data: usersWithSells } = await supabase
      .from('users')
      .select('id, email, wallet_balance, total_profits, active_plan, pending_sells')
      .not('pending_sells', 'eq', '[]')
      .not('pending_sells', 'is', null);

    if (!usersWithSells || usersWithSells.length === 0) return;

    for (const u of usersWithSells) {
      const pendingSells = u.pending_sells || [];
      const dueSells     = pendingSells.filter(ps => ps.status === 'pending' && new Date(ps.sellAt) <= now);
      if (dueSells.length === 0) continue;

      let walletBalance = u.wallet_balance || 0;
      let totalProfits  = u.total_profits  || 0;

      for (const ps of dueSells) {
        const product       = PRODUCTS.find(p => p.id === ps.productId);
        const price         = (product ? product.price : null) || ps.productPrice;
        const profitAmount  = Math.floor(price / 3);
        const saleAmount    = price + profitAmount;

        walletBalance += saleAmount;
        totalProfits  += profitAmount;

        ps.status      = 'completed';
        ps.completedAt = now.toISOString();
        ps.saleAmount  = saleAmount;
        ps.profitEarned = profitAmount;

        await logTransaction(u.id, 'product_sell', saleAmount,
          `System sold ${ps.productName} — profit: ${profitAmount.toLocaleString()} FCFA`);

        console.log(`System sold ${ps.productName} for ${u.email} — ${saleAmount} FCFA (profit: ${profitAmount} FCFA)`);
      }

      // Build updated notifications array
      const { data: freshUser } = await supabase.from('users').select('notifications').eq('id', u.id).single();
      const notifications = freshUser?.notifications || [];
      for (const ps of dueSells) {
        notifications.push({
          id:      crypto.randomBytes(8).toString('hex'),
          type:    'sell_complete',
          message: `✅ Your ${ps.productName} was sold! ${ps.saleAmount.toLocaleString()} FCFA credited (profit: ${ps.profitEarned.toLocaleString()} FCFA).`,
          at:      now.toISOString(),
        });
      }

      await supabase.from('users').update({
        wallet_balance: walletBalance,
        total_profits:  totalProfits,
        pending_sells:  pendingSells,
        notifications,
      }).eq('id', u.id);
    }
  } catch (err) {
    console.error('Sell job error:', err.message);
  }
}, 60 * 60 * 1000);

/* ===== START ===== */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
