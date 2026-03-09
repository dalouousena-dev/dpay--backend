const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const axios = require("axios");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const app = express();

/* ===== PORT FOR RENDER ===== */
const PORT = process.env.PORT || 5000;

/* ===== TRUST PROXY (RENDER) ===== */
app.set("trust proxy", 1);

/* ===== MIDDLEWARE ===== */
app.use(express.json());

app.use(
  cors({
    origin: [
      "https://computerarchi.com",
      "https://www.computerarchi.com",
      "http://localhost:5173"
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

/* ===== SUPABASE ===== */

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log("✅ Supabase connected");
} else {
  console.log("⚠️ Supabase credentials missing");
}

/* ===== NOTCHPAY ===== */

const notchpaySecret = process.env.Privatekey;
const notchpayPublic = process.env.Publickey;
const notchpayPublic = process.env.Hashkey;

if (notchpaySecret && notchpayPublic) {
  console.log("✅ NotchPay initialized");
} else {
  console.log("⚠️ NotchPay disabled");
}

/* ===== HELPERS ===== */

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* ===== AUTH REGISTER ===== */

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, username } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const { data: existing } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (existing) {
      return res.status(409).json({ message: "User already exists" });
    }

    const token = makeToken();

    const { data, error } = await supabase
      .from("users")
      .insert([
        {
          email,
          password,
          username,
          token,
          wallet_balance: 0
        }
      ])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      message: "User created",
      token
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Registration failed"
    });
  }
});

/* ===== LOGIN ===== */

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (!user || user.password !== password) {
      return res.status(401).json({
        message: "Invalid credentials"
      });
    }

    let token = user.token;

    if (!token) {
      token = makeToken();

      await supabase
        .from("users")
        .update({ token })
        .eq("id", user.id);
    }

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Login failed"
    });
  }
});

/* ===== AUTH MIDDLEWARE ===== */

async function auth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        message: "Missing token"
      });
    }

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("token", token)
      .single();

    if (!user) {
      return res.status(401).json({
        message: "Invalid token"
      });
    }

    req.user = user;

    next();
  } catch (err) {
    res.status(401).json({
      message: "Unauthorized"
    });
  }
}

/* ===== USER PROFILE ===== */

app.get("/api/users/profile", auth, async (req, res) => {
  try {
    const { password, ...user } = req.user;

    res.json(user);
  } catch (err) {
    res.status(500).json({
      message: "Error fetching profile"
    });
  }
});

/* ===== PLAN PURCHASE ===== */

app.post("/api/plans/purchase", auth, async (req, res) => {
  try {
    const { planId, amount } = req.body;

    if (!planId || !amount) {
      return res.status(400).json({
        message: "Missing plan data"
      });
    }

    const user = req.user;

    const newBalance = (user.wallet_balance || 0) + amount;

    await supabase
      .from("users")
      .update({
        wallet_balance: newBalance,
        active_plan: planId
      })
      .eq("id", user.id);

    res.json({
      message: "Plan activated",
      walletBalance: newBalance
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Plan purchase failed"
    });
  }
});

/* ===== NOTCHPAY WEBHOOK ===== */

app.post("/api/webhooks/notchpay", async (req, res) => {
  console.log("Webhook received");

  const event = req.body.event;

  if (event === "payment.success") {
    console.log("Payment success");
  }

  res.json({ received: true });
});

/* ===== HEALTH CHECK ===== */

app.get("/", (req, res) => {
  res.json({
    status: "DPAY backend running",
    time: new Date()
  });
});

/* ===== START SERVER ===== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

