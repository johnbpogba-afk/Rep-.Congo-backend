const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = 3000;

// ─── HARDCODED CONFIG (remove after testing) ───────────────────────────────
const OPENPAY_API_KEY = "sk_28d982491abf033c5f4e02fdda278273956a7d8f5587b8388f48ed5b0c340619";
const OPENPAY_BASE_URL = "https://api.openpay-cg.com/v1";

// STK polling config
const POLL_INTERVAL_MS = 5000;   // check every 5 seconds
const POLL_TIMEOUT_MS  = 120000; // wait up to 2 minutes for PIN entry

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors()); // allow any frontend origin
app.use(express.json());

// ─── HELPERS ───────────────────────────────────────────────────────────────

function generateReceiptNumber() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `RCP-${ts}-${rand}`;
}

function buildReceipt({ status, reference, amount, currency, phone, provider, message, metadata }) {
  return {
    receipt_number: generateReceiptNumber(),
    status,          // "success" | "failed" | "timeout" | "cancelled"
    reference:  reference  || null,
    amount:     amount     || null,
    currency:   currency   || "XAF",
    phone:      phone      || null,
    provider:   provider   || null,
    message,
    metadata:   metadata   || null,
    generated_at: new Date().toISOString(),
  };
}

// Poll OPENPAY until terminal status or timeout
async function pollStatus(reference, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const response = await axios.get(
      `${OPENPAY_BASE_URL}/transaction/status/${reference}`,
      {
        headers: {
          "XO-API-KEY": OPENPAY_API_KEY,
          Accept: "application/json",
        },
        timeout: 15000,
      }
    );

    const tx = response.data;
    const s  = (tx.status || "").toLowerCase();

    if (s === "success" || s === "failed" || s === "cancelled") {
      return tx;
    }
    // "pending" → keep polling
  }

  return null; // timed out
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "OPENPAY STK Backend", time: new Date().toISOString() });
});

// ── 1. Initiate STK Push payment ──────────────────────────────────────────
// POST /api/pay
// Body: { amount, payment_phone_number, provider, customer_external_id?, customer?, metadata? }
app.post("/api/pay", async (req, res) => {
  const { amount, payment_phone_number, provider, customer_external_id, customer, metadata } = req.body;

  // Basic validation
  if (!amount || !payment_phone_number || !provider) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: amount, payment_phone_number, provider",
    });
  }

  // ── Step 1: Initiate payment on OPENPAY ──
  let initData;
  try {
    const payload = {
      amount,
      payment_phone_number,
      provider: provider.toUpperCase(),
      customer_external_id: customer_external_id || `cust_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    };
    if (customer) payload.customer = customer;
    if (metadata) payload.metadata = metadata;

    const initResponse = await axios.post(
      `${OPENPAY_BASE_URL}/transaction/payment`,
      payload,
      {
        headers: {
          "XO-API-KEY":    OPENPAY_API_KEY,
          "Content-Type":  "application/json",
          Accept:          "application/json",
        },
        timeout: 30000,
      }
    );
    initData = initResponse.data;
  } catch (err) {
    // Forward exact OPENPAY error to frontend
    if (err.response) {
      return res.status(err.response.status).json({
        status: "failed",
        message: err.response.data?.error || err.response.data?.message || "OPENPAY rejected the request.",
        openpay_error: err.response.data,
        http_status: err.response.status,
      });
    }
    return res.status(502).json({
      status: "failed",
      message: "Could not reach OPENPAY API. Check your network or API key.",
      error: err.message,
    });
  }

  const reference = initData.reference;

  // If OPENPAY already returned a terminal status (rare but possible)
  const immediateStatus = (initData.status || "").toLowerCase();
  if (immediateStatus === "success") {
    return res.json(buildReceipt({
      status:    "success",
      reference,
      amount:    initData.amount,
      currency:  initData.currency,
      phone:     initData.paymentPhoneNumber,
      provider:  initData.provider,
      message:   initData.message || "Payment successful.",
      metadata:  initData.metadata,
    }));
  }
  if (immediateStatus === "failed" || immediateStatus === "cancelled") {
    return res.json(buildReceipt({
      status:    immediateStatus,
      reference,
      amount:    initData.amount,
      currency:  initData.currency,
      phone:     initData.paymentPhoneNumber,
      provider:  initData.provider,
      message:   initData.message || "Payment was not completed.",
      metadata:  initData.metadata,
    }));
  }

  // ── Step 2: STK prompt sent — poll for confirmation ──
  // (user is now seeing the PIN prompt on their phone)
  let finalTx;
  try {
    finalTx = await pollStatus(reference, POLL_TIMEOUT_MS);
  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json({
        status: "failed",
        message: err.response.data?.error || err.response.data?.message || "Error checking payment status.",
        openpay_error: err.response.data,
        reference,
      });
    }
    return res.status(502).json({
      status: "failed",
      message: "Network error while checking payment status.",
      error:   err.message,
      reference,
    });
  }

  // ── Step 3: Return receipt ──
  if (!finalTx) {
    // Timed out — user did not confirm within 2 minutes
    return res.json(buildReceipt({
      status:   "timeout",
      reference,
      amount:   initData.amount,
      currency: initData.currency,
      phone:    payment_phone_number,
      provider: provider.toUpperCase(),
      message:  "Payment timed out. The STK prompt was sent but no response was received within 2 minutes. Please try again.",
      metadata: initData.metadata,
    }));
  }

  const finalStatus = (finalTx.status || "").toLowerCase();

  if (finalStatus === "success") {
    return res.json(buildReceipt({
      status:   "success",
      reference,
      amount:   finalTx.amount,
      currency: finalTx.currency,
      phone:    finalTx.paymentPhoneNumber,
      provider: finalTx.provider,
      message:  finalTx.message || "Payment successful.",
      metadata: finalTx.metadata,
    }));
  }

  return res.json(buildReceipt({
    status:   finalStatus === "cancelled" ? "cancelled" : "failed",
    reference,
    amount:   finalTx.amount,
    currency: finalTx.currency,
    phone:    finalTx.paymentPhoneNumber,
    provider: finalTx.provider,
    message:  finalTx.message || "Payment was not completed.",
    metadata: finalTx.metadata,
  }));
});

// ── 2. OPENPAY Webhook / Callback ─────────────────────────────────────────
// OPENPAY posts here when a transaction status changes.
// Set this URL in your OPENPAY dashboard → Callback URL tab:
//   https://YOUR-APP.onrender.com/api/callback
app.post("/api/callback", (req, res) => {
  const data = req.body;
  console.log("[OPENPAY CALLBACK]", JSON.stringify(data, null, 2));

  // TODO: use data.reference and data.status to update your DB / notify users
  // Always return 200 so OPENPAY does not retry
  res.status(200).json({ success: true });
});

// ── 3. Check transaction status manually ─────────────────────────────────
// GET /api/status/:reference
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
    return res.json(response.data);
  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json({
        error:        err.response.data?.error || "Failed to fetch status.",
        openpay_error: err.response.data,
        http_status:  err.response.status,
      });
    }
    return res.status(502).json({
      error: "Network error while fetching status.",
      detail: err.message,
    });
  }
});

// ─── START ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`OPENPAY STK backend running on port ${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  POST /api/pay            → initiate STK push`);
  console.log(`  POST /api/callback       → OPENPAY webhook (set this in dashboard)`);
  console.log(`  GET  /api/status/:ref    → check a transaction`);
});
