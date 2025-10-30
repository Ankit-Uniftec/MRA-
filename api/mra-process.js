// api/mra-process.js
import crypto from "crypto";
import { generateAesKey } from "./generate-aes.js";
import { rsaEncryptPayload } from "./rsa-encrypt.js";
import { decryptWithAes } from "./decrypt-aes.js";
import { encryptInvoiceWithAes } from "./encrypt-invoice.js";

/**
 * Full end-to-end MRA process:
 * 1. Map Zoho invoice to MRA JSON (uses your mapping logic)
 * 2. Generate AES key
 * 3. RSA encrypt AES+credentials
 * 4. Request token from MRA token API
 * 5. Decrypt token response key (using original AES)
 * 6. Encrypt invoice using decrypted AES
 * 7. Transmit to MRA realtime API
 *
 * Uses environment variables for credentials and endpoints:
 * - MRA_USERNAME
 * - MRA_PASSWORD
 * - EBS_MRA_ID
 * - AREA_CODE
 * - MRA_TOKEN_URL
 * - MRA_TRANSMIT_URL
 * - BASE_URL  (optional, not required here)
 *
 * NOTE: Set these securely in Vercel's Environment Variables before deploying.
 */

const DEFAULTS = {
  TOKEN_URL: "https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token",
  TRANSMIT_URL: "https://vfisc.mra.mu/realtime/invoice/transmit",
};

