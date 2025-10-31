// api/mra-process.js
// Runtime required: Node.js (so Vercel runtime: nodejs)
export const config = { runtime: "nodejs" };

import crypto from "crypto";
import { generateAesKey } from "./generate-aes.js";
import { rsaEncryptPayload } from "./rsa-encrypt.js";
import { decryptWithAes } from "./decrypt-aes.js";
import { encryptInvoiceWithAes } from "./encrypt-invoice.js";

/**
 * Bulk MRA processing - accepts an array of invoices and submits them in one MRA request.
 * Request body:
 * {
 *   "invoices": [
 *     { "invoice_id": "...", "invoice_number": "...", "invoice_data": { ... Zoho JSON ... } },
 *     ...
 *   ]
 * }
 *
 * Env options:
 * - MRA_USERNAME, MRA_PASSWORD, EBS_MRA_ID, AREA_CODE, MRA_TOKEN_URL, MRA_TRANSMIT_URL
 * - REQUIRE_BOTH_VAT=true  (optional; enforces that each invoice contains at least one VATable and one non-VATable item)
 */

const DEFAULTS = {
  TOKEN_URL: process.env.MRA_TOKEN_URL || "https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token",
  TRANSMIT_URL: process.env.MRA_TRANSMIT_URL || "https://vfisc.mra.mu/realtime/invoice/transmit",
  MAX_INVOICES: 10
};

