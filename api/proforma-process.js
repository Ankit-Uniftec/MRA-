// api/proforma-process.js
/**
 * proforma-process.js
 *
 * Accepts Zoho Estimate (Proforma) JSON and performs full end-to-end LIVE submission to MRA:
 * 1. Map Zoho Estimate -> MRA invoice JSON (invoiceTypeDesc = "PRF")
 * 2. Generate AES key (local helper)
 * 3. RSA encrypt AES with MRA public key (helper)
 * 4. Request token from MRA token API (live endpoint)
 * 5. Decrypt returned key with our AES (helper)
 * 6. Encrypt invoice payload with final AES (helper)
 * 7. Transmit encrypted invoice to MRA realtime API (live endpoint)
 *
 * Inputs (POST body JSON):
 * {
 *   "estimate_id": "6281705000000602071",
 *   "estimate_number": "QT-000002",
 *   "estimate_data": { ...Zoho Estimate JSON object... }
 * }
 *
 * IMPORTANT:
 * - This file expects the helper modules in /api:
 *   generate-aes.js, rsa-encrypt.js, decrypt-aes.js, encrypt-invoice.js
 * - Environment variables must be set (see README or .env.local):
 *   MRA_USERNAME, MRA_PASSWORD, EBS_MRA_ID, AREA_CODE, MRA_TOKEN_URL, MRA_TRANSMIT_URL
 *
 * Runtime: Node.js (serverless). Ensure Vercel function runtime is nodejs.
 */

export const config = { runtime: "nodejs" };



import crypto from "crypto";
// Use built-in fetch (Node 18+ or Vercel runtime). Do NOT import node-fetch.
import { generateAesKey } from "./generate-aes.js";
import { rsaEncryptPayload } from "./rsa-encrypt.js";
import { decryptWithAes } from "./decrypt-aes.js";
import { encryptInvoiceWithAes } from "./encrypt-invoice.js";

async function safeJsonParse(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch (e) {
      return v;
    }
  }
  return v;
}

function numeric(v) {
  if (v === null || v === undefined || v === "") return 0;
  return Number(String(v).replace(/[^0-9.\-]+/g, "")) || 0;
}

function detectTaxCode(item) {
  const taxes = item.line_item_taxes || [];
  if (Array.isArray(taxes) && taxes.length > 0) {
    const first = taxes[0];
    const pct = numeric(first.tax_percentage ?? first.tax_percentage ?? first.tax_percentage);
    const name = (first.tax_name || "").toString().toUpperCase();
    if (pct === 15 || name.includes("15")) return "TC01";
    if (pct === 0 || name.includes("VAT 0") || name.includes("(0%)")) return "TC02";
    if (name.includes("EXEMPT")) return "TC03";
    if (name.includes("VAT")) return "TC01";
  }
  if (typeof item.tax_percentage !== "undefined") {
    const p = numeric(item.tax_percentage);
    if (p === 15) return "TC01";
    if (p === 0) return "TC02";
  }
  return "TC04";
}

