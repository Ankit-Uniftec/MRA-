// // api/mra-process.js
// export default async function handler(req, res) {
//   try {
//     if (req.method !== "POST") {
//       return res.status(405).json({ status: "ERROR", message: "Method not allowed (use POST)" });
//     }

//     console.log("=== MRA eInvoice Process Started ===");

//     // Accept invoice_data as object or stringified JSON
//     const { invoice_id, invoice_number, invoice_data } = req.body || {};

//     if (!invoice_id || !invoice_number || (invoice_data === undefined || invoice_data === null)) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Missing required body fields: invoice_id, invoice_number, invoice_data"
//       });
//     }

//     // helper to parse strings which may contain JSON
//     const parseMaybeString = (v) => {
//       if (v === null || v === undefined) return null;
//       if (typeof v === "object") return v;
//       if (typeof v === "string") {
//         try {
//           return JSON.parse(v);
//         } catch (e) {
//           // not valid JSON string -> return original string
//           return v;
//         }
//       }
//       return v;
//     };

//     // Parse invoice_data if it was sent as a JSON-string
//     let invoiceData = parseMaybeString(invoice_data);
//     if (!invoiceData || typeof invoiceData !== "object") {
//       // invoice_data must be an object after parsing
//       return res.status(400).json({
//         status: "ERROR",
//         message: "invoice_data must be a JSON object (or JSON-string). Received: " + typeof invoice_data
//       });
//     }

//     // ========================
//     // REQUIRED FIELD VALIDATION (no fallbacks)
//     // ========================
//     // 1) Date/time of invoice: require created_time (ISO) or a field that includes time.
//     const createdTimeRaw = invoiceData.created_time || invoiceData.date_time || invoiceData.date;
//     if (!createdTimeRaw) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Missing required invoice date/time. Provide invoice_data.created_time (ISO with time) e.g. 2025-09-15T12:00:00+0400"
//       });
//     }

//     // helper to convert a datetime string (with T and hh:mm:ss) into yyyyMMdd HH:mm:ss
//     const toMraDate = (dtStr) => {
//       if (!dtStr || typeof dtStr !== "string") {
//         throw new Error("Invalid datetime string");
//       }
//       // Prefer to extract YYYY-MM-DD and HH:MM:SS from ISO-like strings to preserve original local time
//       const isoMatch = dtStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
//       if (isoMatch) {
//         return `${isoMatch[1].replace(/-/g, "")} ${isoMatch[2]}`; // yyyyMMdd HH:mm:ss
//       }
//       // If not ISO-like, attempt Date parse and convert (note: this normalizes timezone)
//       const d = new Date(dtStr);
//       if (isNaN(d.getTime())) {
//         throw new Error("Invalid invoice date/time format. Provide ISO datetime (e.g. 2025-09-15T12:00:00+0400)");
//       }
//       const pad = (n) => String(n).padStart(2, "0");
//       return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
//     };

//     let dateTimeInvoiceIssued;
//     try {
//       dateTimeInvoiceIssued = toMraDate(createdTimeRaw);
//     } catch (err) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Invalid invoice date/time: " + err.message
//       });
//     }

//     // 2) line_items must exist and be a non-empty array (Zoho sends as JSON-string)
//     const rawLineItems = invoiceData.line_items;
//     if (!rawLineItems) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Missing required invoice_data.line_items (Zoho returns this as a JSON-string)."
//       });
//     }
//     let lineItemsParsed = parseMaybeString(rawLineItems);
//     if (!Array.isArray(lineItemsParsed)) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "invoice_data.line_items is not a JSON array. Ensure Zoho line_items is passed correctly as JSON or JSON-string."
//       });
//     }
//     if (lineItemsParsed.length === 0) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Invoice must contain at least one line item."
//       });
//     }

