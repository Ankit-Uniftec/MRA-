// api/one-item-std-process.js

import crypto from "crypto";
import { generateAesKey } from "./generate-aes.js";
import { rsaEncryptPayload } from "./rsa-encrypt.js";
import { decryptWithAes } from "./decrypt-aes.js";
import { encryptInvoiceWithAes } from "./encrypt-invoice.js";

/**
 * One-item Standard Invoice (STD)
 * Always takes ONLY the first item
 * invoiceTypeDesc = "STD"
 * seller TAN must be different from buyer TAN (required by MRA test)
 */

const DEFAULTS = {
  TOKEN_URL: "https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token",
  TRANSMIT_URL: "https://vfisc.mra.mu/realtime/invoice/transmit",
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ status: "ERROR", message: "Method not allowed (use POST)" });
    }

    //-----------------------------------------
    // Step 0 — Input validation
    //-----------------------------------------
    const { invoice_id, invoice_number, invoice_data } = req.body || {};

    if (!invoice_id || !invoice_number || !invoice_data) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing required fields: invoice_id, invoice_number, invoice_data",
      });
    }

    const parseMaybeString = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "object") return v;
      if (typeof v === "string") {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    };

    const invoiceData = parseMaybeString(invoice_data);
    if (!invoiceData || typeof invoiceData !== "object") {
      return res.status(400).json({
        status: "ERROR",
        message: "invoice_data must be a JSON object."
      });
    }

    //-----------------------------------------
    // Date handling
    //-----------------------------------------
    const toMraDate = (dtStr) => {
      const isoMatch = dtStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
      if (isoMatch) {
        return `${isoMatch[1].replace(/-/g, "")} ${isoMatch[2]}`;
      }
      const d = new Date(dtStr);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const dateRaw = invoiceData.created_time || invoiceData.date_time || invoiceData.date;
    if (!dateRaw) {
      return res.status(400).json({ status: "ERROR", message: "Missing invoice date." });
    }
    const dateTimeInvoiceIssued = toMraDate(dateRaw);

    //-----------------------------------------
    // 1 ITEM ONLY (required)
    //-----------------------------------------
    const lineItemsRaw = parseMaybeString(invoiceData.line_items);
    if (!Array.isArray(lineItemsRaw) || lineItemsRaw.length === 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Invoice must contain at least one line item."
      });
    }

    const item = lineItemsRaw[0]; // ONLY FIRST ITEM
    const numeric = (v) => Number(String(v).replace(/[^0-9.\-]/g, "")) || 0;

    const detectTaxCode = (it) => {
      const taxes = it.line_item_taxes || [];
      if (Array.isArray(taxes) && taxes.length > 0) {
        const pct = numeric(taxes[0].tax_percentage || 0);
        if (pct === 15) return "TC01";
        if (pct === 0) return "TC02";
      }
      return "TC04";
    };

    //-----------------------------------------
    // Mapping the 1 item
    //-----------------------------------------
    const quantity = numeric(item.quantity || 1);
    const unitPrice = numeric(item.rate || 0);
    const itemTotal = numeric(item.item_total || quantity * unitPrice);

    let vatAmount = 0;
    if (Array.isArray(item.line_item_taxes) && item.line_item_taxes.length > 0) {
      vatAmount = numeric(item.line_item_taxes[0].tax_amount);
    }

    const amtWoVat = itemTotal - vatAmount;
    const mraItem = {
      itemNo: "1",
      taxCode: detectTaxCode(item),
      nature: "GOODS",
      currency: invoiceData.currency_code || "MUR",
      itemDesc: item.name || "",
      quantity: String(quantity),
      unitPrice: String(unitPrice.toFixed(2)),
      discount: "0.00",
      discountedValue: String(itemTotal.toFixed(2)),
      amtWoVatCur: String(amtWoVat.toFixed(2)),
      amtWoVatMur: String(amtWoVat.toFixed(2)),
      vatAmt: String(vatAmount.toFixed(2)),
      totalPrice: String(itemTotal.toFixed(2)),
      productCodeOwn: item.item_id || "",
    };

    //-----------------------------------------
    // Buyer details
    //-----------------------------------------
    const buyerName = invoiceData.customer_name;
    const buyerTan = invoiceData.cf_vat || invoiceData.cf_tan || "";
    const buyerBrn = invoiceData.cf_brn || "";

    let billingObj = {};
    if (invoiceData.billing_address) {
      const parsed = parseMaybeString(invoiceData.billing_address);
      if (typeof parsed === "object") billingObj = parsed;
    }

    //-----------------------------------------
    // SELLER must have DIFFERENT TAN
    //-----------------------------------------
    const sellerTan =
      process.env.ONE_ITEM_SELLER_TAN ||     // optional override
      "11111111";                            // guaranteed different from real TAN

    //-----------------------------------------
    // Build mraInvoice JSON
    //-----------------------------------------
    const mraInvoice = {
      invoiceCounter: String(invoice_id),
      transactionType: "B2C",
      personType: buyerTan ? "VATR" : "NVTR",
      invoiceTypeDesc: "STD",   // REQUIRED
      currency: invoiceData.currency_code || "MUR",
      invoiceIdentifier: String(invoice_number),
      invoiceRefIdentifier: invoiceData.reference_number || "",
      previousNoteHash: "0",
      totalVatAmount: vatAmount.toFixed(2),
      totalAmtWoVatCur: amtWoVat.toFixed(2),
      totalAmtWoVatMur: amtWoVat.toFixed(2),
      invoiceTotal: itemTotal.toFixed(2),
      discountTotalAmount: "0.00",
      totalAmtPaid: itemTotal.toFixed(2),
      dateTimeInvoiceIssued,

      seller: {
        name: process.env.SELLER_NAME || "Test Seller Ltd",
        tradeName: process.env.SELLER_TRADE_NAME || "Test Seller Ltd",
        tan: sellerTan, // REQUIRED: DIFFERENT TAN
        brn: process.env.SELLER_BRN || "C11111111",
        businessAddr: process.env.SELLER_ADDR || "Mauritius",
        businessPhoneNo: process.env.SELLER_PHONE || "2300000000",
        ebsCounterNo: process.env.EBS_COUNTER_NO || "",
        cashierId: invoiceData.cashier_id || "SYSTEM"
      },

      buyer: {
        name: buyerName,
        tan: buyerTan,
        brn: buyerBrn,
        businessAddr: billingObj.address || "",
        buyerType: buyerTan ? "VATR" : "NVTR",
        nic: invoiceData.nic || ""
      },

      itemList: [mraItem],
      salesTransactions: "CASH"
    };

    //-----------------------------------------
    // AES → RSA → Token → Encrypt → Transmit
    //-----------------------------------------
    const aesKey = generateAesKey();
    const rsaPayload = {
      username: process.env.MRA_USERNAME,
      password: process.env.MRA_PASSWORD,
      encryptKey: aesKey,
      refreshToken: "false"
    };

    const rsaEncrypted = rsaEncryptPayload(rsaPayload);

    const tokenResp = await fetch(DEFAULTS.TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        username: process.env.MRA_USERNAME,
        ebsMraId: process.env.EBS_MRA_ID || "",
        areaCode: process.env.AREA_CODE || ""
      },
      body: JSON.stringify({
        requestId: mraInvoice.invoiceIdentifier,
        payload: rsaEncrypted
      })
    });

    const tokenData = await tokenResp.json();
    const finalAES = decryptWithAes(tokenData.key, aesKey);

    const encryptedInvoice = encryptInvoiceWithAes(JSON.stringify([mraInvoice]), finalAES);

    //-----------------------------------------
    // Transmit final invoice
    //-----------------------------------------
    const transmitResp = await fetch(DEFAULTS.TRANSMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        username: process.env.MRA_USERNAME,
        ebsMraId: process.env.EBS_MRA_ID || "",
        areaCode: process.env.AREA_CODE || "",
        token: tokenData.token
      },
      body: JSON.stringify({
        requestId: mraInvoice.invoiceIdentifier,
        requestDateTime: new Date().toISOString().replace("T", " ").slice(0, 19),
        signedHash: "",
        encryptedInvoice
      })
    });

    const transmitJson = await transmitResp.json();
    let irn = "";
    if (transmitJson.fiscalisedInvoices?.length > 0) {
      irn = transmitJson.fiscalisedInvoices[0].irn;
    }

    //-----------------------------------------
    // Return
    //-----------------------------------------
    return res.status(200).json({
      status: "SUCCESS",
      IRN: irn,
      transmit_response: transmitJson,
      preview_json: mraInvoice
    });

  } catch (err) {
    console.error("One-item STD error:", err);
    return res.status(500).json({ status: "ERROR", message: err.message });
  }
}
