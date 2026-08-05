const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailValido(email) {
  return EMAIL_REGEX.test((email || '').trim());
}