//     // 3) Buyer required fields: customer_name and custom fields cf_vat and cf_brn (per your note)
//     if (!invoiceData.customer_name || typeof invoiceData.customer_name !== "string" || invoiceData.customer_name.trim() === "") {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Missing required buyer name: invoice_data.customer_name"
//       });
//     }
//     // API custom field names you indicated: cf_vat (TAN) and cf_brn (BRN)
//     const buyerTan = invoiceData.cf_vat;
//     const buyerBrn = invoiceData.cf_brn;
//     if (!buyerTan || !buyerBrn) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Missing buyer custom fields: invoice_data.cf_vat (TAN) and/or invoice_data.cf_brn (BRN). These are required — do not leave blank."
//       });
//     }

//     // Parse billing_address if present (Zoho passes this as a JSON-string)
//     let billingObj = {};
//     if (invoiceData.billing_address) {
//       const parsed = parseMaybeString(invoiceData.billing_address);
//       if (typeof parsed === "object") billingObj = parsed;
//       else billingObj = {};
//     }

//     // ========================
//     // 🔹 Config (unchanged)
//     // ========================
//     const MRA_USERNAME = "Electrum";
//     const MRA_PASSWORD = "Electrum@2025mra";
//     const EBS_MRA_ID = "17532654219210HODNOBG13W"; // kept for token header; seller.ebsCounterNo left blank per instruction
//     const AREA_CODE = "721";
//     const BASE_URL = process.env.BASE_URL || "https://mra-encrypt-omega.vercel.app";

//     const RSA_URL = `${BASE_URL}/api/rsa-encrypt`;
//     const AES_URL = `${BASE_URL}/api/generate-aes`;
//     const DECRYPT_URL = `${BASE_URL}/api/decrypt-aes`;
//     const ENCRYPT_INV = `${BASE_URL}/api/encrypt-invoice`;
//     const TOKEN_URL = "https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token";
//     const TRANSMIT_URL = "https://vfisc.mra.mu/realtime/invoice/transmit";

//     // ========================
//     // 🔹 MAP ITEMS -> MRA itemList
//     // ========================
//     const mraItems = lineItemsParsed.map((item, idx) => {
//       const qty = Number(item.quantity || item.qty || 1);
//       const rate = Number(item.rate || item.unit_price || item.sales_rate || 0);
//       const itemTotal = Number(item.item_total != null ? item.item_total : (qty * rate));
//       // detect VAT from first tax if present
//       let taxAmt = 0;
//       let taxCode = "TC02";
//       if (item.line_item_taxes && Array.isArray(item.line_item_taxes) && item.line_item_taxes.length > 0) {
//         const firstTax = item.line_item_taxes[0];
//         taxAmt = Number(firstTax.tax_amount || 0);
//         const taxName = (firstTax.tax_name || "").toString().toUpperCase();
//         if (taxName.includes("VAT")) taxCode = "TC01";
//       }
//       return {
//         itemNo: String(idx + 1),
//         taxCode: taxCode,
//         nature: "GOODS",
//         currency: invoiceData.currency_code || "MUR",
//         itemDesc: item.name || item.item_description || "",
//         quantity: String(qty),
//         unitPrice: String(Number(rate).toFixed(2)),
//         discount: String(item.discount_amount || 0),
//         discountedValue: String(Number(item.discounted_value || item.discountedValue || item.item_total || itemTotal).toFixed(2)),
//         amtWoVatCur: String(Number(itemTotal).toFixed(2)),
//         amtWoVatMur: String(Number(itemTotal).toFixed(2)),
//         vatAmt: String(Number(taxAmt).toFixed(2)),
//         totalPrice: String(Number(itemTotal + Number(taxAmt)).toFixed(2)),
//         productCodeOwn: item.item_id || item.product_code || ""
//       };
//     });

