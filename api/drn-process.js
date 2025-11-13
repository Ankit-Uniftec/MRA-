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

    //--------------------------------------------------------------------
    // Extract inputs
    //--------------------------------------------------------------------
    const { invoice_id, invoice_number, invoice_data } = req.body || {};

    if (!invoice_id || !invoice_number || !invoice_data) {
      return res.status(400).json({
        status: "ERROR",
        message: "Missing required fields: invoice_id, invoice_number, invoice_data",
      });
    }

    const parseMaybe = (v) => {
      if (!v) return v;
      if (typeof v === "string") {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    };

    const dn = parseMaybe(invoice_data);
    const lineItems = parseMaybe(dn.line_items);

    if (!Array.isArray(lineItems) || lineItems.length !== 1) {
      return res.status(400).json({
        status: "ERROR",
        message: "Debit Note must contain exactly ONE line item.",
      });
    }

    //--------------------------------------------------------------------
    // DATE FORMATTER
    //--------------------------------------------------------------------
    const toMraDate = (iso) => {
      const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
      if (m)
        return `${m[1].replace(/-/g, "")} ${m[2]}`;
      const d = new Date(iso);
      const pad = (x) => ("" + x).padStart(2, "0");
      return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const dateTimeInvoiceIssued = toMraDate(dn.created_time);

    //--------------------------------------------------------------------
    // TAX / NUMBER HELPERS
    //--------------------------------------------------------------------
    const num = (v) => Number(String(v).replace(/[^0-9.\-]/g,"")) || 0;

    const detectTaxCode = (item) => {
      const t = item.line_item_taxes?.[0];
      if (!t) return "TC04";
      if (t.tax_percentage == 15) return "TC01";
      if (t.tax_percentage == 0) return "TC02";
      return "TC04";
    };

    //--------------------------------------------------------------------
    // COMPUTE ITEM LIST (one-item only)
    //--------------------------------------------------------------------
    const it = lineItems[0];

    const qty = num(it.quantity || 1);
    const price = num(it.rate || 0);
    const itemTotal = num(it.item_total || qty * price);
    const tax = it.line_item_taxes?.length ? num(it.line_item_taxes[0].tax_amount) : 0;

    const itemObj = {
      itemNo: "1",
      taxCode: detectTaxCode(it),
      nature: "GOODS",
      currency: dn.currency_code || "MUR",
      itemDesc: it.description || it.name || "",
      quantity: String(qty),
      unitPrice: price.toFixed(2),
      discount: "0.00",
      discountedValue: itemTotal.toFixed(2),
      amtWoVatCur: (itemTotal - tax).toFixed(2),
      amtWoVatMur: (itemTotal - tax).toFixed(2),
      vatAmt: tax.toFixed(2),
      totalPrice: itemTotal.toFixed(2),
      productCodeOwn: it.item_id || ""
    };

    //--------------------------------------------------------------------
    // TOTALS
    //--------------------------------------------------------------------
    const totalNoVat = num(itemObj.amtWoVatCur);
    const totalVat = num(itemObj.vatAmt);
    const invoiceTotal = num(itemObj.totalPrice);

    //--------------------------------------------------------------------
    // IMPORTANT DRN FIELDS
    //--------------------------------------------------------------------
    const invoiceRefIdentifier =
      dn.invoiceRefIdentifier ||
      dn.reference_number ||
      dn.ref_invoice_number ||
      ""; // MUST be a valid previously fiscalised invoiceIdentifier

    //--------------------------------------------------------------------
    // SELLER & BUYER
    //--------------------------------------------------------------------
    const seller = {
      name: process.env.SELLER_NAME || "Electrum Mauritius Limited",
      tradeName: process.env.SELLER_TRADE_NAME || "Electrum Mauritius Limited",
      tan: process.env.SELLER_TAN || "11111111", // ⚠ DIFFERENT FROM USER TAN FOR TEST
      brn: process.env.SELLER_BRN || "C11106429",
      businessAddr: process.env.SELLER_ADDR || "Mauritius",
      businessPhoneNo: process.env.SELLER_PHONE || "2302909090",
      ebsCounterNo: process.env.EBS_COUNTER_NO || "",
      cashierId: dn.cashier_id || "SYSTEM",
    };

    const buyer = {
      name: dn.customer_name,
      tan: "",
      brn: "",
      businessAddr: "",
      buyerType: "NVTR",
      nic: dn.nic || ""
    };

    //--------------------------------------------------------------------
    // BUILD MRA JSON
    //--------------------------------------------------------------------
    const mraInvoice = {
      invoiceCounter: String(invoice_id),
      transactionType: "B2C",
      personType: "NVTR",
      invoiceTypeDesc: "DRN",
      invoiceIdentifier: invoice_number,
      invoiceRefIdentifier: invoiceRefIdentifier, // REQUIRED FOR DRN
      previousNoteHash: "0",
      reasonStated: dn.notes || "Correction / Debit Note",
      totalVatAmount: totalVat.toFixed(2),
      totalAmtWoVatCur: totalNoVat.toFixed(2),
      totalAmtWoVatMur: totalNoVat.toFixed(2),
      invoiceTotal: invoiceTotal.toFixed(2),
      discountTotalAmount: "0.00",
      totalAmtPaid: invoiceTotal.toFixed(2),
      dateTimeInvoiceIssued: dateTimeInvoiceIssued,
      seller,
      buyer,
      itemList: [itemObj],
      salesTransactions: "CASH"
    };

    //--------------------------------------------------------------------
    // AES Key
    //--------------------------------------------------------------------
    const aesKey = generateAesKey();

    //--------------------------------------------------------------------
    // RSA Encrypt Payload
    //--------------------------------------------------------------------
    const rsaPayload = {
      username: process.env.MRA_USERNAME,
      password: process.env.MRA_PASSWORD,
      encryptKey: aesKey,
      refreshToken: "false"
    };

    const rsaEncrypted = rsaEncryptPayload(rsaPayload);

    //--------------------------------------------------------------------
    // REQUEST TOKEN
    //--------------------------------------------------------------------
    const tokenResp = await fetch(process.env.MRA_TOKEN_URL || DEFAULTS.TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        username: process.env.MRA_USERNAME,
        ebsMraId: process.env.EBS_MRA_ID,
        areaCode: process.env.AREA_CODE
      },
      body: JSON.stringify({
        requestId: mraInvoice.invoiceIdentifier,
        payload: rsaEncrypted
      })
    });

    const tokenData = await tokenResp.json();

    const finalAES = decryptWithAes(tokenData.key, aesKey);

    //--------------------------------------------------------------------
    // Encrypt DRN Payload
    //--------------------------------------------------------------------
    const encryptedInvoice = encryptInvoiceWithAes(JSON.stringify([mraInvoice]), finalAES);

    //--------------------------------------------------------------------
    // TRANSMIT
    //--------------------------------------------------------------------
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dt = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const transmitResp = await fetch(process.env.MRA_TRANSMIT_URL || DEFAULTS.TRANSMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type":"application/json",
        username: process.env.MRA_USERNAME,
        ebsMraId: process.env.EBS_MRA_ID,
        areaCode: process.env.AREA_CODE,
        token: tokenData.token
      },
      body: JSON.stringify({
        requestId: mraInvoice.invoiceIdentifier,
        requestDateTime: dt,
        signedHash: "",
        encryptedInvoice: encryptedInvoice
      })
    });

    const transmitText = await transmitResp.text();
    let transmitData = {};
    try { transmitData = JSON.parse(transmitText); }
    catch { transmitData = { raw: transmitText }; }

    let irn = "";
    if (transmitData.fiscalisedInvoices?.length)
      irn = transmitData.fiscalisedInvoices[0].irn || "";

    //--------------------------------------------------------------------
    // SUCCESS RETURN
    //--------------------------------------------------------------------
    return res.status(200).json({
      status: "SUCCESS",
      IRN: irn,
      transmit_response: transmitData,
      preview_json: mraInvoice
    });

  } catch(err) {
    return res.status(500).json({
      status: "ERROR",
      message: err.message
    });
  }
}