export default async function handler(req, res) {
  console.log("ENV CHECK:", {
  MRA_USERNAME: process.env.MRA_USERNAME,
  SELLER_NAME: process.env.SELLER_NAME
});

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ status: "ERROR", message: "Method not allowed (use POST)" });
    }

    // --- Step 0: Basic input + mapping (your mapping code) ---
    const { invoice_id, invoice_number, invoice_data } = req.body || {};

    if (!invoice_id || !invoice_number || (invoice_data === undefined || invoice_data === null)) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing required body fields: invoice_id, invoice_number, invoice_data"
      });
    }

    const parseMaybeString = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "object") return v;
      if (typeof v === "string") {
        try {
          return JSON.parse(v);
        } catch (e) {
          // Not JSON -> return original string
          return v;
        }
      }
      return v;
    };
    const invoiceData = parseMaybeString(invoice_data);
    if (!invoiceData || typeof invoiceData !== "object") {
      return res.status(400).json({
        status: "ERROR",
        message: "invoice_data must be a JSON object (or JSON-string). Received: " + typeof invoice_data
      });
    }

    // mapping helpers (copied from your working mapping code)
    const toMraDate = (dtStr) => {
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
    };

    const createdTimeRaw = invoiceData.created_time || invoiceData.date_time || invoiceData.date;
    if (!createdTimeRaw) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing required invoice date/time. Provide invoice_data.created_time (ISO with time)"
      });
    }

    let dateTimeInvoiceIssued;
    try {
      dateTimeInvoiceIssued = toMraDate(createdTimeRaw);
    } catch (err) {
      return res.status(400).json({ status: "ERROR", message: "Invalid invoice date/time: " + err.message });
    }

    if (!invoiceData.line_items) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing required invoice_data.line_items (Zoho returns this as a JSON-string)."
      });
    }

    const rawLineItems = parseMaybeString(invoiceData.line_items);
    if (!Array.isArray(rawLineItems)) {
      return res.status(400).json({
        status: "ERROR",
        message: "invoice_data.line_items is not a JSON array. Ensure Zoho line_items is passed correctly as JSON or JSON-string."
      });
    }
    if (rawLineItems.length === 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Invoice must contain at least one line item."
      });
    }

    // buyer info
    const buyerName = invoiceData.customer_name;
    const buyerTan = invoiceData.cf_vat || invoiceData.cf_tan || invoiceData.tan || null;
    const buyerBrn = invoiceData.cf_brn || invoiceData.cf_brn_number || invoiceData.brn || null;
    if (!buyerName) {
      return res.status(400).json({ status: "ERROR", message: "Missing required buyer name: invoice_data.customer_name" });
    }

    let billingObj = {};
    if (invoiceData.billing_address) {
      const parsed = parseMaybeString(invoiceData.billing_address);
      if (typeof parsed === "object") billingObj = parsed;
    }

    const numeric = (v) => {
      if (v === null || v === undefined || v === "") return 0;
      return Number(String(v).replace(/[^0-9.\-]+/g, "")) || 0;
    };

    const detectTaxCode = (item) => {
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
    };

    const mraItems = rawLineItems.map((it, idx) => {
      const quantity = numeric(it.quantity || it.qty || 1);
      const unitPrice = numeric(it.rate || it.sales_rate || it.rate_formatted || it.unit_price || 0);
      const itemTotalFromZoho = numeric(it.item_total || it.item_total_formatted || it.amount || it.total || (quantity * unitPrice));
      let taxAmt = 0;
      if (Array.isArray(it.line_item_taxes) && it.line_item_taxes.length > 0) {
        taxAmt = it.line_item_taxes.reduce((s, t) => s + numeric(t.tax_amount || t.tax_amount_formatted || 0), 0);
      } else if (typeof it.tax_amount !== "undefined") {
        taxAmt = numeric(it.tax_amount);
      } else {
        const pct = numeric(it.tax_percentage || (it.line_item_taxes && it.line_item_taxes[0] && it.line_item_taxes[0].tax_percentage) || 0);
        if (pct) {
          taxAmt = Number((itemTotalFromZoho * pct / 100).toFixed(2));
        }
      }

      const discountedValue = numeric(it.discounted_value || it.discountedValue || it.item_total || itemTotalFromZoho);
      const amtWoVatCur = Number((itemTotalFromZoho - taxAmt).toFixed(2));
      const amtWoVatMur = amtWoVatCur;
      const totalPrice = Number((amtWoVatCur + taxAmt).toFixed(2));
      const detectedTaxCode = detectTaxCode(it);

      return {
        itemNo: String(idx + 1),
        taxCode: detectedTaxCode,
        nature: "GOODS",
        currency: invoiceData.currency_code || "MUR",
        itemDesc: it.name || it.description || "",
        quantity: String(quantity),
        unitPrice: String(Number(unitPrice).toFixed(2)),
        discount: String(Number(numeric(it.discount_amount || it.discount || 0)).toFixed(2)),
        discountedValue: String(Number(discountedValue).toFixed(2)),
        amtWoVatCur: String(Number(amtWoVatCur).toFixed(2)),
        amtWoVatMur: String(Number(amtWoVatMur).toFixed(2)),
        vatAmt: String(Number(taxAmt).toFixed(2)),
        totalPrice: String(Number(totalPrice).toFixed(2)),
        productCodeOwn: it.item_id || it.product_code || it.sku || ""
      };
    });

    // compute totals
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
    const totalAmtPaid = numeric(invoiceData.total_paid || invoiceData.amount_paid || invoiceData.total || invoiceTotalStr);

    const personType = buyerTan ? "VATR" : "NVTR";
    const buyerType = buyerTan ? "VATR" : "NVTR";

    let previousNoteHash = "0";
    if (invoiceData.previousInvoice && typeof invoiceData.previousInvoice === "object") {
      try {
        const prev = invoiceData.previousInvoice;
        const prevDate = prev.dateTime || prev.date_time || prev.date;
        const prevTotal = String(prev.totalAmtPaid || prev.total_amt_paid || prev.total || prev.totalAmtPaid || prev.totalAmt || "");
        const prevBrn = String(prev.brn || prev.prevBrn || prev.previous_brn || "");
        const prevInv = String(prev.invoiceIdentifier || prev.invoiceIdentifier || prev.invoice_id || prev.invoice_number || "");
        if (prevDate && prevTotal && prevBrn && prevInv) {
          const concat = `${prevDate}${prevTotal}${prevBrn}${prevInv}`;
          previousNoteHash = crypto.createHash("sha256").update(concat, "utf8").digest("hex").toUpperCase();
        }
      } catch (e) {
        previousNoteHash = "0";
      }
    }

    const seller = {
      name: process.env.SELLER_NAME || "Electrum Mauritius Limited",
      tradeName: process.env.SELLER_TRADE_NAME || "Electrum Mauritius Limited",
      tan: process.env.SELLER_TAN || "27124193",
      brn: process.env.SELLER_BRN || "C11106429",
      businessAddr: process.env.SELLER_ADDR || "Mauritius",
      businessPhoneNo: process.env.SELLER_PHONE || "2302909090",
      ebsCounterNo: process.env.EBS_COUNTER_NO || "",
      cashierId: invoiceData.cashier_id || "SYSTEM"
    };

    const buyer = {
      name: String(buyerName),
      tan: buyerTan ? String(buyerTan) : "",
      brn: buyerBrn ? String(buyerBrn) : "",
      businessAddr: billingObj && billingObj.address ? String(billingObj.address) : "",
      buyerType: buyerType,
      nic: invoiceData.nic || ""
    };

    const mraInvoice = {
      invoiceCounter: String(invoice_id),
      transactionType: invoiceData.transactionType || "B2C",
      personType: personType,
      invoiceTypeDesc: invoiceData.invoiceTypeDesc || "STD",
      currency: invoiceData.currency_code || "MUR",
      invoiceIdentifier: String(invoice_number),
      invoiceRefIdentifier: invoiceData.reference_number || "",
      previousNoteHash: previousNoteHash,
      totalVatAmount: String(totalVatAmountStr),
      totalAmtWoVatCur: String(totalAmtWoVatCurStr),
      totalAmtWoVatMur: String(totalAmtWoVatCurStr),
      invoiceTotal: String(invoiceTotalStr),
      discountTotalAmount: String(discountTotalAmountStr),
      totalAmtPaid: String(Number(totalAmtPaid).toFixed(2)),
      dateTimeInvoiceIssued: dateTimeInvoiceIssued,
      seller,
      buyer,
      itemList: mraItems,
      salesTransactions: invoiceData.salesTransactions || "CASH"
    };

    // --- Step 1: Generate AES key (local) ---
    const aesKey = generateAesKey(); // base64

    // --- Step 2: RSA encrypt credentials + aesKey payload ---
    const MRA_USERNAME = process.env.MRA_USERNAME;
    const MRA_PASSWORD = process.env.MRA_PASSWORD;
    if (!MRA_USERNAME || !MRA_PASSWORD) {
      return res.status(500).json({ status: "ERROR", message: "MRA credentials not set in environment variables." });
    }

    const rsaPayload = {
      username: MRA_USERNAME,
      password: MRA_PASSWORD,
      encryptKey: aesKey,
      refreshToken: "false"
    };

    const rsaEncrypted = rsaEncryptPayload(rsaPayload);

    // --- Step 3: Request token from MRA token endpoint ---
    const tokenUrl = process.env.MRA_TOKEN_URL || DEFAULTS.TOKEN_URL;
    const EBS_MRA_ID = process.env.EBS_MRA_ID || "";
    const AREA_CODE = process.env.AREA_CODE || "";

    const tokenResp = await fetch(tokenUrl, {
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
    const encKey = tokenData.key; // this is expected to be base64 ciphertext

    // --- Step 4: Decrypt AES key returned by MRA using our original aesKey ---
    const finalAES = decryptWithAes(encKey, aesKey); // decrypted result (string) - expected to be base64 of AES
    if (!finalAES) {
      return res.status(500).json({ status: "ERROR", message: "Failed to decrypt AES key from token response" });
    }

    // --- Step 5: Encrypt invoice payload with finalAES ---
    const plainArray = JSON.stringify([mraInvoice]); // MRA expects array of invoices as plainText
    const encryptedInvoice = encryptInvoiceWithAes(plainArray, finalAES);
    if (!encryptedInvoice) {
      return res.status(500).json({ status: "ERROR", message: "Invoice encryption failed" });
    }

    // --- Step 6: Transmit to MRA realtime API ---
    const transmitUrl = process.env.MRA_TRANSMIT_URL || DEFAULTS.TRANSMIT_URL;
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const requestDateTime = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const transmitResp = await fetch(transmitUrl, {
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
        requestDateTime: requestDateTime,
        signedHash: "",
        encryptedInvoice: encryptedInvoice
      })
    });

    const transmitDataText = await transmitResp.text();
    let transmitData;
    try {
      transmitData = JSON.parse(transmitDataText);
    } catch (e) {
      // some MRA responses may be plain text on errors
      transmitData = { raw: transmitDataText };
    }

    // Extract IRN if present
    let irn = "";
    if (transmitData && Array.isArray(transmitData.fiscalisedInvoices) && transmitData.fiscalisedInvoices.length > 0) {
      irn = transmitData.fiscalisedInvoices[0].irn || "";
    }

    // TODO: persist original Zoho, mraInvoice, encryptedInvoice, transmitData to DB for audit - recommended

    return res.status(200).json({
      status: "SUCCESS",
      IRN: irn,
      transmit_response: transmitData,
      preview_json: mraInvoice
    });

  } catch (err) {
    console.error("MRA Process Error:", err && (err.stack || err.message || err));
    return res.status(500).json({
      status: "ERROR",
      message: err.message || String(err)
    });
  }
}