//     // ========================
//     // 🔹 BUILD MRA Invoice JSON (no fallbacks for required)
//     // ========================
//     const mraInvoice = {
//       invoiceCounter: String(invoice_id),
//       transactionType: "B2C",
//       personType: "VATR",
//       invoiceTypeDesc: "STD",
//       currency: invoiceData.currency_code || "MUR",
//       invoiceIdentifier: `INV-${invoice_number}`,
//       invoiceRefIdentifier: "",
//       previousNoteHash: "0",
//       totalVatAmount: String(Number(invoiceData.tax_total || 0).toFixed(2)),
//       totalAmtWoVatCur: String(Number(invoiceData.sub_total || 0).toFixed(2)),
//       totalAmtWoVatMur: String(Number(invoiceData.sub_total || 0).toFixed(2)),
//       invoiceTotal: String(Number(invoiceData.total || 0).toFixed(2)),
//       discountTotalAmount: String(Number(invoiceData.discount || 0).toFixed(2)),
//       totalAmtPaid: String(Number(invoiceData.total || 0).toFixed(2)),
//       dateTimeInvoiceIssued: dateTimeInvoiceIssued, // already validated format yyyyMMdd HH:mm:ss
//       seller: {
//         name: "Electrum Mauritius Limited",
//         tradeName: "Electrum Mauritius Limited",
//         tan: "27124193",
//         brn: "C11106429",
//         businessAddr: "Mauritius",
//         businessPhoneNo: "2302909090",
//         ebsCounterNo: "", // left blank on purpose per instruction
//         cashierId: "SYSTEM"
//       },
//       buyer: {
//         name: invoiceData.customer_name,
//         tan: String(buyerTan),
//         brn: String(buyerBrn),
//         businessAddr: (billingObj && billingObj.address) ? String(billingObj.address) : "",
//         buyerType: "VATR",
//         nic: invoiceData.nic || ""
//       },
//       itemList: mraItems,
//       salesTransactions: "CASH"
//     };

//     console.log("Invoice JSON ready for encryption:", JSON.stringify(mraInvoice));

//     // ========================
//     // 🔹 STEP 1: AES
//     // ========================
//     console.log("Step 1: requesting AES key from middleware:", AES_URL);
//     const aesResp = await fetch(AES_URL, { method: "GET" });
//     const aesData = await aesResp.json();
//     console.log("AES Response:", JSON.stringify(aesData));
//     if (!aesData || !aesData.aesKey) {
//       return res.status(500).json({ status: "ERROR", message: "AES generation failed", detail: aesData });
//     }
//     const aesKey = aesData.aesKey;

//     // ========================
//     // 🔹 STEP 2: RSA (encrypt AES key)
//     // ========================
//     console.log("Step 2: RSA encrypt AES key");
//     const rsaResp = await fetch(RSA_URL, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         payload: {
//           username: MRA_USERNAME,
//           password: MRA_PASSWORD,
//           encryptKey: aesKey,
//           refreshToken: "false"
//         }
//       })
//     });
//     const rsaData = await rsaResp.json();
//     console.log("RSA Response:", JSON.stringify(rsaData));
//     const rsaEncrypted = rsaData && (rsaData.encrypted || rsaData.encryptedAES || rsaData.encryptedKey || rsaData.encryptedText);
//     if (!rsaEncrypted) {
//       return res.status(500).json({ status: "ERROR", message: "RSA encryption failed", detail: rsaData });
//     }

//     // ========================
//     // 🔹 STEP 3: Token generation
//     // ========================
//     console.log("Step 3: Token request to MRA token endpoint");
//     // create requestId same as invoiceIdentifier
//     const requestId = mraInvoice.invoiceIdentifier;
//     const tokenResp = await fetch(TOKEN_URL, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         username: MRA_USERNAME,
//         ebsMraId: EBS_MRA_ID,
//         areaCode: AREA_CODE
//       },
//       body: JSON.stringify({
//         requestId: requestId,
//         payload: rsaEncrypted
//       })
//     });
//     const tokenData = await tokenResp.json();
//     console.log("Token Response:", JSON.stringify(tokenData));
//     if (!tokenData || !tokenData.token) {
//       return res.status(500).json({ status: "ERROR", message: "Token generation failed", detail: tokenData });
//     }
//     const token = tokenData.token;
//     const encKey = tokenData.key;