function toMraDate(dtStr) {
  if (!dtStr || typeof dtStr !== "string") {
    throw new Error("Invalid datetime string");
  }
  const isoMatch = dtStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1].replace(/-/g, "")} ${isoMatch[2]}`; // yyyyMMdd HH:mm:ss
  }
  const d = new Date(dtStr);
  if (isNaN(d.getTime())) {
    throw new Error("Invalid invoice date/time format. Provide ISO datetime (e.g. 2025-09-15T12:00:00+0400)");
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ status: "ERROR", message: "Method not allowed (use POST)" });
    }

    // Basic env check
    const MRA_USERNAME = process.env.MRA_USERNAME;
    const MRA_PASSWORD = process.env.MRA_PASSWORD;
    const EBS_MRA_ID = process.env.EBS_MRA_ID || "";
    const AREA_CODE = process.env.AREA_CODE || "";
    const TOKEN_URL = process.env.MRA_TOKEN_URL || "https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token";
    const TRANSMIT_URL = process.env.MRA_TRANSMIT_URL || "https://vfisc.mra.mu/realtime/invoice/transmit";

    if (!MRA_USERNAME || !MRA_PASSWORD) {
      return res.status(500).json({ status: "ERROR", message: "MRA credentials not set in environment variables." });
    }

    const { estimate_id, estimate_number, estimate_data } = req.body || {};
    if (!estimate_id || !estimate_number || (estimate_data === undefined || estimate_data === null)) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing required body fields: estimate_id, estimate_number, estimate_data"
      });
    }

    // Parse the Zoho estimate_data (may be string)
    const data = await safeJsonParse(estimate_data);
    if (!data || typeof data !== "object") {
      return res.status(400).json({ status: "ERROR", message: "estimate_data must be an object or JSON-string." });
    }

    // Validate created time: Zoho estimate may have 'date' only; prefer ISO-like created_time if available
    const createdTimeRaw = data.created_time || data.date || data.date_formatted || data.expiry_date || data.date; // choose best available
    if (!createdTimeRaw) {
      // For proforma use current time if Zoho doesn't provide time (but MRA expects time)
      // Use now as fallback
      const now = new Date();
      data.created_time = now.toISOString();
    }

    let dateTimeInvoiceIssued;
    try {
      dateTimeInvoiceIssued = toMraDate(data.created_time || data.date);
    } catch (err) {
      return res.status(400).json({ status: "ERROR", message: "Invalid date/time: " + err.message });
    }

    // Parse line_items (Zoho sends as JSON-string)
    if (!data.line_items) {
      return res.status(400).json({ status: "ERROR", message: "Missing required estimate_data.line_items" });
    }
    const rawLineItems = await safeJsonParse(data.line_items);
    if (!Array.isArray(rawLineItems) || rawLineItems.length < 2) {
      return res.status(400).json({ status: "ERROR", message: "Proforma must contain at least 2 line items." });
    }

    // Buyer fields
    const buyerName = data.customer_name || data.customer || "";
    const buyerTan = data.cf_vat || data.cf_tan || data.tan || "";
    const buyerBrn = data.cf_brn || data.cf_brn_number || data.brn || "";

    if (!buyerName) {
      return res.status(400).json({ status: "ERROR", message: "Missing buyer name in estimate_data.customer_name" });
    }

    // Billing address parse
    let billingObj = {};
    if (data.billing_address) {
      const parsed = await safeJsonParse(data.billing_address);
      if (typeof parsed === "object") billingObj = parsed;
    }

    // Build MRA itemList from Zoho items
    const mraItems = rawLineItems.map((it, idx) => {
      const quantity = numeric(it.quantity || it.qty || 1);
      const unitPrice = numeric(it.rate || it.sales_rate || it.rate_formatted || it.unit_price || 0);
      const itemTotalFromZoho = numeric(it.item_total || it.item_total_formatted || it.amount || (quantity * unitPrice));
      let taxAmt = 0;
      if (Array.isArray(it.line_item_taxes) && it.line_item_taxes.length > 0) {
        taxAmt = it.line_item_taxes.reduce((s, t) => s + numeric(t.tax_amount || t.tax_amount_formatted || 0), 0);
      } else {
        const pct = numeric(it.tax_percentage || (it.line_item_taxes && it.line_item_taxes[0] && it.line_item_taxes[0].tax_percentage) || 0);
        if (pct) taxAmt = Number((itemTotalFromZoho * pct / 100).toFixed(2));
      }
      const discountedValue = numeric(it.discounted_value || it.discountedValue || it.item_total || itemTotalFromZoho);
      const amtWoVatCur = Number((itemTotalFromZoho - taxAmt).toFixed(2));
      const totalPrice = Number((amtWoVatCur + taxAmt).toFixed(2));
      const detectedTaxCode = detectTaxCode(it);

      return {
        itemNo: String(idx + 1),
        taxCode: detectedTaxCode,
        nature: "GOODS",
        currency: data.currency_code || "MUR",
        itemDesc: it.name || it.description || "",
        quantity: String(quantity),
        unitPrice: String(Number(unitPrice).toFixed(2)),
        discount: String(Number(numeric(it.discount_amount || it.discount || 0)).toFixed(2)),
        discountedValue: String(Number(discountedValue).toFixed(2)),
        amtWoVatCur: String(Number(amtWoVatCur).toFixed(2)),
        amtWoVatMur: String(Number(amtWoVatCur).toFixed(2)),
        vatAmt: String(Number(taxAmt).toFixed(2)),
        totalPrice: String(Number(totalPrice).toFixed(2)),
        productCodeOwn: it.item_id || it.product_code || it.sku || ""
      };
    });

    // Compute authoritative totals
    const computedTotals = mraItems.reduce(
      (acc, it) => {
        acc.totalAmtWoVatCur += numeric(it.amtWoVatCur);
        acc.totalVatAmount += numeric(it.vatAmt);
        acc.invoiceTotal += numeric(it.totalPrice);
        acc.discountTotalAmount += numeric(it.discount);
        return acc;
      },
      { totalAmtWoVatCur: 0, totalVatAmount: 0, invoiceTotal: 0, discountTotalAmount: 0 }
    );

    const totalAmtWoVatCurStr = Number(computedTotals.totalAmtWoVatCur).toFixed(2);
    const totalVatAmountStr = Number(computedTotals.totalVatAmount).toFixed(2);
    const invoiceTotalStr = Number(computedTotals.invoiceTotal).toFixed(2);
    const discountTotalAmountStr = Number(computedTotals.discountTotalAmount).toFixed(2);

    const totalAmtPaid = numeric(data.total_paid || data.amount_paid || data.total || invoiceTotalStr);

    const personType = buyerTan ? "VATR" : "NVTR";
    const buyerType = buyerTan ? "VATR" : "NVTR";

    let previousNoteHash = "0";
    if (data.previousInvoice && typeof data.previousInvoice === "object") {
      try {
        const prev = data.previousInvoice;
        const prevDate = prev.dateTime || prev.date_time || prev.date;
        const prevTotal = String(prev.totalAmtPaid || prev.total_amt_paid || prev.total || "");
        const prevBrn = String(prev.brn || "");
        const prevInv = String(prev.invoiceIdentifier || prev.invoice_id || prev.invoice_number || "");
        if (prevDate && prevTotal && prevBrn && prevInv) {
          previousNoteHash = crypto.createHash("sha256").update(`${prevDate}${prevTotal}${prevBrn}${prevInv}`, "utf8").digest("hex").toUpperCase();
        }
      } catch (e) {
        previousNoteHash = "0";
      }
    }

    // Seller block (from env)
    const seller = {
      name: process.env.SELLER_NAME || "Electrum Mauritius Limited",
      tradeName: process.env.SELLER_TRADE_NAME || "Electrum Mauritius Limited",
      tan: process.env.SELLER_TAN || "27124193",
      brn: process.env.SELLER_BRN || "C11106429",
      businessAddr: process.env.SELLER_ADDR || "Mauritius",
      businessPhoneNo: process.env.SELLER_PHONE || "2302909090",
      ebsCounterNo: process.env.EBS_COUNTER_NO || "",
      cashierId: data.cashier_id || "SYSTEM"
    };

    const buyer = {
      name: String(buyerName),
      tan: buyerTan ? String(buyerTan) : "",
      brn: buyerBrn ? String(buyerBrn) : "",
      businessAddr: billingObj && billingObj.address ? String(billingObj.address) : "",
      buyerType,
      nic: data.nic || ""
    };

    // Build final MRA invoice (Proforma)
    const mraInvoice = {
      invoiceCounter: String(estimate_id),
      transactionType: data.transactionType || "B2C",
      personType,
      invoiceTypeDesc: "PRF", // <-- Proforma
      currency: data.currency_code || "MUR",
      invoiceIdentifier: String(estimate_number),
      invoiceRefIdentifier: data.reference_number || data.reference || "",
      previousNoteHash,
      totalVatAmount: String(totalVatAmountStr),
      totalAmtWoVatCur: String(totalAmtWoVatCurStr),
      totalAmtWoVatMur: String(totalAmtWoVatCurStr),
      invoiceTotal: String(invoiceTotalStr),
      discountTotalAmount: String(discountTotalAmountStr),
      totalAmtPaid: String(Number(totalAmtPaid).toFixed(2)),
      dateTimeInvoiceIssued,
      seller,
      buyer,
      itemList: mraItems,
      salesTransactions: data.salesTransactions || "CASH"
    };

    // --- Begin Transmission flow (LIVE) ---
    // Step 1: Generate AES key (base64)
    const aesKey = generateAesKey();

    // Step 2: RSA encrypt AES + credentials
    const rsaPayload = {
      username: MRA_USERNAME,
      password: MRA_PASSWORD,
      encryptKey: aesKey,
      refreshToken: "false"
    };
    const rsaEncrypted = rsaEncryptPayload(rsaPayload);

    // Step 3: Request token from MRA token endpoint
    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        username: MRA_USERNAME,
        ebsMraId: EBS_MRA_ID,
        areaCode: AREA_CODE
      },
      body: JSON.stringify({ requestId: mraInvoice.invoiceIdentifier, payload: rsaEncrypted })
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      console.error("Token endpoint error:", tokenResp.status, text);
      return res.status(500).json({ status: "ERROR", message: "MRA token endpoint returned error", detail: text });
    }

    const tokenData = await tokenResp.json();
    if (!tokenData || !tokenData.token || !tokenData.key) {
      return res.status(500).json({ status: "ERROR", message: "Token generation failed", detail: tokenData });
    }

    const token = tokenData.token;
    const encKey = tokenData.key; // encrypted key (base64) from MRA

    // Step 4: Decrypt AES key returned by MRA using our original aesKey
    const finalAES = decryptWithAes(encKey, aesKey); // expected to return base64 AES key string
    if (!finalAES) {
      return res.status(500).json({ status: "ERROR", message: "Failed to decrypt AES key from token response" });
    }

    // Step 5: Encrypt invoice payload with finalAES
    const plainArray = JSON.stringify([mraInvoice]);
    const encryptedInvoice = encryptInvoiceWithAes(plainArray, finalAES);
    if (!encryptedInvoice) {
      return res.status(500).json({ status: "ERROR", message: "Invoice encryption failed" });
    }

    // Step 6: Transmit to MRA realtime API (LIVE)
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const requestDateTime = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const transmitResp = await fetch(TRANSMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        username: MRA_USERNAME,
        ebsMraId: EBS_MRA_ID,
        areaCode: AREA_CODE,
        token: token
      },
      body: JSON.stringify({
        requestId: mraInvoice.invoiceIdentifier,
        requestDateTime,
        signedHash: "",
        encryptedInvoice: encryptedInvoice
      })
    });

    const transmitText = await transmitResp.text();
    let transmitData;
    try {
      transmitData = JSON.parse(transmitText);
    } catch (e) {
      transmitData = { raw: transmitText };
    }

    // Extract IRN if present (proforma may not return an IRN)
    let irn = "";
    if (transmitData && Array.isArray(transmitData.fiscalisedInvoices) && transmitData.fiscalisedInvoices.length > 0) {
      irn = transmitData.fiscalisedInvoices[0].irn || "";
    }

    // TODO: persist original estimate_data, mraInvoice, encryptedInvoice, transmitData (DB or storage)

    return res.status(200).json({
      status: "SUCCESS",
      message: "Proforma transmitted (LIVE). Inspect transmit_response for details.",
      IRN: irn,
      transmit_response: transmitData,
      preview_json: mraInvoice
    });

  } catch (err) {
    console.error("PROFORMA Process Error:", err && (err.stack || err.message || err));
    return res.status(500).json({ status: "ERROR", message: err.message || String(err) });
  }
}
