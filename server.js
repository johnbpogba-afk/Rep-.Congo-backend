require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const PDFDocument = require("pdfkit");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

const OPENPAY_BASE = "https://api.openpay-cg.com/v1";
const OPENPAY_API_KEY = process.env.OPENPAY_API_KEY;

app.use(cors());
app.use(express.json());

/* ──────────────────────────────────────────────────────────────
   HELPER: build axios headers for every OpenPay request
────────────────────────────────────────────────────────────── */
function openpayHeaders() {
  if (!OPENPAY_API_KEY) {
    throw new Error(
      "OPENPAY_API_KEY is not set. Add it to your .env file before starting the server."
    );
  }
  return {
    "XO-API-KEY": OPENPAY_API_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/* ──────────────────────────────────────────────────────────────
   HELPER: extract the real OpenPay error message (never hide it)
────────────────────────────────────────────────────────────── */
function extractOpenpayError(err) {
  if (err.response) {
    const status = err.response.status;
    const body = err.response.data;
    const message =
      (body && (body.error || body.message || body.detail)) ||
      JSON.stringify(body) ||
      err.message;
    return { status, message, raw: body };
  }
  return { status: 500, message: err.message, raw: null };
}

/* ──────────────────────────────────────────────────────────────
   HELPER: validate Congolese phone number (242XXXXXXXXX, 12 digits)
────────────────────────────────────────────────────────────── */
function validatePhone(phone) {
  if (!phone) return "phone number is required.";
  const clean = String(phone).replace(/\s+/g, "");
  if (!/^242\d{9}$/.test(clean))
    return `Invalid phone number "${phone}". Must start with 242 followed by 9 digits (total 12 digits). Example: 242066203420`;
  return null;
}

/* ──────────────────────────────────────────────────────────────
   HELPER: validate amount (must be a positive integer in XAF)
────────────────────────────────────────────────────────────── */
function validateAmount(amount) {
  const n = Number(amount);
  if (isNaN(n) || n <= 0 || !Number.isInteger(n))
    return `Invalid amount "${amount}". Must be a positive whole number (XAF has no decimals). Example: 5000`;
  return null;
}

/* ──────────────────────────────────────────────────────────────
   HELPER: validate provider
────────────────────────────────────────────────────────────── */
function validateProvider(provider) {
  const valid = ["MTN", "AIRTEL"];
  if (!provider) return "provider is required. Use MTN or AIRTEL.";
  if (!valid.includes(String(provider).toUpperCase()))
    return `Invalid provider "${provider}". Allowed values: MTN, AIRTEL.`;
  return null;
}

/* ──────────────────────────────────────────────────────────────
   HELPER: generate a PDF receipt and stream it to the response
   type: "success" | "failed"
   data: OpenPay transaction/status object
────────────────────────────────────────────────────────────── */
function generateReceiptPDF(res, type, data, note) {
  const doc = new PDFDocument({ margin: 50, size: "A5" });

  const filename =
    type === "success"
      ? `receipt-success-${data.reference || "unknown"}.pdf`
      : `receipt-failed-${Date.now()}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  doc.pipe(res);

  const green = "#1a7a3a";
  const red = "#b71c1c";
  const dark = "#1a1a1a";
  const grey = "#555555";
  const accent = type === "success" ? green : red;
  const statusLabel = type === "success" ? "PAYMENT SUCCESSFUL" : "PAYMENT FAILED";

  doc.rect(0, 0, doc.page.width, 80).fill(accent);

  doc.fontSize(22).fillColor("#ffffff").font("Helvetica-Bold")
    .text("OpenPay Congo", 50, 22);
  doc.fontSize(10).fillColor("#dddddd").font("Helvetica")
    .text("Mobile Money Payment Receipt", 50, 50);

  doc.moveDown(3);

  doc.fontSize(16).fillColor(accent).font("Helvetica-Bold")
    .text(statusLabel, { align: "center" });

  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y)
    .strokeColor("#cccccc").lineWidth(1).stroke();
  doc.moveDown(0.5);

  const row = (label, value, highlight = false) => {
    doc.fontSize(10).fillColor(grey).font("Helvetica").text(label, 50, doc.y, {
      continued: false,
    });
    doc.fontSize(11)
      .fillColor(highlight ? accent : dark)
      .font("Helvetica-Bold")
      .text(String(value || "—"), 50, doc.y - 2, { align: "right" });
    doc.moveDown(0.4);
  };

  row("Reference", data.reference);
  row(
    "Amount",
    data.amount
      ? `${Number(data.amount).toLocaleString("fr-CG")} ${data.currency || "XAF"}`
      : "—",
    true
  );
  row("Phone", data.paymentPhoneNumber);
  row("Provider", data.provider);
  row("Status", (data.status || "").toUpperCase(), true);
  row("Message", data.message);
  if (data.createdAt) {
    row("Date", new Date(data.createdAt).toLocaleString("fr-CG"));
  } else {
    row("Date", new Date().toLocaleString("fr-CG"));
  }
  if (data.metadata && Object.keys(data.metadata).length > 0) {
    row("Metadata", JSON.stringify(data.metadata));
  }

  doc.moveDown(1);
  doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y)
    .strokeColor("#cccccc").lineWidth(0.5).stroke();
  doc.moveDown(0.8);

  if (note) {
    doc.fontSize(9).fillColor(grey).font("Helvetica-Oblique")
      .text(`Note: ${note}`, 50, doc.y, {
        width: doc.page.width - 100,
        align: "left",
      });
    doc.moveDown(0.5);
  }

  doc.fontSize(8).fillColor("#999999").font("Helvetica")
    .text(
      "Generated by OpenPay Congo backend | This is an automated receipt.",
      50,
      doc.y,
      { align: "center", width: doc.page.width - 100 }
    );

  doc.end();
}

/* ══════════════════════════════════════════════════════════════
   ROUTE 1: Health check
══════════════════════════════════════════════════════════════ */
app.get("/", (req, res) => {
  res.json({
    service: "OpenPay Congo Backend",
    status: "running",
    version: "1.0.0",
    endpoints: {
      "POST /pay": "Initiate STK push payment",
      "GET  /status/:referenceId": "Check transaction status",
      "POST /payment-link": "Create a payment link",
      "GET  /receipt/success/:referenceId": "Download success receipt PDF",
      "GET  /receipt/failed/:referenceId": "Download failed receipt PDF",
      "POST /webhook/openpay": "Callback endpoint for OpenPay notifications",
    },
  });
});

/* ══════════════════════════════════════════════════════════════
   ROUTE 2: Initiate STK push
   POST /pay
   Body: { amount, payment_phone_number, provider,
           customer_external_id?, customer?, metadata? }
══════════════════════════════════════════════════════════════ */
app.post("/pay", async (req, res) => {
  const {
    amount,
    payment_phone_number,
    provider,
    customer_external_id,
    customer,
    metadata,
  } = req.body;

  const errors = [];
  const phoneErr = validatePhone(payment_phone_number);
  if (phoneErr) errors.push(phoneErr);

  const amountErr = validateAmount(amount);
  if (amountErr) errors.push(amountErr);

  const providerErr = validateProvider(provider);
  if (providerErr) errors.push(providerErr);

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      status: "validation_error",
      errors,
    });
  }

  const payload = {
    amount: Number(amount),
    payment_phone_number: String(payment_phone_number).trim(),
    provider: String(provider).toUpperCase(),
  };

  if (customer_external_id)
    payload.customer_external_id = String(customer_external_id);
  if (customer) payload.customer = customer;
  if (metadata) payload.metadata = metadata;

  const callOpenpay = () =>
    axios.post(`${OPENPAY_BASE}/transaction/payment`, payload, {
      headers: openpayHeaders(),
      timeout: 25000,
    });

  let response;
  try {
    response = await callOpenpay();
  } catch (firstErr) {
    const isTimeout =
      firstErr.code === "ECONNABORTED" ||
      (firstErr.response && (firstErr.response.status === 504 || firstErr.response.status === 502));

    if (isTimeout) {
      // OpenPay is slow — wait 8 s then retry once
      await new Promise((r) => setTimeout(r, 8000));
      try {
        response = await callOpenpay();
      } catch (retryErr) {
        const { status, message, raw } = extractOpenpayError(retryErr);
        return res.status(status).json({
          success: false,
          status: "failed",
          error:
            "OpenPay API is responding slowly. Please try again in a few seconds. " +
            "Detail: " + message,
          raw,
        });
      }
    } else {
      const { status, message, raw } = extractOpenpayError(firstErr);
      return res.status(status).json({
        success: false,
        status: "failed",
        error: message,
        raw,
      });
    }
  }

  const data = response.data;
  return res.status(200).json({
    success: true,
    status: data.status,
    message: data.message,
    reference: data.reference,
    amount: data.amount,
    currency: data.currency,
    paymentPhoneNumber: data.paymentPhoneNumber,
    provider: data.provider,
    type: data.type,
    metadata: data.metadata || null,
    raw: data,
  });
});

/* ══════════════════════════════════════════════════════════════
   ROUTE 3: Check transaction status
   GET /status/:referenceId
══════════════════════════════════════════════════════════════ */
app.get("/status/:referenceId", async (req, res) => {
  const { referenceId } = req.params;

  if (!referenceId || referenceId.trim() === "") {
    return res.status(400).json({
      success: false,
      error: "referenceId is required in the URL path.",
    });
  }

  try {
    const response = await axios.get(
      `${OPENPAY_BASE}/transaction/status/${referenceId}`,
      { headers: openpayHeaders(), timeout: 20000 }
    );

    const data = response.data;

    let success = false;
    if (data.status === "success") success = true;

    return res.status(200).json({
      success,
      status: data.status,
      message: data.message,
      reference: data.reference,
      amount: data.amount,
      currency: data.currency,
      paymentPhoneNumber: data.paymentPhoneNumber,
      provider: data.provider,
      type: data.type,
      metadata: data.metadata || null,
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || null,
      raw: data,
    });
  } catch (err) {
    const { status, message, raw } = extractOpenpayError(err);
    return res.status(status).json({
      success: false,
      status: "error",
      error: message,
      raw,
    });
  }
});

/* ══════════════════════════════════════════════════════════════
   ROUTE 4: Create payment link
   POST /payment-link
   Body: { amount, description, expires_at?, customer?, success_url?, metadata? }
══════════════════════════════════════════════════════════════ */
app.post("/payment-link", async (req, res) => {
  const { amount, description, expires_at, customer, success_url, metadata } =
    req.body;

  const errors = [];

  const amountErr = validateAmount(amount);
  if (amountErr) errors.push(amountErr);

  if (!description || String(description).trim() === "") {
    errors.push("description is required.");
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      status: "validation_error",
      errors,
    });
  }

  const payload = {
    amount: Number(amount),
    description: String(description).trim(),
  };

  if (expires_at !== undefined) payload.expires_at = Number(expires_at);
  if (customer) payload.customer = customer;
  if (success_url) payload.success_url = success_url;
  if (metadata) payload.metadata = metadata;

  try {
    const response = await axios.post(
      `${OPENPAY_BASE}/payment-link`,
      payload,
      { headers: openpayHeaders(), timeout: 25000 }
    );

    const data = response.data;

    return res.status(201).json({
      success: true,
      payment_token: data.data.payment_token,
      payment_url: data.data.payment_url,
      amount: data.data.amount,
      currency: data.data.currency,
      description: data.data.description,
      expires_at: data.data.expires_at,
      status: data.data.status,
      metadata: data.data.metadata || null,
      raw: data,
    });
  } catch (err) {
    const { status, message, raw } = extractOpenpayError(err);
    return res.status(status).json({
      success: false,
      error: message,
      raw,
    });
  }
});

/* ══════════════════════════════════════════════════════════════
   ROUTE 5a: Download SUCCESS receipt PDF
   GET /receipt/success/:referenceId?note=YourNote
══════════════════════════════════════════════════════════════ */
app.get("/receipt/success/:referenceId", async (req, res) => {
  const { referenceId } = req.params;
  const note = req.query.note || "";

  try {
    const response = await axios.get(
      `${OPENPAY_BASE}/transaction/status/${referenceId}`,
      { headers: openpayHeaders() }
    );
    const data = response.data;

    if (data.status !== "success") {
      return res.status(400).json({
        success: false,
        error: `Transaction status is "${data.status}", not "success". Cannot generate success receipt.`,
        status: data.status,
        message: data.message,
      });
    }

    generateReceiptPDF(res, "success", data, note);
  } catch (err) {
    const { status, message, raw } = extractOpenpayError(err);
    return res.status(status).json({
      success: false,
      error: message,
      raw,
    });
  }
});

/* ══════════════════════════════════════════════════════════════
   ROUTE 5b: Download FAILED receipt PDF
   GET /receipt/failed/:referenceId?note=YourNote
   Also accepts inline body data via POST /receipt/failed if
   you already have the data and don't want a second API call.
══════════════════════════════════════════════════════════════ */
app.get("/receipt/failed/:referenceId", async (req, res) => {
  const { referenceId } = req.params;
  const note = req.query.note || "";

  try {
    const response = await axios.get(
      `${OPENPAY_BASE}/transaction/status/${referenceId}`,
      { headers: openpayHeaders() }
    );
    const data = response.data;

    generateReceiptPDF(res, "failed", data, note);
  } catch (err) {
    const { status, message, raw } = extractOpenpayError(err);
    return res.status(status).json({
      success: false,
      error: message,
      raw,
    });
  }
});

/* ══════════════════════════════════════════════════════════════
   ROUTE 5c: Generate receipt from raw data (no second API call)
   POST /receipt/generate
   Body: { type: "success"|"failed", transaction: {...}, note?: "..." }
══════════════════════════════════════════════════════════════ */
app.post("/receipt/generate", (req, res) => {
  const { type, transaction, note } = req.body;

  if (!type || !["success", "failed"].includes(type)) {
    return res.status(400).json({
      success: false,
      error: 'type must be "success" or "failed".',
    });
  }
  if (!transaction || typeof transaction !== "object") {
    return res.status(400).json({
      success: false,
      error: "transaction object is required.",
    });
  }

  generateReceiptPDF(res, type, transaction, note || "");
});

/* ══════════════════════════════════════════════════════════════
   ROUTE 6: OpenPay Callback / Webhook
   POST /webhook/openpay
   OpenPay POSTs here when payment status changes.
   Must return HTTP 200 within 10 s.
══════════════════════════════════════════════════════════════ */
app.post("/webhook/openpay", (req, res) => {
  res.status(200).json({ success: true });

  const data = req.body;

  console.log("[Webhook] OpenPay notification received:");
  console.log(JSON.stringify(data, null, 2));

  const {
    reference,
    amount,
    currency,
    paymentPhoneNumber,
    provider,
    status,
    message,
    customer,
    metadata,
  } = data;

  switch (status) {
    case "success":
      console.log(
        `[Webhook] ✅ PAYMENT SUCCESS — ref: ${reference} | ` +
          `amount: ${amount} ${currency} | phone: ${paymentPhoneNumber} | ` +
          `provider: ${provider}`
      );
      if (metadata && metadata.order_id) {
        console.log(`[Webhook] Order ID: ${metadata.order_id} — mark as paid.`);
      }
      break;

    case "failed":
      console.log(
        `[Webhook] ❌ PAYMENT FAILED — ref: ${reference} | ` +
          `message: ${message}`
      );
      break;

    case "pending":
      console.log(
        `[Webhook] ⏳ PAYMENT PENDING — ref: ${reference}`
      );
      break;

    case "cancelled":
      console.log(
        `[Webhook] 🚫 PAYMENT CANCELLED — ref: ${reference}`
      );
      break;

    default:
      console.log(`[Webhook] Unknown status "${status}" for ref: ${reference}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   Global 404
══════════════════════════════════════════════════════════════ */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route "${req.method} ${req.path}" not found on this server.`,
  });
});

/* ══════════════════════════════════════════════════════════════
   Global error handler
══════════════════════════════════════════════════════════════ */
app.use((err, req, res, next) => {
  console.error("[Server Error]", err);
  res.status(500).json({
    success: false,
    error: err.message || "Internal server error.",
  });
});

/* ══════════════════════════════════════════════════════════════
   Start
══════════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`OpenPay Congo backend running on port ${PORT}`);
  if (!OPENPAY_API_KEY) {
    console.warn(
      "⚠  WARNING: OPENPAY_API_KEY is not set. Set it in .env before making API calls."
    );
  }
});

module.exports = app;