//     // ========================
//     // 🔹 STEP 4: Decrypt AES (middleware)
//     // ========================
//     console.log("Step 4: Decrypt AES from token response");
//     const decResp = await fetch(DECRYPT_URL, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         encryptedKey: encKey,
//         aesKey: aesKey
//       })
//     });
//     const decData = await decResp.json();
//     console.log("Decrypt Response:", JSON.stringify(decData));
//     const finalAES = decData && (decData.decryptedKey || decData.decrypted || decData.key);
//     if (!finalAES) {
//       return res.status(500).json({ status: "ERROR", message: "AES decrypt failed", detail: decData });
//     }

//     // ========================
//     // 🔹 STEP 5: Encrypt invoice payload
//     // ========================
//     console.log("Step 5: Encrypting invoice payload via middleware");
//     const encInvoiceResp = await fetch(ENCRYPT_INV, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         plainText: JSON.stringify([mraInvoice]), // must be an array in the plainText
//         aesKey: finalAES
//       })
//     });
//     const encInvoiceData = await encInvoiceResp.json();
//     console.log("Encrypt Invoice Response:", JSON.stringify(encInvoiceData));
//     const encryptedInvoice = encInvoiceData && (encInvoiceData.encryptedText || encInvoiceData.encrypted);
//     if (!encryptedInvoice) {
//       return res.status(500).json({
//         status: "ERROR",
//         message: "Encrypt-invoice failed (encrypted payload empty)",
//         detail: encInvoiceData
//       });
//     }

//     // ========================
//     // 🔹 STEP 6: Transmit to MRA
//     // ========================
//     // requestDateTime must be yyyyMMdd HH:mm:ss (17 chars)
//     const pad = (n) => String(n).padStart(2, "0");
//     const now = new Date();
//     const requestDateTime = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

//     console.log("Step 6: Transmitting to MRA realtime API. requestDateTime:", requestDateTime);

//     const transmitResp = await fetch(TRANSMIT_URL, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         username: MRA_USERNAME,
//         ebsMraId: EBS_MRA_ID,
//         areaCode: AREA_CODE,
//         token: token
//       },
//       body: JSON.stringify({
//         requestId: requestId,
//         requestDateTime: requestDateTime,
//         signedHash: "",
//         encryptedInvoice: encryptedInvoice
//       })
//     });

//     const transmitData = await transmitResp.json();
//     console.log("Transmit Response:", JSON.stringify(transmitData));

//     // Extract IRN if present
//     let irn = "";
//     if (transmitData && Array.isArray(transmitData.fiscalisedInvoices) && transmitData.fiscalisedInvoices.length > 0) {
//       irn = transmitData.fiscalisedInvoices[0].irn || "";
//     }

//     return res.status(200).json({
//       status: "SUCCESS",
//       IRN: irn,
//       transmit_response: transmitData,
//       preview_json: mraInvoice
//     });

//   } catch (err) {
//     console.error("MRA Process Error:", err && (err.stack || err.message || err));
//     return res.status(500).json({
//       status: "ERROR",
//       message: err.message || String(err)
//     });
//   }
// }







// New updated code :---------------------------------------------------------------
// api/mra-process.js
// import crypto from "crypto";

// /**
//  * Full MRA mapping and invoice-building middleware for Zoho Books input.
//  * Replaces prior mra-process.js with more robust mapping, totals calculation,
//  * tax-code detection, previousNoteHash calculation, and defensive validation.
//  *
//  * Assumptions:
//  * - Input body contains: invoice_id, invoice_number, invoice_data (object or JSON-string)
//  * - Zoho's invoice_data.line_items is usually a JSON-string -> parsed here
//  *
//  * NOTE: keep MRA credentials & EBS config in environment variables for production.
//  */

// export default async function handler(req, res) {
//   try {
//     if (req.method !== "POST") {
//       return res.status(405).json({ status: "ERROR", message: "Method not allowed (use POST)" });
//     }

//     const { invoice_id, invoice_number, invoice_data } = req.body || {};

