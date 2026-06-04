const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = 3000;

// ─── HARDCODED CONFIG (remove after testing) ───────────────────────────────
const OPENPAY_API_KEY = "sk_28d982491abf033c5f4e02fdda278273956a7d8f5587b8388f48ed5b0c340619";
const OPENPAY_BASE_URL = "https://api.openpay-cg.com/v1";

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── HELPERS ────────────────────────────────────────────────────────────────
function generateReceiptNumber() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `RCP-${ts}-${rand}`;
}

function buildReceipt({ status, reference, amount, currency, phone, provider, message, metadata }) {
  return {
    receipt_number: generateReceiptNumber(),
    status,
    reference:   reference  || null,
    amount:      amount     || null,
    currency:    currency   || "XAF",
    phone:       phone      || null,
    provider:    provider   || null,
    message:     message    || null,
    metadata:    metadata   || null,
    generated_at: new Date().toISOString(),
  };
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "OPENPAY STK Backend", time: new Date().toISOString() });
});

// ── 1. Initiate STK Push — returns IMMEDIATELY after sending the push ───────
// POST /api/pay
// Body: { amount, payment_phone_number, provider }
// Returns: { status:"pending", reference, message } — frontend then polls /api/status/:reference
app.post("/api/pay", async (req, res) => {
  const { amount, payment_phone_number, provider, customer_external_id, customer, metadata } = req.body;

  if (!amount || !payment_phone_number || !provider) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: amount, payment_phone_number, provider",
    });
  }

  try {
    const payload = {
      amount,
      payment_phone_number,
      provider: provider.toUpperCase(),
      customer_external_id: customer_external_id
        || `cust_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    };
    if (customer) payload.customer = customer;
    if (metadata) payload.metadata = metadata;

    const initResponse = await axios.post(
      `${OPENPAY_BASE_URL}/transaction/payment`,
      payload,
      {
        headers: {
          "XO-API-KEY":   OPENPAY_API_KEY,
          "Content-Type": "application/json",
          Accept:         "application/json",
        },
        timeout: 30000,
      }
    );

    const data   = initResponse.data;
    const status = (data.status || "").toLowerCase();

    // STK was sent — return reference immediately so frontend can poll
    // Handles: pending, on_hold, on hold, processing (all mean "waiting for PIN")
    return res.json({
      status:    status === "success" ? "success" : status === "failed" || status === "cancelled" ? status : "pending",
      reference: data.reference,
      amount:    data.amount,
      currency:  data.currency,
      phone:     data.paymentPhoneNumber || payment_phone_number,
      provider:  data.provider           || provider.toUpperCase(),
      message:   status === "success"
        ? (data.message || "Payment successful.")
        : "STK push sent. Waiting for PIN confirmation.",
      metadata:  data.metadata || null,
    });

  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json({
        status:        "failed",
        message:       err.response.data?.error || err.response.data?.message || "OPENPAY rejected the request.",
        openpay_error: err.response.data,
      });
    }
    return res.status(502).json({
      status:  "failed",
      message: "Could not reach OPENPAY API. Check network or API key.",
      error:   err.message,
    });
  }
});

// ── 2. Check transaction status (called by frontend polling) ─────────────────
// GET /api/status/:reference
// Returns a receipt object when terminal, or { status:"pending" } while waiting
app.get("/api/status/:reference", async (req, res) => {
  const { reference } = req.params;

  try {
    const response = await axios.get(
      `${OPENPAY_BASE_URL}/transaction/status/${reference}`,
      {
        headers: {
          "XO-API-KEY": OPENPAY_API_KEY,
          Accept:       "application/json",
        },
        timeout: 15000,
      }
    );

    const tx = response.data;
    const s  = (tx.status || "").toLowerCase();

    // Terminal states → return full receipt
    if (s === "success") {
      return res.json(buildReceipt({
        status:   "success",
        reference: tx.reference,
        amount:    tx.amount,
        currency:  tx.currency,
        phone:     tx.paymentPhoneNumber,
        provider:  tx.provider,
        message:   tx.message || "Payment successful.",
        metadata:  tx.metadata,
      }));
    }
    if (s === "failed" || s === "cancelled") {
      return res.json(buildReceipt({
        status:   s,
        reference: tx.reference,
        amount:    tx.amount,
        currency:  tx.currency,
        phone:     tx.paymentPhoneNumber,
        provider:  tx.provider,
        message:   tx.message || "Payment was not completed.",
        metadata:  tx.metadata,
      }));
    }

    // Still pending / on_hold / on hold — tell frontend to keep polling
    return res.json({ status: "pending", reference });

  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json({
        status:        "failed",
        message:       err.response.data?.error || "Failed to fetch status.",
        openpay_error: err.response.data,
      });
    }
    return res.status(502).json({
      status:  "error",
      message: "Network error while checking status.",
      detail:  err.message,
    });
  }
});

// ── 3. OPENPAY Webhook / Callback ────────────────────────────────────────────
// Set in OPENPAY dashboard → Callback URL:
//   https://rep-congo-backend.onrender.com/api/callback
app.post("/api/callback", (req, res) => {
  const data = req.body;
  console.log("[OPENPAY CALLBACK]", JSON.stringify(data, null, 2));
  res.status(200).json({ success: true });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`OPENPAY STK backend running on port ${PORT}`);
  console.log(`  POST /api/pay            → initiate STK push (returns immediately)`);
  console.log(`  GET  /api/status/:ref    → check status (frontend polls this)`);
  console.log(`  POST /api/callback       → OPENPAY webhook`);
});
