// import crypto from "crypto";

// export default function handler(req, res) {
//   try {
//     const { plainText, aesKey } = req.body;

//     if (!plainText || !aesKey) {
//       return res.status(400).json({ error: "Missing plainText or aesKey" });
//     }

//     // 🔑 Decode Base64 AES key into raw bytes
//     const keyBuffer = Buffer.from(aesKey, "base64");

//     // ECB mode doesn’t use IV → pass null
//     const cipher = crypto.createCipheriv("aes-256-ecb", keyBuffer, null);

//     let encrypted = cipher.update(plainText, "utf8", "base64");
//     encrypted += cipher.final("base64");

//     res.status(200).json({ encryptedText: encrypted });
//   } catch (err) {
//     console.error("encrypt-invoice error:", err);
//     res.status(500).json({ error: err.message });
//   }
// }



// api/encrypt-invoice.js
import crypto from "crypto";

/**
 * Encrypt plainText (utf8) with AES-256-ECB using aesKey (base64).
 * Returns base64 ciphertext.
 */

export function encryptInvoiceWithAes(plainText, aesKeyBase64) {
  if (!plainText || !aesKeyBase64) throw new Error("Missing plainText or aesKeyBase64");
  const keyBuffer = Buffer.from(aesKeyBase64, "base64");
  const cipher = crypto.createCipheriv("aes-256-ecb", keyBuffer, null);
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(String(plainText), "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

// API handler for testing
export default function handler(req, res) {
  try {
    const { plainText, aesKey } = req.body || {};
    if (!plainText || !aesKey) return res.status(400).json({ error: "Missing plainText or aesKey" });

    const encryptedText = encryptInvoiceWithAes(plainText, aesKey);
    return res.status(200).json({ encryptedText });
  } catch (err) {
    console.error("encrypt-invoice error:", err);
    return res.status(500).json({ error: err.message });
  }
}