//     if (!invoice_id || !invoice_number || (invoice_data === undefined || invoice_data === null)) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Missing required body fields: invoice_id, invoice_number, invoice_data"
//       });
//     }

//     const parseMaybeString = (v) => {
//       if (v === null || v === undefined) return null;
//       if (typeof v === "object") return v;
//       if (typeof v === "string") {
//         try {
//           return JSON.parse(v);
//         } catch (e) {
//           // Not JSON -> return original string
//           return v;
//         }
//       }
//       return v;
//     };

//     // Parse invoice data (may be JSON-string from Zoho)
//     const invoiceData = parseMaybeString(invoice_data);
//     if (!invoiceData || typeof invoiceData !== "object") {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "invoice_data must be a JSON object (or JSON-string). Received: " + typeof invoice_data
//       });
//     }

//     // 1) --- Required base field validation ---
//     const createdTimeRaw = invoiceData.created_time || invoiceData.date_time || invoiceData.date;
//     if (!createdTimeRaw) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Missing required invoice date/time. Provide invoice_data.created_time (ISO with time) e.g. 2025-09-15T12:00:00+0400"
//       });
//     }

//     const toMraDate = (dtStr) => {
//       if (!dtStr || typeof dtStr !== "string") {
//         throw new Error("Invalid datetime string");
//       }
//       const isoMatch = dtStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
//       if (isoMatch) {
//         return `${isoMatch[1].replace(/-/g, "")} ${isoMatch[2]}`; // yyyyMMdd HH:mm:ss
//       }
//       const d = new Date(dtStr);
//       if (isNaN(d.getTime())) {
//         throw new Error("Invalid invoice date/time format. Provide ISO datetime (e.g. 2025-09-15T12:00:00+0400)");
//       }
//       const pad = (n) => String(n).padStart(2, "0");
//       return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
//     };

//     let dateTimeInvoiceIssued;
//     try {
//       dateTimeInvoiceIssued = toMraDate(createdTimeRaw);
//     } catch (err) {
//       return res.status(400).json({ status: "ERROR", message: "Invalid invoice date/time: " + err.message });
//     }

//     // Parse line_items (Zoho often sends this as a JSON-string)
//     if (!invoiceData.line_items) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Missing required invoice_data.line_items (Zoho returns this as a JSON-string)."
//       });
//     }
//     const rawLineItems = parseMaybeString(invoiceData.line_items);
//     if (!Array.isArray(rawLineItems)) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "invoice_data.line_items is not a JSON array. Ensure Zoho line_items is passed correctly as JSON or JSON-string."
//       });
//     }
//     if (rawLineItems.length === 0) {
//       return res.status(400).json({
//         status: "ERROR",
//         message: "Invoice must contain at least one line item."
//       });
//     }

//     // Buyer required fields: enforce presence of TAN & BRN custom fields (cf_vat, cf_brn) if you need VATR
//     const buyerName = invoiceData.customer_name;
//     const buyerTan = invoiceData.cf_vat || invoiceData.cf_tan || invoiceData.tan || null;
//     const buyerBrn = invoiceData.cf_brn || invoiceData.cf_brn_number || invoiceData.brn || null;

//     if (!buyerName) {
//       return res.status(400).json({ status: "ERROR", message: "Missing required buyer name: invoice_data.customer_name" });
//     }
//     // For VAT-registered buyers MRA expects TAN; for B2C it can be blank. We'll accept both but will set personType accordingly.
//     // If your business policy requires TAN/BRN, uncomment the following validation:
//     // if (!buyerTan || !buyerBrn) { ... }

//     // Billing address - Zoho sends as JSON-string
//     let billingObj = {};
//     if (invoiceData.billing_address) {
//       const parsed = parseMaybeString(invoiceData.billing_address);
//       if (typeof parsed === "object") billingObj = parsed;
//     }

//     // -----------------------------
//     // Helper functions
//     // -----------------------------
//     const numeric = (v) => {
//       if (v === null || v === undefined || v === "") return 0;
//       return Number(String(v).replace(/[^0-9.\-]+/g, "")) || 0;
//     };