function parseMaybeString(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch (e) { return v; }
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
  if (!dtStr || typeof dtStr !== "string") throw new Error("Invalid datetime string");
  const isoMatch = dtStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (isoMatch) return `${isoMatch[1].replace(/-/g, "")} ${isoMatch[2]}`;
  const d = new Date(dtStr);
  if (isNaN(d.getTime())) throw new Error("Invalid invoice date/time format");
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ status: "ERROR", message: "Use POST" });

    const { invoices } = req.body || {};

    if (!invoices) {
      return res.status(400).json({ status: "ERROR", message: "Missing required field: invoices (array)" });
    }
    if (!Array.isArray(invoices)) {
      return res.status(400).json({ status: "ERROR", message: "invoices must be an array" });
    }
    if (invoices.length === 0 || invoices.length > DEFAULTS.MAX_INVOICES) {
      return res.status(400).json({
        status: "ERROR",
        message: `Provide between 1 and ${DEFAULTS.MAX_INVOICES} invoices in a single request`
      });
    }

    // Validate MRA credentials available
    const MRA_USERNAME = process.env.MRA_USERNAME;
    const MRA_PASSWORD = process.env.MRA_PASSWORD;
    const EBS_MRA_ID = process.env.EBS_MRA_ID || "";
    const AREA_CODE = process.env.AREA_CODE || "";

    if (!MRA_USERNAME || !MRA_PASSWORD) {
      return res.status(500).json({ status: "ERROR", message: "MRA credentials not set in environment variables." });
    }

    // Map each invoice to MRA format
    const mappedInvoices = [];

    const requireBothVat = (String(process.env.REQUIRE_BOTH_VAT || "false").toLowerCase() === "true");

    for (let idx = 0; idx < invoices.length; idx++) {
      const entry = invoices[idx];
      const invoice_id = entry.invoice_id;
      const invoice_number = entry.invoice_number;
      const invoice_data_raw = entry.invoice_data;

      if (!invoice_id || !invoice_number || invoice_data_raw === undefined || invoice_data_raw === null) {
        return res.status(400).json({ status: "ERROR", message: `Invoice at index ${idx} missing invoice_id, invoice_number or invoice_data` });
      }

      const invoiceData = parseMaybeString(invoice_data_raw);
      if (!invoiceData || typeof invoiceData !== "object") {
        return res.status(400).json({ status: "ERROR", message: `invoice_data for invoice ${invoice_number} must be an object` });
      }

      // Date check
      const createdTimeRaw = invoiceData.created_time || invoiceData.date_time || invoiceData.date;
      if (!createdTimeRaw) {
        return res.status(400).json({ status: "ERROR", message: `Missing created_time for invoice ${invoice_number}` });
      }
      let dateTimeInvoiceIssued;
      try { dateTimeInvoiceIssued = toMraDate(createdTimeRaw); }
      catch (e) { return res.status(400).json({ status: "ERROR", message: `Invalid date for invoice ${invoice_number}: ${e.message}` }); }

      // Items parse
      if (!invoiceData.line_items) {
        return res.status(400).json({ status: "ERROR", message: `Missing line_items for invoice ${invoice_number}` });
      }
      const rawLineItems = parseMaybeString(invoiceData.line_items);
      if (!Array.isArray(rawLineItems) || rawLineItems.length === 0) {
        return res.status(400).json({ status: "ERROR", message: `invoice ${invoice_number} must contain at least one line item` });
      }

      // buyer
      const buyerName = invoiceData.customer_name;
      const buyerTan = invoiceData.cf_vat || invoiceData.cf_tan || invoiceData.tan || null;
      const buyerBrn = invoiceData.cf_brn || invoiceData.cf_brn_number || invoiceData.brn || null;
      if (!buyerName) {
        return res.status(400).json({ status: "ERROR", message: `Missing customer_name for invoice ${invoice_number}` });
      }

      // billing address parse
      let billingObj = {};
      if (invoiceData.billing_address) {
        const parsed = parseMaybeString(invoiceData.billing_address);
        if (typeof parsed === "object") billingObj = parsed;
      }

      // Build items and track VATable vs non-VATable presence
      let foundVatable = false;
      let foundNonVatable = false;

      const mraItems = rawLineItems.map((it, iidx) => {
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

        const detectedTaxCode = detectTaxCode(it);
        // classification for presence check: TC01 = VATable standard, TC02 = zero-rated/non-vatable
        if (detectedTaxCode === "TC01") foundVatable = true;
        if (detectedTaxCode === "TC02" || detectedTaxCode === "TC03" || detectedTaxCode === "TC04") foundNonVatable = true;

        const amtWoVatCur = Number((itemTotalFromZoho - taxAmt).toFixed(2));
        const totalPrice = Number((amtWoVatCur + taxAmt).toFixed(2));
        const discountedValue = numeric(it.discounted_value || it.discountedValue || it.item_total || itemTotalFromZoho);

        return {
          itemNo: String(iidx + 1),
          taxCode: detectedTaxCode,
          nature: "GOODS",
          currency: invoiceData.currency_code || "MUR",
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

      if (requireBothVat) {
        if (!foundVatable || !foundNonVatable) {
          return res.status(400).json({
            status: "ERROR",
            message: `Invoice ${invoice_number} does not meet VAT mix requirement (foundVatable=${foundVatable}, foundNonVatable=${foundNonVatable}). Set REQUIRE_BOTH_VAT=false to skip this check.`
          });
        }
      }

      // compute totals authoritative
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

      // previousNoteHash as before (optional)
      let previousNoteHash = "0";
      if (invoiceData.previousInvoice && typeof invoiceData.previousInvoice === "object") {
        try {
          const prev = invoiceData.previousInvoice;
          const prevDate = prev.dateTime || prev.date_time || prev.date;
          const prevTotal = String(prev.totalAmtPaid || prev.total_amt_paid || prev.total || "");
          const prevBrn = String(prev.brn || prev.prevBrn || prev.previous_brn || "");
          const prevInv = String(prev.invoiceIdentifier || prev.invoice_id || prev.invoice_number || "");
          if (prevDate && prevTotal && prevBrn && prevInv) {
            const concat = `${prevDate}${prevTotal}${prevBrn}${prevInv}`;
            previousNoteHash = crypto.createHash("sha256").update(concat, "utf8").digest("hex").toUpperCase();
          }
        } catch (e) { previousNoteHash = "0"; }
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

      mappedInvoices.push(mraInvoice);
    } // end for invoices loop

    // At this point we have mappedInvoices array (1..10 invoices)
    // === ENCRYPT & TRANSMIT (single AES + single token + single transmit) ===

    // Step 1: Generate AES key (base64)
    const aesKey = generateAesKey();

    // Step 2: RSA encrypt with MRA public key the payload { username, password, encryptKey }
    const rsaPayload = {
      username: process.env.MRA_USERNAME,
      password: process.env.MRA_PASSWORD,
      encryptKey: aesKey,
      refreshToken: "false"
    };
    const rsaEncrypted = rsaEncryptPayload(rsaPayload);

    // Step 3: Request token
    const tokenResp = await fetch(DEFAULTS.TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        username: process.env.MRA_USERNAME,
        ebsMraId: process.env.EBS_MRA_ID || "",
        areaCode: process.env.AREA_CODE || ""
      },
      body: JSON.stringify({
        requestId: mappedInvoices[0].invoiceIdentifier, // using first invoice as requestId (unique per request)
        payload: rsaEncrypted
      })
    });

    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      console.error("Token endpoint error:", tokenResp.status, t);
      return res.status(500).json({ status: "ERROR", message: "Token endpoint error", detail: t });
    }

    const tokenData = await tokenResp.json();
    if (!tokenData || !tokenData.token || !tokenData.key) {
      return res.status(500).json({ status: "ERROR", message: "Token generation failed", detail: tokenData });
    }

    const token = tokenData.token;
    const encKey = tokenData.key;

    // Step 4: Decrypt AES key from token response using our original AES
    const finalAES = decryptWithAes(encKey, aesKey);
    if (!finalAES) {
      return res.status(500).json({ status: "ERROR", message: "Failed to decrypt AES key from token response" });
    }

    // Step 5: Encrypt entire array of invoices
    const plainArray = JSON.stringify(mappedInvoices); // array of invoices
    const encryptedInvoice = encryptInvoiceWithAes(plainArray, finalAES);

    if (!encryptedInvoice) {
      return res.status(500).json({ status: "ERROR", message: "Invoice encryption failed" });
    }

    // Step 6: Transmit to MRA
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const requestDateTime = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const transmitResp = await fetch(DEFAULTS.TRANSMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        username: process.env.MRA_USERNAME,
        ebsMraId: process.env.EBS_MRA_ID || "",
        areaCode: process.env.AREA_CODE || "",
        token: token
      },
      body: JSON.stringify({
        requestId: mappedInvoices[0].invoiceIdentifier,
        requestDateTime,
        signedHash: "",
        encryptedInvoice: encryptedInvoice
      })
    });

    const transmitText = await transmitResp.text();
    let transmitData;
    try { transmitData = JSON.parse(transmitText); } catch (e) { transmitData = { raw: transmitText }; }

    // Extract IRNs per fiscalisedInvoices if present
    const irns = [];
    if (transmitData && Array.isArray(transmitData.fiscalisedInvoices)) {
      transmitData.fiscalisedInvoices.forEach((f) => {
        irns.push({ invoiceIdentifier: f.invoiceIdentifier || "", irn: f.irn || "" });
      });
    }

    // Return summary
    return res.status(200).json({
      status: "SUCCESS",
      count: mappedInvoices.length,
      irns,
      transmit_response: transmitData,
      preview_count: mappedInvoices.map((m) => ({ invoiceIdentifier: m.invoiceIdentifier, invoiceTotal: m.invoiceTotal }))
    });

  } catch (err) {
    console.error("MRA Bulk Process Error:", err && (err.stack || err.message || err));
    return res.status(500).json({ status: "ERROR", message: err.message || String(err) });
  }
}
