// // api/decrypt-aes.js
// import crypto from "crypto";


// export default function handler(req, res) {
//   try {
//     // Optional: simple API key protection
//     // const AUTH_KEY = process.env.AES_GEN_KEY;
//     // if (AUTH_KEY && req.headers['x-api-key'] !== AUTH_KEY) {
//     //   return res.status(401).json({ error: "Unauthorized" });
//     // }

//     const { encryptedKey, aesKey } = req.body || {};

//     if (!encryptedKey || !aesKey) {
//       return res.status(400).json({ error: "Missing encryptedKey or aesKey" });
//     }

//     // aesKey = base64 encoded 32-byte key (what we generate earlier)
//     const keyBuf = Buffer.from(aesKey, "base64");
//     const encBuf = Buffer.from(encryptedKey, "base64"); // MRA returns base64 of ciphertext

//     // AES-256-ECB decrypt (PKCS#5/7 padding)
//     const decipher = crypto.createDecipheriv("aes-256-ecb", keyBuf, null);
//     decipher.setAutoPadding(true);
//     const decrypted = Buffer.concat([decipher.update(encBuf), decipher.final()]).toString("utf8");

//     return res.status(200).json({ decryptedKey: decrypted });
//   } catch (err) {
//     console.error("decrypt-aes error:", err);
//     return res.status(500).json({ error: err.message });
//   }
// }




// api/decrypt-aes.js
import crypto from "crypto";

/**
 * Decrypt a base64 ciphertext using AES-256-ECB where the key is provided as base64.
 *
 * This function is used to decrypt the 'key' returned by the MRA token endpoint
 * (the MRA returns an encrypted value that must be decrypted with the AES key we generated).
 */

export function decryptWithAes(encryptedBase64, aesKeyBase64) {
  if (!encryptedBase64 || !aesKeyBase64) {
    throw new Error("Missing encryptedBase64 or aesKeyBase64");
  }

  const keyBuf = Buffer.from(aesKeyBase64, "base64");
  const encBuf = Buffer.from(encryptedBase64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-ecb", keyBuf, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(encBuf), decipher.final()]).toString("utf8");
  return decrypted;
}

// API handler for testing
export default function handler(req, res) {
  try {
    const { encryptedKey, aesKey } = req.body || {};
    if (!encryptedKey || !aesKey) return res.status(400).json({ error: "Missing encryptedKey or aesKey" });

    const decryptedKey = decryptWithAes(encryptedKey, aesKey);
    return res.status(200).json({ decryptedKey });
  } catch (err) {
    console.error("decrypt-aes error:", err);
    return res.status(500).json({ error: err.message });
  }
}
