// // api/drn-process.js
// import crypto from "crypto";
// import { generateAesKey } from "./generate-aes.js";
// import { rsaEncryptPayload } from "./rsa-encrypt.js";
// import { decryptWithAes } from "./decrypt-aes.js";
// import { encryptInvoiceWithAes } from "./encrypt-invoice.js";

// const DEFAULTS = {
//   TOKEN_URL: "https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token",
//   TRANSMIT_URL: "https://vfisc.mra.mu/realtime/invoice/transmit",
// };

// export default async function handler(req, res) {
//   try {
//     if (req.method !== "POST") {
//       return res.status(405).json({ status: "ERROR", message: "POST required" });
//     }

//     //--------------------------------------------------------------------
//     // Extract inputs
//     //--------------------------------------------------------------------
//     const { invoice_id, invoice_number, invoice_data } = req.body || {};

//     if (!invoice_id || !invoice_number || !invoice_data) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Missing required fields: invoice_id, invoice_number, invoice_data",
//       });
//     }

//     const parseMaybe = (v) => {
//       if (!v) return v;
//       if (typeof v === "string") {
//         try { return JSON.parse(v); } catch { return v; }
//       }
//       return v;
//     };

//     const dn = parseMaybe(invoice_data);
//     const lineItems = parseMaybe(dn.line_items);

//     if (!Array.isArray(lineItems) || lineItems.length !== 1) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Debit Note must contain exactly ONE line item.",
//       });
//     }

//     //--------------------------------------------------------------------
//     // DATE FORMATTER
//     //--------------------------------------------------------------------
//     const toMraDate = (iso) => {
//       const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
//       if (m)
//         return `${m[1].replace(/-/g, "")} ${m[2]}`;
//       const d = new Date(iso);
//       const pad = (x) => ("" + x).padStart(2, "0");
//       return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
//     };

//     const dateTimeInvoiceIssued = toMraDate(dn.created_time);

//     //--------------------------------------------------------------------
//     // TAX / NUMBER HELPERS
//     //--------------------------------------------------------------------
//     const num = (v) => Number(String(v).replace(/[^0-9.\-]/g,"")) || 0;

//     const detectTaxCode = (item) => {
//       const t = item.line_item_taxes?.[0];
//       if (!t) return "TC04";
//       if (t.tax_percentage == 15) return "TC01";
//       if (t.tax_percentage == 0) return "TC02";
//       return "TC04";
//     };

//     //--------------------------------------------------------------------
//     // COMPUTE ITEM LIST (one-item only)
//     //--------------------------------------------------------------------
//     const it = lineItems[0];

//     const qty = num(it.quantity || 1);
//     const price = num(it.rate || 0);
//     const itemTotal = num(it.item_total || qty * price);
//     const tax = it.line_item_taxes?.length ? num(it.line_item_taxes[0].tax_amount) : 0;

//     const itemObj = {
//       itemNo: "1",
//       taxCode: detectTaxCode(it),
//       nature: "GOODS",
//       currency: dn.currency_code || "MUR",
//       itemDesc: it.description || it.name || "",
//       quantity: String(qty),
//       unitPrice: price.toFixed(2),
//       discount: "0.00",
//       discountedValue: itemTotal.toFixed(2),
//       amtWoVatCur: (itemTotal - tax).toFixed(2),
//       amtWoVatMur: (itemTotal - tax).toFixed(2),
//       vatAmt: tax.toFixed(2),
//       totalPrice: itemTotal.toFixed(2),
//       productCodeOwn: it.item_id || ""
//     };

//     //--------------------------------------------------------------------
//     // TOTALS
//     //--------------------------------------------------------------------
//     const totalNoVat = num(itemObj.amtWoVatCur);
//     const totalVat = num(itemObj.vatAmt);
//     const invoiceTotal = num(itemObj.totalPrice);

//     //--------------------------------------------------------------------
//     // IMPORTANT DRN FIELDS
//     //--------------------------------------------------------------------
//     const invoiceRefIdentifier =
//       dn.invoiceRefIdentifier ||
//       dn.reference_number ||
//       dn.ref_invoice_number ||
//       ""; // MUST be a valid previously fiscalised invoiceIdentifier

