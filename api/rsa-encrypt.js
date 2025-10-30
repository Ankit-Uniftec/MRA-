// import { publicEncrypt, constants } from "crypto";
// import fs from "fs";
// import path from "path";

// export default function handler(req, res) {
//   try {
//     // Resolve PEM file in the same folder as this API route
//     const keyPath = path.join(__dirname, "MRAPublicKey.pem");
//     const publicKeyPem = fs.readFileSync(keyPath, "utf8");

//     const payloadJSON = JSON.stringify(req.body.payload);

//     const encryptedBuffer = publicEncrypt(
//       {
//         key: publicKeyPem,
//         padding: constants.RSA_PKCS1_PADDING,
//       },
//       Buffer.from(payloadJSON)
//     );

//     const encryptedBase64 = encryptedBuffer.toString("base64");
//     res.status(200).json({ encrypted: encryptedBase64 });
//   } catch (err) {
//     console.error("rsa-encrypt error:", err);
//     res.status(500).json({ error: err.message });
//   }
// }






// api/rsa-encrypt.js
import { publicEncrypt, constants } from "crypto";
import fs from "fs";
import path from "path";

/**
 * RSA encrypt a JS payload using the MRAPublicKey.pem file.
 * Returns base64 ciphertext.
 */

export function rsaEncryptPayload(payload) {
  // load public key from api/MRAPublicKey.pem (project root / api folder)
  const pemPath = path.join(process.cwd(), "api", "MRAPublicKey.pem");
  const publicKeyPem = fs.readFileSync(pemPath, "utf8");

  const payloadJSON = JSON.stringify(payload);
  const encryptedBuffer = publicEncrypt(
    {
      key: publicKeyPem,
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(payloadJSON, "utf8")
  );

  return encryptedBuffer.toString("base64");
}

// API handler for manual testing
export default function handler(req, res) {
  try {
    const payload = req.body && req.body.payload ? req.body.payload : req.body;
    if (!payload) return res.status(400).json({ error: "Missing payload" });

    const encrypted = rsaEncryptPayload(payload);
    return res.status(200).json({ encrypted });
  } catch (err) {
    console.error("rsa-encrypt error:", err);
    return res.status(500).json({ error: err.message });
  }
}
