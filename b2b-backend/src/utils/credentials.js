// Shared rules for emails and passwords (register, login, password change/reset, email flows)

const MIN_PASSWORD_LENGTH = 8;
// bcrypt only uses the first 72 bytes of a password; longer ones would be silently truncated
const MAX_PASSWORD_BYTES = 72;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Emails are stored and looked up in lowercase, trimmed, so "A@x.com" and "a@x.com" are one account
function normalizeEmail(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function emailError(email) {
  if (!email) return 'email is required';
  if (email.length > 254 || !EMAIL_RE.test(email)) return 'email is not a valid email address';
  return null;
}

function passwordError(password, field = 'password') {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `${field} must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return `${field} is too long`;
  return null;
}

module.exports = { MIN_PASSWORD_LENGTH, normalizeEmail, emailError, passwordError };