//     //--------------------------------------------------------------------
//     // SELLER & BUYER
//     //--------------------------------------------------------------------
//     const seller = {
//       name: process.env.SELLER_NAME || "Electrum Mauritius Limited",
//       tradeName: process.env.SELLER_TRADE_NAME || "Electrum Mauritius Limited",
//       tan: process.env.SELLER_TAN || "11111111", // ⚠ DIFFERENT FROM USER TAN FOR TEST
//       brn: process.env.SELLER_BRN || "C11106429",
//       businessAddr: process.env.SELLER_ADDR || "Mauritius",
//       businessPhoneNo: process.env.SELLER_PHONE || "2302909090",
//       ebsCounterNo: process.env.EBS_COUNTER_NO || "",
//       cashierId: dn.cashier_id || "SYSTEM",
//     };

//     const buyer = {
//       name: dn.customer_name,
//       tan: "",
//       brn: "",
//       businessAddr: "",
//       buyerType: "NVTR",
//       nic: dn.nic || ""
//     };

//     //--------------------------------------------------------------------
//     // BUILD MRA JSON
//     //--------------------------------------------------------------------
//     const mraInvoice = {
//       invoiceCounter: String(invoice_id),
//       transactionType: "B2C",
//       personType: "NVTR",
//       invoiceTypeDesc: "DRN",
//       invoiceIdentifier: invoice_number,
//       invoiceRefIdentifier: invoiceRefIdentifier, // REQUIRED FOR DRN
//       previousNoteHash: "0",
//       reasonStated: dn.notes || "Correction / Debit Note",
//       totalVatAmount: totalVat.toFixed(2),
//       totalAmtWoVatCur: totalNoVat.toFixed(2),
//       totalAmtWoVatMur: totalNoVat.toFixed(2),
//       invoiceTotal: invoiceTotal.toFixed(2),
//       discountTotalAmount: "0.00",
//       totalAmtPaid: invoiceTotal.toFixed(2),
//       dateTimeInvoiceIssued: dateTimeInvoiceIssued,
//       seller,
//       buyer,
//       itemList: [itemObj],
//       salesTransactions: "CASH"
//     };

//     //--------------------------------------------------------------------
//     // AES Key
//     //--------------------------------------------------------------------
//     const aesKey = generateAesKey();

//     //--------------------------------------------------------------------
//     // RSA Encrypt Payload
//     //--------------------------------------------------------------------
//     const rsaPayload = {
//       username: process.env.MRA_USERNAME,
//       password: process.env.MRA_PASSWORD,
//       encryptKey: aesKey,
//       refreshToken: "false"
//     };

//     const rsaEncrypted = rsaEncryptPayload(rsaPayload);

//     //--------------------------------------------------------------------
//     // REQUEST TOKEN
//     //--------------------------------------------------------------------
//     const tokenResp = await fetch(process.env.MRA_TOKEN_URL || DEFAULTS.TOKEN_URL, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         username: process.env.MRA_USERNAME,
//         ebsMraId: process.env.EBS_MRA_ID,
//         areaCode: process.env.AREA_CODE
//       },
//       body: JSON.stringify({
//         requestId: mraInvoice.invoiceIdentifier,
//         payload: rsaEncrypted
//       })
//     });

//     const tokenData = await tokenResp.json();

//     const finalAES = decryptWithAes(tokenData.key, aesKey);

//     //--------------------------------------------------------------------
//     // Encrypt DRN Payload
//     //--------------------------------------------------------------------
//     const encryptedInvoice = encryptInvoiceWithAes(JSON.stringify([mraInvoice]), finalAES);

//     //--------------------------------------------------------------------
//     // TRANSMIT
//     //--------------------------------------------------------------------
//     const now = new Date();
//     const pad = (n) => String(n).padStart(2, "0");
//     const dt = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

//     const transmitResp = await fetch(process.env.MRA_TRANSMIT_URL || DEFAULTS.TRANSMIT_URL, {
//       method: "POST",
//       headers: {
//         "Content-Type":"application/json",
//         username: process.env.MRA_USERNAME,
//         ebsMraId: process.env.EBS_MRA_ID,
//         areaCode: process.env.AREA_CODE,
//         token: tokenData.token
//       },
//       body: JSON.stringify({
//         requestId: mraInvoice.invoiceIdentifier,
//         requestDateTime: dt,
//         signedHash: "",
//         encryptedInvoice: encryptedInvoice
//       })
//     });

//     const transmitText = await transmitResp.text();
//     let transmitData = {};
//     try { transmitData = JSON.parse(transmitText); }
//     catch { transmitData = { raw: transmitText }; }

//     let irn = "";
//     if (transmitData.fiscalisedInvoices?.length)
//       irn = transmitData.fiscalisedInvoices[0].irn || "";

