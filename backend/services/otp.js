const crypto = require('crypto');
const db = require('../db/db');

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;

function generateOtp() {
  // 6-digit numeric OTP, cryptographically random
  const num = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return String(num).padStart(OTP_LENGTH, '0');
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

/**
 * SMS SENDER — plug in a real provider here for production use.
 * -------------------------------------------------------------
 * Each provider builds its own exact message text (not a shared freeform string) because
 * DLT-registered gateways in India — including Mobile Seva — reject anything that doesn't
 * exactly match the pre-approved template. Only the OTP digits are passed in; the wording
 * is decided per-provider.
 */
async function sendSms(mobileNumber, otp) {
  const provider = process.env.SMS_PROVIDER;

  if (provider === 'mobileseva') {
    const { sendOtpViaMobileSeva } = require('./mobileSevaSms');
    const result = await sendOtpViaMobileSeva(mobileNumber, otp);
    return { delivered: result.delivered };
  }

  // Example wiring point for another provider (uncomment and adapt):
  //
  // if (provider === 'msg91') {
  //   const axios = require('axios');
  //   await axios.post('https://api.msg91.com/api/v5/otp', {
  //     mobile: mobileNumber, otp, authkey: process.env.MSG91_AUTH_KEY
  //   });
  //   return { delivered: true };
  // }

  if (!provider || provider === 'none') {
    const message = `Dear Citizen, Your mChandigarh Application Login OTP is ${otp}. Chandigarh Smart City Ltd.`;
    console.log(`[DEV SMS STUB] To: ${mobileNumber} | Message: ${message}`);
    return { delivered: false, dev: true };
  }

  console.log(`[SMS PROVIDER "${provider}" NOT WIRED UP] To: ${mobileNumber} | OTP: ${otp}`);
  return { delivered: false };
}

/** Create and "send" an OTP for a user. Returns the OTP only when OTP_DEV_MODE=true (local testing). */
async function issueOtp(userId, mobileNumber, purpose = 'login') {
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO otp_codes (user_id, otp_hash, purpose, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, hashOtp(otp), purpose, expiresAt);

  const smsResult = await sendSms(mobileNumber, otp);

  const devMode = process.env.OTP_DEV_MODE === 'true';
  return {
    expiresInMinutes: OTP_TTL_MINUTES,
    smsDelivered: !!smsResult.delivered,
    // Only surface the raw OTP in the API response when explicitly running in dev/testing mode
    // with no real SMS provider configured — never do this in production.
    devOtp: devMode ? otp : undefined
  };
}

/** Verify a submitted OTP for a user. Returns { ok, error } */
function verifyOtp(userId, submittedOtp, purpose = 'login') {
  const row = db.prepare(`
    SELECT * FROM otp_codes
    WHERE user_id = ? AND purpose = ? AND consumed = 0
    ORDER BY id DESC LIMIT 1
  `).get(userId, purpose);

  if (!row) return { ok: false, error: 'No OTP was requested. Please log in again.' };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: 'Too many incorrect attempts. Please request a new OTP.' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'OTP has expired. Please request a new one.' };

  db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  if (hashOtp(submittedOtp) !== row.otp_hash) {
    return { ok: false, error: 'Incorrect OTP.' };
  }

  db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(row.id);
  return { ok: true };
}

module.exports = { issueOtp, verifyOtp };
