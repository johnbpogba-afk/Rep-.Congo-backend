const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const app  = express();
const PORT = 3000;

// ─── HARDCODED CONFIG (remove after testing) ────────────────────────────────
const WONYA_TOKEN      = "wpa_3g3b5okhc3oupnzo4tbf15jfsgs5serf8splp08qa8c95e7k57x";
const WONYA_PARTNER_ID = "333508045051";   // RefPartenaire (Swiftco, Goma)
const WONYA_BASE_URL   = "https://app-api.wonyasoft.com";
const CALLBACK_URL     = "https://rep-congo-backend.onrender.com/api/callback";

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── HELPERS ────────────────────────────────────────────────────────────────

// Generate a unique 20-char alphanumeric RefTransa
function generateRefTransa() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let ref = "";
  for (let i = 0; i < 20; i++) {
    ref += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return ref;
}

function generateReceiptNumber() {
  return `RCP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
}

function buildReceipt({ status, refTransa, transactionId, amount, currency, phone, network, message, commission }) {
  return {
    receipt_number: generateReceiptNumber(),
    status,
    refTransa:      refTransa     || null,
    transactionId:  transactionId || null,
    amount:         amount        || null,
    currency:       currency      || null,
    phone:          phone         || null,
    network:        network       || null,
    commission:     commission    || null,
    message:        message       || null,
    generated_at:   new Date().toISOString(),
  };
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "WonyaPay STK Backend", time: new Date().toISOString() });
});

// ── 1. Initiate C2B (STK Push) — returns immediately with RefTransa ─────────
// POST /api/pay
// Body: { amount, phone, currency }   currency = "CDF" | "USD"
app.post("/api/pay", async (req, res) => {
  const { amount, phone, currency = "CDF", motif = "Paiement" } = req.body;

  if (!amount || !phone) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: amount, phone",
    });
  }

  const refTransa = generateRefTransa();

  const payload = {
    RefPartenaire: WONYA_PARTNER_ID,
    RefTransa:     refTransa,
    Montant:       Number(amount),
    Devise:        currency.toUpperCase(),
    Action:        "C2B",
    MobileMoney:   phone.replace(/\D/g, ""),  // strip non-digits
    Motif:         motif,
    CallbackUrl:   CALLBACK_URL,
  };

  try {
    const response = await axios.post(
      `${WONYA_BASE_URL}/payment`,
      payload,
      {
        headers: {
          "Authorization": `Bearer ${WONYA_TOKEN}`,
          "Content-Type":  "application/json",
        },
        timeout: 30000,
      }
    );

    const data = response.data;

    // Check if immediately terminal (rare)
    const statusWonya = (data?.data?.StatutWonya || data?.data?.status || "").toLowerCase();

    if (statusWonya === "succes" || statusWonya === "success" || statusWonya === "completed") {
      return res.json({
        status:        "success",
        refTransa,
        transactionId: data?.data?.transactionId || null,
        amount:        data?.data?.Montant || amount,
        currency:      data?.data?.Devise  || currency,
        phone,
        network:       data?.data?.network || null,
        commission:    data?.data?.commission || null,
        message:       data?.message || "Payment successful.",
      });
    }

    if (statusWonya === "echec" || statusWonya === "failed") {
      return res.json({
        status:  "failed",
        refTransa,
        message: data?.message || "Payment failed.",
      });
    }

    // Pending — STK push sent, return refTransa so frontend can poll
    return res.json({
      status:        "pending",
      refTransa,
      transactionId: data?.data?.transactionId || null,
      amount:        data?.data?.Montant || amount,
      currency:      data?.data?.Devise  || currency,
      phone,
      network:       data?.data?.network || null,
      message:       data?.message || "STK push sent. Please check your phone and enter your PIN.",
    });

  } catch (err) {
    if (err.response) {
      const d = err.response.data;
      return res.status(err.response.status).json({
        status:  "failed",
        message: d?.message || d?.error || "WonyaPay rejected the request.",
        detail:  d,
        code:    err.response.status,
      });
    }
    return res.status(502).json({
      status:  "failed",
      message: "Could not reach WonyaPay API. Check your network.",
      error:   err.message,
    });
  }
});

// ── 2. Poll transaction status (called by frontend) ──────────────────────────
// GET /api/status/:refTransa
app.get("/api/status/:refTransa", async (req, res) => {
  const { refTransa } = req.params;

  try {
    const response = await axios.get(
      `${WONYA_BASE_URL}/transaction-status/status/${refTransa}`,
      {
        headers: {
          "Authorization": `Bearer ${WONYA_TOKEN}`,
        },
        timeout: 15000,
      }
    );

    const data = response.data;
    const tx   = data?.data || {};

    // WonyaPay terminal statuses
    const rawStatus = (tx.status || tx.StatutWonya || tx.statutTransa || "").toLowerCase();
    const isSuccess  = rawStatus === "completed" || rawStatus === "succes" || rawStatus === "success";
    const isFailed   = rawStatus === "failed"    || rawStatus === "echec"  || rawStatus === "failure";

    if (isSuccess) {
      return res.json(buildReceipt({
        status:        "success",
        refTransa:     tx.refTransa   || refTransa,
        transactionId: tx.transactionId,
        amount:        tx.amount      || tx.Montant,
        currency:      tx.Devise      || tx.currency,
        phone:         tx.MobileMoney || tx.phone,
        network:       tx.network,
        message:       "Payment successful.",
        commission:    tx.commission,
      }));
    }

    if (isFailed) {
      return res.json(buildReceipt({
        status:        "failed",
        refTransa:     tx.refTransa || refTransa,
        transactionId: tx.transactionId,
        amount:        tx.amount    || tx.Montant,
        currency:      tx.Devise    || tx.currency,
        phone:         tx.MobileMoney,
        network:       tx.network,
        message:       tx.message || "Payment failed.",
        commission:    null,
      }));
    }

    // Still pending
    return res.json({ status: "pending", refTransa });

  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json({
        status:  "error",
        message: err.response.data?.message || "Error checking status.",
        detail:  err.response.data,
      });
    }
    return res.status(502).json({
      status:  "error",
      message: "Network error while checking status.",
      detail:  err.message,
    });
  }
});

// ── 3. Callback endpoint (WonyaPay posts here on status change) ──────────────
// Set CallbackUrl = https://rep-congo-backend.onrender.com/api/callback
app.post("/api/callback", (req, res) => {
  const data = req.body;
  console.log("[WONYAPAY CALLBACK]", JSON.stringify(data, null, 2));
  // data.StatutWonya: "Succes" (C2B success), "Recu" (B2C success), "Echec" (failure)
  // data.RefTransa: the transaction reference
  res.status(200).json({ received: true });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`WonyaPay STK backend running on port ${PORT}`);
  console.log(`  POST /api/pay            → initiate C2B STK push`);
  console.log(`  GET  /api/status/:ref    → check status (frontend polls)`);
  console.log(`  POST /api/callback       → WonyaPay webhook`);
});