//     const detectTaxCode = (item) => {
//       // Map tax percentage or tax_name to MRA tax codes (TC01..TC05).
//       // This mapping should be adjusted to match your MRA classification.
//       // Common mapping used here:
//       // - VAT 15%  => TC01 (standard VAT)
//       // - VAT 0%   => TC02 (zero-rated)
//       // - Exempt   => TC03 (exempt) -- if detect "EXEMPT"
//       // - Other    => TC04/TC05 as fallback
//       const taxes = item.line_item_taxes || [];
//       if (Array.isArray(taxes) && taxes.length > 0) {
//         // Prefer explicit tax_percentage if provided
//         const first = taxes[0];
//         const pct = numeric(first.tax_percentage ?? first.tax_percentage ?? first.tax_percentage);
//         const name = (first.tax_name || "").toString().toUpperCase();
//         if (pct === 15 || name.includes("15")) return "TC01";
//         if (pct === 0 || name.includes("VAT 0") || name.includes("(0%)")) return "TC02";
//         if (name.includes("EXEMPT")) return "TC03";
//         // fallback: if name contains 'VAT' assume standard
//         if (name.includes("VAT")) return "TC01";
//       }
//       // If Zoho provides tax_percentage at item-level (rare)
//       if (typeof item.tax_percentage !== "undefined") {
//         const p = numeric(item.tax_percentage);
//         if (p === 15) return "TC01";
//         if (p === 0) return "TC02";
//       }
//       // default fallback
//       return "TC04";
//     };

//     // Build MRA itemList with careful numeric formatting
//     const mraItems = rawLineItems.map((it, idx) => {
//       const quantity = numeric(it.quantity || it.qty || 1);
//       const unitPrice = numeric(it.rate || it.sales_rate || it.rate_formatted || it.unit_price || 0);
//       const itemTotalFromZoho = numeric(it.item_total || it.item_total_formatted || it.amount || it.total || (quantity * unitPrice));
//       // Try to find tax amount from Zoho's tax array
//       let taxAmt = 0;
//       if (Array.isArray(it.line_item_taxes) && it.line_item_taxes.length > 0) {
//         // Sum all tax_amount entries (Zoho can have multiple)
//         taxAmt = it.line_item_taxes.reduce((s, t) => s + numeric(t.tax_amount || t.tax_amount_formatted || 0), 0);
//       } else if (typeof it.tax_amount !== "undefined") {
//         taxAmt = numeric(it.tax_amount);
//       } else {
//         // If not provided but tax_percentage exists, compute
//         const pct = numeric(it.tax_percentage || (it.line_item_taxes && it.line_item_taxes[0] && it.line_item_taxes[0].tax_percentage) || 0);
//         if (pct) {
//           taxAmt = Number((itemTotalFromZoho * pct / 100).toFixed(2));
//         }
//       }

//       const discountedValue = numeric(it.discounted_value || it.discountedValue || it.item_total || itemTotalFromZoho);

//       const amtWoVatCur = Number((itemTotalFromZoho - taxAmt).toFixed(2));
//       const amtWoVatMur = amtWoVatCur; // assuming single currency MUR

//       const totalPrice = Number((amtWoVatCur + taxAmt).toFixed(2));
//       const detectedTaxCode = detectTaxCode(it);

//       return {
//         itemNo: String(idx + 1),
//         taxCode: detectedTaxCode,
//         nature: "GOODS",
//         currency: invoiceData.currency_code || "MUR",
//         itemDesc: it.name || it.description || "",
//         quantity: String(quantity),
//         unitPrice: String(Number(unitPrice).toFixed(2)),
//         discount: String(Number(numeric(it.discount_amount || it.discount || 0)).toFixed(2)),
//         discountedValue: String(Number(discountedValue).toFixed(2)),
//         amtWoVatCur: String(Number(amtWoVatCur).toFixed(2)),
//         amtWoVatMur: String(Number(amtWoVatMur).toFixed(2)),
//         vatAmt: String(Number(taxAmt).toFixed(2)),
//         totalPrice: String(Number(totalPrice).toFixed(2)),
//         productCodeOwn: it.item_id || it.product_code || it.sku || ""
//       };
//     });

