// api/one-item-std-process.js
import crypto from "crypto";
import { generateAesKey } from "./generate-aes.js";
import { rsaEncryptPayload } from "./rsa-encrypt.js";
import { decryptWithAes } from "./decrypt-aes.js";
import { encryptInvoiceWithAes } from "./encrypt-invoice.js";

const DEFAULTS = {
  TOKEN_URL: "https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token",
  TRANSMIT_URL: "https://vfisc.mra.mu/realtime/invoice/transmit",
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ status: "ERROR", message: "POST only" });
    }

    //---------------------------------------------------------------------
    // INPUT VALIDATION — EXACT SAME AS mra-process.js
    //---------------------------------------------------------------------
    const { invoice_id, invoice_number, invoice_data } = req.body || {};

    if (!invoice_id || !invoice_number || invoice_data == null) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing invoice_id, invoice_number, or invoice_data"
      });
    }

    const parseMaybeString = (v) => {
      if (v == null) return null;
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
        message: "invoice_data must be a JSON object"
      });
    }

    //---------------------------------------------------------------------
    // DATE FORMATTING — EXACT COPY FROM mra-process.js
    //---------------------------------------------------------------------
    const toMraDate = (dtStr) => {
      const iso = dtStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
      if (iso) return `${iso[1].replace(/-/g, "")} ${iso[2]}`;

      const d = new Date(dtStr);
      if (isNaN(d.getTime())) throw new Error("Invalid datetime: " + dtStr);

      const pad = (n) => String(n).padStart(2, "0");
      return (
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      );
    };

    const createdTime =
      invoiceData.created_time ||
      invoiceData.date_time ||
      invoiceData.date;

    if (!createdTime) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing created_time/date_time/date"
      });
    }

    let dateTimeInvoiceIssued;
    try {
      dateTimeInvoiceIssued = toMraDate(createdTime);
    } catch (err) {
      return res.status(400).json({
        status: "ERROR",
        message: err.message
      });
    }

    //---------------------------------------------------------------------
    // LINE ITEMS — USING EXACT SAME LOGIC BUT ONLY FIRST ITEM
    //---------------------------------------------------------------------
    if (!invoiceData.line_items) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing invoice_data.line_items"
      });
    }

    const rawItems = parseMaybeString(invoiceData.line_items);
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Invoice must have at least one item"
      });
    }

    const it = rawItems[0]; // ONLY FIRST ITEM
    const numeric = (v) =>
      Number(String(v || "0").replace(/[^0-9.\-]+/g, "")) || 0;

    const detectTaxCode = (item) => {
      const taxes = item.line_item_taxes || [];
      if (Array.isArray(taxes) && taxes.length > 0) {
        const first = taxes[0];
        const pct = numeric(first.tax_percentage);
        const name = (first.tax_name || "").toUpperCase();
        if (pct === 15 || name.includes("15")) return "TC01";
        if (pct === 0 || name.includes("(0%)")) return "TC02";
        if (name.includes("EXEMPT")) return "TC03";
      }
      if (item.tax_percentage == 15) return "TC01";
      if (item.tax_percentage == 0) return "TC02";
      return "TC04";
    };

    const qty = numeric(it.quantity || 1);
    const rate = numeric(it.rate || 0);
    const totalNoTax = qty * rate;

    let vatAmt = 0;
    if (Array.isArray(it.line_item_taxes) && it.line_item_taxes.length > 0) {
      vatAmt = numeric(it.line_item_taxes[0].tax_amount);
    }

    const total = totalNoTax + vatAmt;
    const amtWoVat = totalNoTax;

    const mraItems = [
      {
        itemNo: "1",
        taxCode: detectTaxCode(it),
        nature: "GOODS",
        currency: invoiceData.currency_code || "MUR",
        itemDesc: it.name || "",
        quantity: String(qty),
        unitPrice: rate.toFixed(2),
        discount: "0.00",
        discountedValue: total.toFixed(2),
        amtWoVatCur: amtWoVat.toFixed(2),
        amtWoVatMur: amtWoVat.toFixed(2),
        vatAmt: vatAmt.toFixed(2),
        totalPrice: total.toFixed(2),
        productCodeOwn: it.item_id || ""
      }
    ];

    //---------------------------------------------------------------------
    // BUYER — EXACT COPY
    //---------------------------------------------------------------------
    const buyerName = invoiceData.customer_name;
    const buyerTan =
      invoiceData.cf_vat || invoiceData.cf_tan || invoiceData.tan || "";
    const buyerBrn =
      invoiceData.cf_brn || invoiceData.cf_brn_number || invoiceData.brn || "";

    let billing = {};
    if (invoiceData.billing_address) {
      const parsed = parseMaybeString(invoiceData.billing_address);
      if (typeof parsed === "object") billing = parsed;
    }

    //---------------------------------------------------------------------
    // SELLER — EXACT COPY EXCEPT TAN OVERRIDE
    //---------------------------------------------------------------------
    const seller = {
      name: process.env.SELLER_NAME || "Electrum Mauritius Limited",
      tradeName: process.env.SELLER_TRADE_NAME || "Electrum Mauritius Limited",
      tan: process.env.ONE_ITEM_SELLER_TAN || "11111111", // DIFFERENT TAN
      brn: process.env.SELLER_BRN || "C11106429",
      businessAddr: process.env.SELLER_ADDR || "Mauritius",
      businessPhoneNo: process.env.SELLER_PHONE || "2302909090",
      ebsCounterNo: process.env.EBS_COUNTER_NO || "",
      cashierId: invoiceData.cashier_id || "SYSTEM"
    };

    //---------------------------------------------------------------------
    // COMPUTE TOTALS LIKE ORIGINAL FILE
    //---------------------------------------------------------------------
    const totalVatAmount = vatAmt.toFixed(2);
    const totalAmtWoVat = amtWoVat.toFixed(2);
    const invoiceTotal = total.toFixed(2);
    const totalAmtPaid = invoiceTotal;

    //---------------------------------------------------------------------
    // BUILD FINAL MRA INVOICE JSON — EXACT MATCH WITH ORIGINAL
    //---------------------------------------------------------------------
    const mraInvoice = {
      invoiceCounter: String(invoice_id),
      transactionType: "B2C",
      personType: buyerTan ? "VATR" : "NVTR",
      invoiceTypeDesc: "STD",
      currency: invoiceData.currency_code || "MUR",
      invoiceIdentifier: String(invoice_number),
      invoiceRefIdentifier: invoiceData.reference_number || "",
      previousNoteHash: "0",
      totalVatAmount: totalVatAmount,
      totalAmtWoVatCur: totalAmtWoVat,
      totalAmtWoVatMur: totalAmtWoVat,
      invoiceTotal: invoiceTotal,
      discountTotalAmount: "0.00",
      totalAmtPaid: totalAmtPaid,
      dateTimeInvoiceIssued: dateTimeInvoiceIssued,
      seller,
      buyer: {
        name: buyerName,
        tan: buyerTan,
        brn: buyerBrn,
        businessAddr: billing.address || "",
        buyerType: buyerTan ? "VATR" : "NVTR",
        nic: invoiceData.nic || ""
      },
      itemList: mraItems,
      salesTransactions: invoiceData.salesTransactions || "CASH"
    };

    //---------------------------------------------------------------------
    // ENCRYPTION FLOW — EXACTLY SAME AS ORIGINAL mra-process.js
    //---------------------------------------------------------------------
    const aesKey = generateAesKey();
    const rsaPayload = {
      username: process.env.MRA_USERNAME,
      password: process.env.MRA_PASSWORD,
      encryptKey: aesKey,
      refreshToken: "false"
    };
    const rsaEncrypted = rsaEncryptPayload(rsaPayload);

    // TOKEN
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

    const encryptedInvoice = encryptInvoiceWithAes(
      JSON.stringify([mraInvoice]),
      finalAES
    );

    //---------------------------------------------------------------------
    // REQUEST DATETIME — EXACT COPY FROM ORIGINAL (VALID FORMAT)
    //---------------------------------------------------------------------
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const requestDateTime =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    //---------------------------------------------------------------------
    // TRANSMIT — EXACT COPY FROM ORIGINAL FILE
    //---------------------------------------------------------------------
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
        requestDateTime: requestDateTime,
        signedHash: "",
        encryptedInvoice
      })
    });

    const txText = await transmitResp.text();
    let txJson;
    try { txJson = JSON.parse(txText); }
    catch { txJson = { raw: txText }; }

    //---------------------------------------------------------------------
    // EXTRACT IRN
    //---------------------------------------------------------------------
    let irn = "";
    if (txJson.fiscalisedInvoices?.length > 0) {
      irn = txJson.fiscalisedInvoices[0].irn || "";
    }

    //---------------------------------------------------------------------
    // RESPONSE
    //---------------------------------------------------------------------
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
