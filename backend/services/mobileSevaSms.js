/**
 * Mobile Seva (Government of India / mGov / DLT) SMS Gateway integration.
 * -------------------------------------------------------------------------
 * This replicates the official Java client (SMSServices.java) exactly — same endpoint,
 * same field names, same hashing — just in Node.js, so it works with your existing
 * Mobile Seva department credentials (username, password, sender ID, secure key, template ID).
 *
 * IMPORTANT — DLT compliance:
 * The message sent MUST exactly match your DLT-approved template, with only the {#var#}
 * placeholder substituted. This file hardcodes your approved OTP template below. If you have
 * more than one approved template (e.g. one for officers, one for banks), add another
 * TEMPLATE_ID/TEMPLATE_TEXT pair and pick between them in buildMessage() as needed.
 *
 * Required environment variables (add these to your .env — see .env.example):
 *   MOBILE_SEVA_USERNAME     - Department login username
 *   MOBILE_SEVA_PASSWORD     - Department login password (plain text here; this file hashes it)
 *   MOBILE_SEVA_SENDER_ID    - Your allocated Sender ID (e.g. CHNSCL, MCCHND, etc.)
 *   MOBILE_SEVA_SECURE_KEY   - Secure key generated from the Mobile Seva services portal
 *   MOBILE_SEVA_TEMPLATE_ID  - The 12-19 digit DLT template ID for the OTP template below
 */
const crypto = require('crypto');

const MOBILE_SEVA_URL = 'https://msdgweb.mgov.gov.in/esms/sendsmsrequestDLT';

// Your DLT-approved OTP template — the {#var#} placeholder gets replaced with the OTP digits.
// This exact wording (including punctuation and spacing) is what was approved on DLT, so it
// must not be changed here without re-approving a new template on the DLT portal.
const OTP_TEMPLATE = 'Dear Citizen, Your mChandigarh Application Login OTP is {#var#}. Chandigarh Smart City Ltd.';

function buildMessage(otp) {
  return OTP_TEMPLATE.replace('{#var#}', otp);
}

// Matches the Java client's MD5() method exactly — note it's actually SHA-1 despite the name
// (that's how the original Java code was written; Mobile Seva's backend expects this exact
// hash, so it's replicated as-is rather than "corrected" to real MD5 or SHA-256).
function hashPassword(password) {
  return crypto.createHash('sha1').update(password, 'latin1').digest('hex');
}

// Matches the Java client's hashGenerator() method exactly: SHA-512 of
// username + senderId + content + secureKey (each trimmed, concatenated with no separator).
function generateHashKey(username, senderId, content, secureKey) {
  const combined = `${username.trim()}${senderId.trim()}${content.trim()}${secureKey.trim()}`;
  return crypto.createHash('sha512').update(combined, 'utf8').digest('hex');
}

/**
 * Sends a single OTP SMS via Mobile Seva. Returns { delivered: boolean, raw: string }.
 * Never throws — a gateway failure should not crash the login flow; it's logged instead,
 * matching how services/otp.js treats the console-log dev stub.
 */
async function sendOtpViaMobileSeva(mobileNumber, otp) {
  const username = process.env.MOBILE_SEVA_USERNAME;
  const password = process.env.MOBILE_SEVA_PASSWORD;
  const senderId = process.env.MOBILE_SEVA_SENDER_ID;
  const secureKey = process.env.MOBILE_SEVA_SECURE_KEY;
  const templateId = process.env.MOBILE_SEVA_TEMPLATE_ID;

  if (!username || !password || !senderId || !secureKey || !templateId) {
    console.error('[Mobile Seva] Missing one or more MOBILE_SEVA_* environment variables — cannot send SMS. Check your .env file.');
    return { delivered: false, raw: 'MISSING_CONFIG' };
  }

  const message = buildMessage(otp);
  const encryptedPassword = hashPassword(password);
  const key = generateHashKey(username, senderId, message, secureKey);

  const params = new URLSearchParams({
    mobileno: mobileNumber,
    senderid: senderId,
    content: message,
    smsservicetype: 'otpmsg', // OTP-only channel — Mobile Seva rejects non-OTP content sent this way
    username,
    password: encryptedPassword,
    key,
    templateid: templateId
  });

  try {
    const response = await fetch(MOBILE_SEVA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const raw = await response.text();
    console.log(`[Mobile Seva] Response for ${mobileNumber}: ${raw}`);

    // Mobile Seva returns a response code + message ID on success (e.g. "402,MsgID=...").
    // There isn't a single documented universal success code across all department setups,
    // so this treats "starts with digits followed by a comma" as success and logs the raw
    // response either way — check your Mobile Seva portal's response-code table and tighten
    // this check if you want stricter success/failure detection.
    const looksSuccessful = /^\d+,/.test(raw.trim());
    return { delivered: looksSuccessful, raw };
  } catch (err) {
    console.error('[Mobile Seva] Request failed:', err.message);
    return { delivered: false, raw: err.message };
  }
}

module.exports = { sendOtpViaMobileSeva, buildMessage };