//     // -----------------------------
//     // Compute totals from itemList (authoritative)
//     // -----------------------------
//     const computedTotals = mraItems.reduce(
//       (acc, it) => {
//         acc.totalAmtWoVatCur += numeric(it.amtWoVatCur);
//         acc.totalVatAmount += numeric(it.vatAmt);
//         acc.invoiceTotal += numeric(it.totalPrice);
//         acc.discountTotalAmount += numeric(it.discount);
//         return acc;
//       },
//       { totalAmtWoVatCur: 0, totalVatAmount: 0, invoiceTotal: 0, discountTotalAmount: 0 }
//     );

//     const totalAmtWoVatCurStr = Number(computedTotals.totalAmtWoVatCur).toFixed(2);
//     const totalVatAmountStr = Number(computedTotals.totalVatAmount).toFixed(2);
//     const invoiceTotalStr = Number(computedTotals.invoiceTotal).toFixed(2);
//     const discountTotalAmountStr = Number(computedTotals.discountTotalAmount).toFixed(2);

//     // totalAmtPaid: if payment recorded, use invoiceData.total_paid or balance logic; fallback to invoiceTotal
//     const totalAmtPaid = numeric(invoiceData.total_paid || invoiceData.amount_paid || invoiceData.total || invoiceTotalStr);

//     // -----------------------------
//     // Determine personType and buyerType
//     // personType: VATR if seller or buyer is VAT registered (we assume buyerTan present => VATR)
//     // buyerType: MRA expects "VATR" or "NVTR" or codes "01" in some examples; we'll use "VATR"/"NVTR"
//     // -----------------------------
//     const personType = buyerTan ? "VATR" : "NVTR";
//     const buyerType = buyerTan ? "VATR" : "NVTR";

//     // -----------------------------
//     // previousNoteHash (optional)
//     // If previous invoice info provided in invoiceData.previousInvoice: { dateTime, totalAmtPaid, brn, invoiceIdentifier }
//     // We'll compute SHA-256 hex of concatenation `dateTime + totalAmtPaid + brn + invoiceIdentifier` (exact as MRA doc)
//     // -----------------------------
//     let previousNoteHash = "0";
//     if (invoiceData.previousInvoice && typeof invoiceData.previousInvoice === "object") {
//       try {
//         const prev = invoiceData.previousInvoice;
//         // Accept various field names
//         const prevDate = prev.dateTime || prev.date_time || prev.date;
//         const prevTotal = String(prev.totalAmtPaid || prev.total_amt_paid || prev.total || prev.totalAmtPaid || prev.totalAmt || "");
//         const prevBrn = String(prev.brn || prev.prevBrn || prev.previous_brn || "");
//         const prevInv = String(prev.invoiceIdentifier || prev.invoiceIdentifier || prev.invoice_id || prev.invoice_number || "");

//         if (prevDate && prevTotal && prevBrn && prevInv) {
//           const concat = `${prevDate}${prevTotal}${prevBrn}${prevInv}`;
//           const hashHex = crypto.createHash("sha256").update(concat, "utf8").digest("hex").toUpperCase();
//           previousNoteHash = hashHex;
//         }
//       } catch (e) {
//         // If something goes wrong, keep "0"
//         previousNoteHash = "0";
//       }
//     }

//     // -----------------------------
//     // Seller block (static config) — move to env in production
//     // -----------------------------
//     const seller = {
//       name: process.env.SELLER_NAME || "Electrum Mauritius Limited",
//       tradeName: process.env.SELLER_TRADE_NAME || "Electrum Mauritius Limited",
//       tan: process.env.SELLER_TAN || "27124193",
//       brn: process.env.SELLER_BRN || "C11106429",
//       businessAddr: process.env.SELLER_ADDR || "Mauritius",
//       businessPhoneNo: process.env.SELLER_PHONE || "2302909090",
//       ebsCounterNo: process.env.EBS_COUNTER_NO || "",
//       cashierId: invoiceData.cashier_id || "SYSTEM"
//     };

