// api/mra-process-crn.js


import crypto from "crypto";
// Note: do NOT import node-fetch — use global fetch in Node 18+ (Vercel runtime).
import { generateAesKey } from "./generate-aes.js";
import { rsaEncryptPayload } from "./rsa-encrypt.js";
import { decryptWithAes } from "./decrypt-aes.js";
import { encryptInvoiceWithAes } from "./encrypt-invoice.js";

/**
 * mra-process-crn.js
 * - Maps Zoho Credit Note JSON -> MRA CRN JSON
 * - Auto-extracts reference invoice number from Zoho data when possible
 * - Uses AES/RSA/token/encrypt/transmit pipeline to submit CRN to MRA
 *
 * Important:
 * - Ensure environment variables are set (MRA_USERNAME, MRA_PASSWORD, EBS_MRA_ID, AREA_CODE, MRA_TOKEN_URL, MRA_TRANSMIT_URL, SELLER_*).
 * - This file expects Node runtime (crypto + fs usage) — Vercel serverless Node.
 */

export const config = { runtime: "nodejs" };

const DEFAULTS = {
  TOKEN_URL: "https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token",
  TRANSMIT_URL: "https://vfisc.mra.mu/realtime/invoice/transmit",
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ status: "ERROR", message: "Method not allowed (use POST)" });
    }

    // debug environment presence (remove in prod)
    // console.log("ENV:", { MRA_USERNAME: process.env.MRA_USERNAME ? "SET" : "MISSING" });

    // Accept top-level fields similar to invoice endpoint
    const { invoice_id, invoice_number, invoice_data, ref_invoice_number, crn_reason } = req.body || {};

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
          return v;
        }
      }
      return v;
    };

    const invoiceData = parseMaybeString(invoice_data);
    if (!invoiceData || typeof invoiceData !== "object") {
      return res.status(400).json({ status: "ERROR", message: "invoice_data must be a JSON object (or JSON-string)." });
    }

    // ---- date/time
    const createdTimeRaw = invoiceData.created_time || invoiceData.date_time || invoiceData.date;
    if (!createdTimeRaw) {
      return res.status(400).json({ status: "ERROR", message: "Missing required creditnote date/time (created_time)" });
    }
    const toMraDate = (dtStr) => {
      if (!dtStr || typeof dtStr !== "string") throw new Error("Invalid datetime string");
      const isoMatch = dtStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
      if (isoMatch) return `${isoMatch[1].replace(/-/g, "")} ${isoMatch[2]}`;
      const d = new Date(dtStr);
      if (isNaN(d.getTime())) throw new Error("Invalid datetime");
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    let dateTimeInvoiceIssued;
    try {
      dateTimeInvoiceIssued = toMraDate(createdTimeRaw);
    } catch (e) {
      return res.status(400).json({ status: "ERROR", message: "Invalid date/time format: " + e.message });
    }

    // ---- parse line items
    if (!invoiceData.line_items) {
      return res.status(400).json({ status: "ERROR", message: "Missing required invoice_data.line_items" });
    }
    const rawLineItems = parseMaybeString(invoiceData.line_items);
    if (!Array.isArray(rawLineItems) || rawLineItems.length === 0) {
      return res.status(400).json({ status: "ERROR", message: "invoice_data.line_items must be a non-empty array" });
    }

    // ---- buyer info and detection of reference invoice
    const buyerName = invoiceData.customer_name;
    const buyerTan = invoiceData.cf_vat || invoiceData.cf_tan || invoiceData.tan || null;
    const buyerBrn = invoiceData.cf_brn || invoiceData.cf_brn_number || invoiceData.brn || null;
    if (!buyerName) {
      return res.status(400).json({ status: "ERROR", message: "Missing buyer name (customer_name) in credit note data" });
    }

    // Determine invoiceRefIdentifier:
    // Priority:
    // 1) req.body.ref_invoice_number (explicit)
    // 2) invoiceData.reference_number (Zoho field)
    // 3) invoiceData.invoices_credited (if present and non-empty, take first)
    // 4) invoiceData.invoices_credited_json parsed etc.
    let invoiceRefIdentifier = (typeof ref_invoice_number === "string" && ref_invoice_number.trim()) ? String(ref_invoice_number).trim() : "";

    if (!invoiceRefIdentifier) {
      if (invoiceData.reference_number && String(invoiceData.reference_number).trim()) {
        invoiceRefIdentifier = String(invoiceData.reference_number).trim();
      }
    }

    if (!invoiceRefIdentifier) {
      // Zoho sometimes provides invoices_credited as JSON-string array
      const invoicesCreditedRaw = invoiceData.invoices_credited || invoiceData.invoices_credited_json || invoiceData.invoices_credited_list;
      const parsedCredited = parseMaybeString(invoicesCreditedRaw);
      if (Array.isArray(parsedCredited) && parsedCredited.length > 0) {
        // Try to find property that looks like invoiceIdentifier
        const first = parsedCredited[0];
        if (typeof first === "string" && first.trim()) invoiceRefIdentifier = first.trim();
        else if (first && typeof first.invoice_identifier === "string") invoiceRefIdentifier = first.invoice_identifier;
        else if (first && typeof first.invoice_number === "string") invoiceRefIdentifier = first.invoice_number;
      }
    }

    if (!invoiceRefIdentifier) {
      // final fallback: if Zoho includes "creditnote_refunds" or similar, try to inspect - otherwise we must fail
      return res.status(400).json({ status: "ERROR", message: "Reference invoice not found. Provide ref_invoice_number or ensure invoice_data.reference_number/invoices_credited contains original invoiceIdentifier." });
    }

    // ---- reasonStated: priority req.body.crn_reason -> Zoho notes -> default
    const reason = (typeof crn_reason === "string" && crn_reason.trim())
      ? String(crn_reason).trim()
      : (invoiceData.notes && String(invoiceData.notes).trim() ? String(invoiceData.notes).trim() : "Credit Note issued");

    // ---- numeric helper & tax detection (reuse logic from invoice mapping)
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

    // ---- map items (positive as selected)
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
        if (pct) taxAmt = Number((itemTotalFromZoho * pct / 100).toFixed(2));
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

    // ---- compute totals (authoritative)
    const computedTotals = mraItems.reduce((acc, it) => {
      acc.totalAmtWoVatCur += numeric(it.amtWoVatCur);
      acc.totalVatAmount += numeric(it.vatAmt);
      acc.invoiceTotal += numeric(it.totalPrice);
      acc.discountTotalAmount += numeric(it.discount);
      return acc;
    }, { totalAmtWoVatCur: 0, totalVatAmount: 0, invoiceTotal: 0, discountTotalAmount: 0 });

    const totalAmtWoVatCurStr = Number(computedTotals.totalAmtWoVatCur).toFixed(2);
    const totalVatAmountStr = Number(computedTotals.totalVatAmount).toFixed(2);
    const invoiceTotalStr = Number(computedTotals.invoiceTotal).toFixed(2);
    const discountTotalAmountStr = Number(computedTotals.discountTotalAmount).toFixed(2);
    const totalAmtPaid = numeric(invoiceData.total_paid || invoiceData.amount_paid || invoiceData.total || invoiceTotalStr);

    const personType = buyerTan ? "VATR" : "NVTR";
    const buyerType = buyerTan ? "VATR" : "NVTR";

    // previousNoteHash – same logic as invoice mapping (optional)
    let previousNoteHash = "0";
    if (invoiceData.previousInvoice && typeof invoiceData.previousInvoice === "object") {
      try {
        const prev = invoiceData.previousInvoice;
        const prevDate = prev.dateTime || prev.date_time || prev.date;
        const prevTotal = String(prev.totalAmtPaid || prev.total_amt_paid || prev.total || prev.totalAmtPaid || prev.totalAmt || "");
        const prevBrn = String(prev.brn || prev.prevBrn || prev.previous_brn || "");
        const prevInv = String(prev.invoiceIdentifier || prev.invoiceIdentifier || prev.invoice_id || prev.invoice_number || "");
        if (prevDate && prevTotal && prevBrn && prevInv) {
          previousNoteHash = crypto.createHash("sha256").update(`${prevDate}${prevTotal}${prevBrn}${prevInv}`, "utf8").digest("hex").toUpperCase();
        }
      } catch (e) {
        previousNoteHash = "0";
      }
    }

    // seller (from env)
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

    // buyer
    const buyer = {
      name: String(buyerName),
      tan: buyerTan ? String(buyerTan) : "",
      brn: buyerBrn ? String(buyerBrn) : "",
      businessAddr: (invoiceData.billing_address && typeof invoiceData.billing_address === "string") ? (function(){ try {return JSON.parse(invoiceData.billing_address).address || "";} catch(e){ return invoiceData.billing_address; } })() : (invoiceData.billing_address && invoiceData.billing_address.address ? invoiceData.billing_address.address : ""),
      buyerType,
      nic: invoiceData.nic || ""
    };

    // Build MRA CRN object (array with one entry)
    const mraInvoice = {
      invoiceCounter: String(invoice_id),
      transactionType: invoiceData.transactionType || "B2C",
      personType,
      invoiceTypeDesc: "CRN", // credit note
      currency: invoiceData.currency_code || "MUR",
      invoiceIdentifier: String(invoice_number),
      invoiceRefIdentifier: String(invoiceRefIdentifier),
      previousNoteHash,
      reasonStated: reason,
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
      salesTransactions: invoiceData.salesTransactions || "CASH"
    };

    // --- Now submit end-to-end (AES/RSA/Token/Decrypt/Encrypt/Transmit) ---
    // Ensure credentials present
    const MRA_USERNAME = process.env.MRA_USERNAME;
    const MRA_PASSWORD = process.env.MRA_PASSWORD;
    if (!MRA_USERNAME || !MRA_PASSWORD) {
      return res.status(500).json({ status: "ERROR", message: "MRA credentials not set in environment variables." });
    }

    // Step 1: generate AES key (local)
    const aesKey = generateAesKey(); // base64

    // Step 2: RSA encrypt AES + credentials
    const rsaPayload = {
      username: MRA_USERNAME,
      password: MRA_PASSWORD,
      encryptKey: aesKey,
      refreshToken: "false"
    };
    const rsaEncrypted = rsaEncryptPayload(rsaPayload);

    // Step 3: request token
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
      const txt = await tokenResp.text();
      console.error("Token endpoint error:", tokenResp.status, txt);
      return res.status(500).json({ status: "ERROR", message: "MRA token endpoint returned error", detail: txt });
    }

    const tokenData = await tokenResp.json();
    if (!tokenData || !tokenData.token || !tokenData.key) {
      return res.status(500).json({ status: "ERROR", message: "Token generation failed", detail: tokenData });
    }

    const token = tokenData.token;
    const encKey = tokenData.key;

    // Step 4: decrypt AES returned by MRA (using our aesKey)
    const finalAES = decryptWithAes(encKey, aesKey); // returns base64 AES key string
    if (!finalAES) {
      return res.status(500).json({ status: "ERROR", message: "Failed to decrypt AES key from token response" });
    }

    // Step 5: encrypt CRN invoice (plain array)
    const plainArray = JSON.stringify([mraInvoice]);
    const encryptedInvoice = encryptInvoiceWithAes(plainArray, finalAES);
    if (!encryptedInvoice) {
      return res.status(500).json({ status: "ERROR", message: "Invoice encryption failed" });
    }

    // Step 6: Transmit to MRA
    const transmitUrl = process.env.MRA_TRANSMIT_URL || DEFAULTS.TRANSMIT_URL;
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const requestDateTime = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const transmitResp = await fetch(transmitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        username: MRA_USERNAME,
        ebsMraId: EBS_MRA_ID,
        areaCode: AREA_CODE,
        token
      },
      body: JSON.stringify({
        requestId: mraInvoice.invoiceIdentifier,
        requestDateTime,
        signedHash: "",
        encryptedInvoice
      })
    });

    const transmitText = await transmitResp.text();
    let transmitData;
    try {
      transmitData = JSON.parse(transmitText);
    } catch (e) {
      transmitData = { raw: transmitText };
    }

    let irn = "";
    if (transmitData && Array.isArray(transmitData.fiscalisedInvoices) && transmitData.fiscalisedInvoices.length > 0) {
      irn = transmitData.fiscalisedInvoices[0].irn || "";
    }

    // TODO: persist original Zoho CRN JSON, mraInvoice, encryptedInvoice, transmitData to DB for audit
    return res.status(200).json({
      status: "SUCCESS",
      IRN: irn,
      transmit_response: transmitData,
      preview_json: mraInvoice
    });

  } catch (err) {
    console.error("MRA CRN Process Error:", err && (err.stack || err.message || err));
    return res.status(500).json({ status: "ERROR", message: err.message || String(err) });
  }
}