//     //--------------------------------------------------------------------
//     // SUCCESS RETURN
//     //--------------------------------------------------------------------
//     return res.status(200).json({
//       status: "SUCCESS",
//       IRN: irn,
//       transmit_response: transmitData,
//       preview_json: mraInvoice
//     });

//   } catch(err) {
//     return res.status(500).json({
//       status: "ERROR",
//       message: err.message
//     });
//   }
// }


// api/drn-process.js
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
      return res.status(405).json({ status: "ERROR", message: "POST required" });
    }

    // --- input
    const { invoice_id, invoice_number, invoice_data } = req.body || {};
    if (!invoice_id || !invoice_number || !invoice_data) {
      return res.status(400).json({ status: "ERROR", message: "Missing invoice_id, invoice_number or invoice_data" });
    }

    const parseMaybe = (v) => {
      if (v === undefined || v === null) return v;
      if (typeof v === "string") {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    };

    const dn = parseMaybe(invoice_data);

    // --- line items (must be exactly 1)
    const lineItems = parseMaybe(dn.line_items);
    if (!Array.isArray(lineItems) || lineItems.length !== 1) {
      return res.status(400).json({
        status: "ERROR",
        message: "Debit Note must contain exactly ONE line item."
      });
    }

    // --- determine currency (top-level field required by MRA)
    const currency = dn.currency_code || dn.currency || process.env.DEFAULT_CURRENCY || "MUR";
    if (!currency) {
      return res.status(400).json({ status: "ERROR", message: "Missing currency (invoice_data.currency_code)" });
    }

    // --- determine invoiceRefIdentifier (required for DRN)
    // try multiple common places Zoho may store reference invoice
    let invoiceRefIdentifier = "";
    if (dn.invoiceRefIdentifier) invoiceRefIdentifier = dn.invoiceRefIdentifier;
    if (!invoiceRefIdentifier && dn.reference_invoice && typeof dn.reference_invoice === "object") {
      invoiceRefIdentifier = dn.reference_invoice.reference_invoice_number || dn.reference_invoice.reference_invoice_id || "";
    }
    if (!invoiceRefIdentifier && dn.reference_number) invoiceRefIdentifier = dn.reference_number;
    if (!invoiceRefIdentifier && dn.ref_invoice_number) invoiceRefIdentifier = dn.ref_invoice_number;

    if (!invoiceRefIdentifier || String(invoiceRefIdentifier).trim() === "") {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing invoiceRefIdentifier. For DRN you must reference a previously fiscalised invoice identifier (invoiceIdentifier)."
      });
    }

    // --- helper funcs
    const toMraDate = (iso) => {
      const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
      if (m) return `${m[1].replace(/-/g, "")} ${m[2]}`;
      const d = new Date(iso);
      const pad = (x) => String(x).padStart(2, "0");
      return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const num = (v) => Number(String(v || "0").replace(/[^0-9.\-]/g, "")) || 0;

    // --- build single item
    const it = lineItems[0];
    const qty = num(it.quantity || 1);
    const price = num(it.rate || it.sales_rate || 0);
    const itemTotal = num(it.item_total || qty * price);
    const taxAmt = (Array.isArray(it.line_item_taxes) && it.line_item_taxes.length > 0) ? num(it.line_item_taxes[0].tax_amount) : 0;
    const amtWoVat = Number((itemTotal - taxAmt).toFixed(2));

    const detectTaxCode = (item) => {
      const t = item.line_item_taxes?.[0];
      if (!t) return "TC04";
      const p = num(t.tax_percentage);
      if (p === 15) return "TC01";
      if (p === 0) return "TC02";
      return "TC04";
    };

    const itemObj = {
      itemNo: "1",
      taxCode: detectTaxCode(it),
      nature: "GOODS",
      currency: currency,
      itemDesc: it.description || it.name || "",
      quantity: String(qty),
      unitPrice: price.toFixed(2),
      discount: "0.00",
      discountedValue: itemTotal.toFixed(2),
      amtWoVatCur: amtWoVat.toFixed(2),
      amtWoVatMur: amtWoVat.toFixed(2),
      vatAmt: taxAmt.toFixed(2),
      totalPrice: itemTotal.toFixed(2),
      productCodeOwn: it.item_id || ""
    };

    // --- totals
    const totalVat = num(itemObj.vatAmt);
    const totalAmtWoVatCur = num(itemObj.amtWoVatCur);
    const invoiceTotal = num(itemObj.totalPrice);

    // --- date
    const created = dn.created_time || dn.date_time || dn.date || new Date().toISOString();
    const dateTimeInvoiceIssued = toMraDate(created);

    // --- seller / buyer
    const seller = {
      name: process.env.SELLER_NAME || "Electrum Mauritius Limited",
      tradeName: process.env.SELLER_TRADE_NAME || process.env.SELLER_NAME || "Electrum Mauritius Limited",
      tan: process.env.SELLER_TAN || "27124193",
      brn: process.env.SELLER_BRN || "C11106429",
      businessAddr: process.env.SELLER_ADDR || "Mauritius",
      businessPhoneNo: process.env.SELLER_PHONE || "2302909090",
      ebsCounterNo: process.env.EBS_COUNTER_NO || "",
      cashierId: dn.cashier_id || "SYSTEM"
    };

    const buyer = {
      name: dn.customer_name || "",
      tan: dn.cf_vat || dn.cf_tan || dn.tan || "",
      brn: dn.cf_brn || dn.cf_brn_number || dn.brn || "",
      businessAddr: (dn.billing_address && typeof dn.billing_address === "object") ? (dn.billing_address.address || "") : "",
      buyerType: buyerType = (dn.cf_vat || dn.cf_tan || dn.tan) ? "VATR" : "NVTR",
      nic: dn.nic || ""
    };

    // --- build mra DRN invoice (includes currency top-level)
    const mraInvoice = {
      invoiceCounter: String(invoice_id),
      transactionType: dn.transactionType || "B2C",
      personType: buyer.buyerType || "NVTR",
      invoiceTypeDesc: "DRN",
      currency: currency, // <-- REQUIRED
      invoiceIdentifier: String(invoice_number),
      invoiceRefIdentifier: String(invoiceRefIdentifier), // <-- REQUIRED for DRN/CRN
      previousNoteHash: "0",
      reasonStated: dn.notes || dn.reason_for_debit_note || "Debit Note",
      totalVatAmount: totalVat.toFixed(2),
      totalAmtWoVatCur: totalAmtWoVatCur.toFixed(2),
      totalAmtWoVatMur: totalAmtWoVatCur.toFixed(2),
      invoiceTotal: invoiceTotal.toFixed(2),
      discountTotalAmount: "0.00",
      totalAmtPaid: invoiceTotal.toFixed(2),
      dateTimeInvoiceIssued: dateTimeInvoiceIssued,
      seller,
      buyer,
      itemList: [itemObj],
      salesTransactions: dn.salesTransactions || "CASH"
    };

    // --- encryption flow (same as mra-process)
    const aesKey = generateAesKey();
    const rsaPayload = {
      username: process.env.MRA_USERNAME,
      password: process.env.MRA_PASSWORD,
      encryptKey: aesKey,
      refreshToken: "false"
    };
    const rsaEncrypted = rsaEncryptPayload(rsaPayload);

    const tokenResp = await fetch(process.env.MRA_TOKEN_URL || DEFAULTS.TOKEN_URL, {
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

    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      return res.status(500).json({ status: "ERROR", message: "Token endpoint error", detail: t });
    }

    const tokenData = await tokenResp.json();
    if (!tokenData || !tokenData.token || !tokenData.key) {
      return res.status(500).json({ status: "ERROR", message: "Token generation failed", detail: tokenData });
    }

    const finalAES = decryptWithAes(tokenData.key, aesKey);
    if (!finalAES) return res.status(500).json({ status: "ERROR", message: "Failed to decrypt AES key from token" });

    const encryptedInvoice = encryptInvoiceWithAes(JSON.stringify([mraInvoice]), finalAES);

    // --- requestDateTime (same format as working endpoints)
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const requestDateTime = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const transmitResp = await fetch(process.env.MRA_TRANSMIT_URL || DEFAULTS.TRANSMIT_URL, {
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
        encryptedInvoice: encryptedInvoice
      })
    });

    const transmitText = await transmitResp.text();
    let transmitData = {};
    try { transmitData = JSON.parse(transmitText); } catch { transmitData = { raw: transmitText }; }

    let irn = "";
    if (transmitData.fiscalisedInvoices && transmitData.fiscalisedInvoices.length > 0) {
      irn = transmitData.fiscalisedInvoices[0].irn || "";
    }

    return res.status(200).json({
      status: "SUCCESS",
      IRN: irn,
      transmit_response: transmitData,
      preview_json: mraInvoice
    });

  } catch (err) {
    console.error("DRN Process Error:", err && (err.stack || err.message || err));
    return res.status(500).json({ status: "ERROR", message: err.message || String(err) });
  }
}
