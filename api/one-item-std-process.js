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
 * Seller TAN must be different from buyer TAN
 */

const DEFAULTS = {
  TOKEN_URL: "https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token",
  TRANSMIT_URL: "https://vfisc.mra.mu/realtime/invoice/transmit",
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        status: "ERROR",
        message: "Method not allowed (use POST)"
      });
    }

    //-----------------------------------------
    // VALIDATE INPUT
    //-----------------------------------------
    const { invoice_id, invoice_number, invoice_data } = req.body || {};
    if (!invoice_id || !invoice_number || !invoice_data) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing invoice_id, invoice_number or invoice_data"
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

    //-----------------------------------------
    // DATE CONVERSION
    //-----------------------------------------
    const toMraDate = (dt) => {
      const d = new Date(dt);
      const pad = (n) => String(n).padStart(2, "0");
      return (
        d.getFullYear() +
        pad(d.getMonth() + 1) +
        pad(d.getDate()) +
        " " +
        pad(d.getHours()) +
        pad(d.getMinutes()) +
        pad(d.getSeconds())
      );
    };

    const createdTime =
      invoiceData.created_time || invoiceData.date_time || invoiceData.date;

    if (!createdTime) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing invoice date"
      });
    }

    const dateTimeInvoiceIssued = toMraDate(createdTime);

    //-----------------------------------------
    // PROCESS 1 ITEM ONLY (required)
    //-----------------------------------------
    const itemsRaw = parseMaybeString(invoiceData.line_items);
    if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Invoice must have at least one item"
      });
    }

    const it = itemsRaw[0];
    const numeric = (v) =>
      Number(String(v).replace(/[^0-9.\-]/g, "")) || 0;

    const detectTaxCode = (item) => {
      const taxes = item.line_item_taxes || [];
      if (taxes.length > 0) {
        const pct = numeric(taxes[0].tax_percentage);
        if (pct === 15) return "TC01";
        if (pct === 0) return "TC02";
      }
      return "TC04";
    };

    const qty = numeric(it.quantity || 1);
    const price = numeric(it.rate || 0);
    const total = numeric(it.item_total || qty * price);

    let vatAmt = 0;
    if (Array.isArray(it.line_item_taxes) && it.line_item_taxes.length > 0) {
      vatAmt = numeric(it.line_item_taxes[0].tax_amount);
    }

    const amtWoVat = total - vatAmt;

    const mraItem = {
      itemNo: "1",
      taxCode: detectTaxCode(it),
      nature: "GOODS",
      currency: invoiceData.currency_code || "MUR",
      itemDesc: it.name || "",
      quantity: String(qty),
      unitPrice: price.toFixed(2),
      discount: "0.00",
      discountedValue: total.toFixed(2),
      amtWoVatCur: amtWoVat.toFixed(2),
      amtWoVatMur: amtWoVat.toFixed(2),
      vatAmt: vatAmt.toFixed(2),
      totalPrice: total.toFixed(2),
      productCodeOwn: it.item_id || ""
    };

    //-----------------------------------------
    // BUYER
    //-----------------------------------------
    const buyerName = invoiceData.customer_name;
    const buyerTan = invoiceData.cf_vat || invoiceData.cf_tan || "";
    const buyerBrn = invoiceData.cf_brn || "";

    let billing = {};
    if (invoiceData.billing_address) {
      billing = parseMaybeString(invoiceData.billing_address) || {};
    }

    //-----------------------------------------
    // SELLER – MUST BE DIFFERENT TAN
    //-----------------------------------------
    const sellerTan =
      process.env.ONE_ITEM_SELLER_TAN || "11111111";

    //-----------------------------------------
    // BUILD MRA INVOICE JSON
    //-----------------------------------------
    const mraInvoice = {
      invoiceCounter: String(invoice_id),
      transactionType: "B2C",
      personType: buyerTan ? "VATR" : "NVTR",
      invoiceTypeDesc: "STD",
      currency: invoiceData.currency_code || "MUR",
      invoiceIdentifier: String(invoice_number),
      invoiceRefIdentifier: invoiceData.reference_number || "",
      previousNoteHash: "0",
      totalVatAmount: vatAmt.toFixed(2),
      totalAmtWoVatCur: amtWoVat.toFixed(2),
      totalAmtWoVatMur: amtWoVat.toFixed(2),
      invoiceTotal: total.toFixed(2),
      discountTotalAmount: "0.00",
      totalAmtPaid: total.toFixed(2),
      dateTimeInvoiceIssued,
      seller: {
        name: process.env.SELLER_NAME || "Test Seller Ltd",
        tradeName: process.env.SELLER_TRADE_NAME || "Test Seller Ltd",
        tan: sellerTan,
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
        businessAddr: billing.address || "",
        buyerType: buyerTan ? "VATR" : "NVTR",
        nic: invoiceData.nic || ""
      },
      itemList: [mraItem],
      salesTransactions: "CASH"
    };

    //-----------------------------------------
    // AES → RSA → TOKEN → ENCRYPT → TRANSMIT
    //-----------------------------------------

    // AES
    const aesKey = generateAesKey();

    // RSA encrypt credentials
    const rsaPayload = {
      username: process.env.MRA_USERNAME,
      password: process.env.MRA_PASSWORD,
      encryptKey: aesKey,
      refreshToken: "false"
    };

    const rsaEncrypted = rsaEncryptPayload(rsaPayload);

    // Token request
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

    const tokenJson = await tokenResp.json();
    const finalAES = decryptWithAes(tokenJson.key, aesKey);

    // Encrypt invoice payload
    const encryptedInvoice = encryptInvoiceWithAes(
      JSON.stringify([mraInvoice]),
      finalAES
    );

    //-----------------------------------------
    // FIXED MRA-COMPLIANT requestDateTime (17 chars)
    //-----------------------------------------
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");

    const requestDateTime =
      now.getFullYear().toString() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      " " +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds()); // EXACTLY 17 chars: yyyyMMdd HHmmss

    //-----------------------------------------
    // TRANSMIT
    //-----------------------------------------
    const transmitResp = await fetch(DEFAULTS.TRANSMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        username: process.env.MRA_USERNAME,
        ebsMraId: process.env.EBS_MRA_ID || "",
        areaCode: process.env.AREA_CODE || "",
        token: tokenJson.token
      },
      body: JSON.stringify({
        requestId: mraInvoice.invoiceIdentifier,
        requestDateTime: requestDateTime,
        signedHash: "",
        encryptedInvoice: encryptedInvoice
      })
    });

    const txText = await transmitResp.text();
    let txJson = {};
    try { txJson = JSON.parse(txText); } catch { txJson = { raw: txText }; }

    let irn = "";
    if (txJson.fiscalisedInvoices?.length > 0) {
      irn = txJson.fiscalisedInvoices[0].irn || "";
    }

    return res.status(200).json({
      status: "SUCCESS",
      IRN: irn,
      transmit_response: txJson,
      preview_json: mraInvoice
    });

  } catch (err) {
    console.error("One-item STD error:", err);
    return res.status(500).json({
      status: "ERROR",
      message: err.message
    });
  }
}