//     // Buyer block
//     const buyer = {
//       name: String(buyerName),
//       tan: buyerTan ? String(buyerTan) : "",
//       brn: buyerBrn ? String(buyerBrn) : "",
//       businessAddr: billingObj && billingObj.address ? String(billingObj.address) : "",
//       buyerType: buyerType,
//       nic: invoiceData.nic || ""
//     };

//     // Build final MRA invoice object (note: MRA expects an array of invoices)
//     const mraInvoice = {
//       invoiceCounter: String(invoice_id),
//       transactionType: invoiceData.transactionType || "B2C", // Optionally detect B2B by presence of buyerTan/brn
//       personType: personType,
//       invoiceTypeDesc: invoiceData.invoiceTypeDesc || "STD",
//       currency: invoiceData.currency_code || "MUR",
//       invoiceIdentifier: String(invoice_number),
//       invoiceRefIdentifier: invoiceData.reference_number || "",
//       previousNoteHash: previousNoteHash,
//       totalVatAmount: String(totalVatAmountStr),
//       totalAmtWoVatCur: String(totalAmtWoVatCurStr),
//       totalAmtWoVatMur: String(totalAmtWoVatCurStr), // single currency assumption
//       invoiceTotal: String(invoiceTotalStr),
//       discountTotalAmount: String(discountTotalAmountStr),
//       totalAmtPaid: String(Number(totalAmtPaid).toFixed(2)),
//       dateTimeInvoiceIssued: dateTimeInvoiceIssued,
//       seller,
//       buyer,
//       itemList: mraItems,
//       salesTransactions: invoiceData.salesTransactions || "CASH"
//     };

//     // Log sample (trim large output)
//     console.log("Mapped MRA Invoice (preview):", JSON.stringify({
//       invoiceIdentifier: mraInvoice.invoiceIdentifier,
//       dateTimeInvoiceIssued: mraInvoice.dateTimeInvoiceIssued,
//       totalAmtWoVatCur: mraInvoice.totalAmtWoVatCur,
//       totalVatAmount: mraInvoice.totalVatAmount,
//       invoiceTotal: mraInvoice.invoiceTotal,
//       itemCount: mraInvoice.itemList.length
//     }));

//     // === Existing flow continues: AES/RSA/Token/Encrypt/Transmit ===
//     // Keep your current encryption + transmit code intact. The function should now use `mraInvoice`.
//     // For compatibility with your existing code that expects plainText to be an array, we return [mraInvoice]
//     // and then continue same steps (generate AES, RSA encrypt, token, decrypt key, encrypt invoice, transmit).
//     //
//     // If you want me to also include the rest of the flow (token generation & transmit) in this file,
//     // I can reinsert your previous implementation here. For now, return the mapped object so caller can continue.

//     // If you need this script to directly continue with MRA submission like before, uncomment the old flow
//     // and use JSON.stringify([mraInvoice]) as plainText.

//     return res.status(200).json({
//       status: "OK",
//       message: "MRA mapping successful",
//       preview: {
//         invoiceIdentifier: mraInvoice.invoiceIdentifier,
//         dateTimeInvoiceIssued: mraInvoice.dateTimeInvoiceIssued,
//         totalAmtWoVatCur: mraInvoice.totalAmtWoVatCur,
//         totalVatAmount: mraInvoice.totalVatAmount,
//         invoiceTotal: mraInvoice.invoiceTotal,
//         items: mraInvoice.itemList.length
//       },
//       mraInvoice
//     });

//   } catch (err) {
//     console.error("MRA Process Error:", err && (err.stack || err.message || err));
//     return res.status(500).json({
//       status: "ERROR",
//       message: err.message || String(err)
//     });
//   }
// }




//-----------------------------------------------------------------------------------------------------------
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
