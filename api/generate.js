import crypto from "crypto";

/**
 * Generate a 32-byte AES key and return base64 string.
 */

// Helper export
export function generateAesKey() {
  const key = crypto.randomBytes(32); // 256-bit
  return key.toString("base64");
}

// API handler (keeps compatibility)
export default function handler(req, res) {
  try {
    const base64Key = generateAesKey();
    res.status(200).json({ aesKey: base64Key });
  } catch (err) {
    console.error("generate-aes error:", err);
    res.status(500).json({ error: "Failed to generate AES key" });
  }
}
