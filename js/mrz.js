// Parse a passport's machine-readable zone (the two <<< lines at the bottom).
// Standard TD3 format: two lines of 44 characters. Pure and testable — the OCR
// that produces the text lives in app.js and runs entirely on the device.

const charValue = (c) => (c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55);

/** ICAO check digit over a field (weights 7,3,1 repeating). */
export function checkDigit(field) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += charValue(field[i]) * weights[i % 3];
  return sum % 10;
}

function yymmddToISO(s, century) {
  const yy = Number(s.slice(0, 2));
  const mm = s.slice(2, 4);
  const dd = s.slice(4, 6);
  const year = century + yy;
  return `${year}-${mm}-${dd}`;
}

/**
 * @param text raw OCR output (may contain extra lines / noise)
 * @returns parsed fields, or null if no MRZ-looking pair of lines is found
 */
export function parseMRZ(text) {
  const lines = (text || '')
    .toUpperCase()
    .split(/[\r\n]+/)
    .map((l) => l.replace(/[^A-Z0-9<]/g, ''))
    .filter((l) => l.length >= 30);
  if (lines.length < 2) return null;
  let [l1, l2] = lines.slice(-2);
  const pad = (l) => (l + '<'.repeat(44)).slice(0, 44);
  l1 = pad(l1);
  l2 = pad(l2);

  const numberField = l2.slice(0, 9);
  const expiryField = l2.slice(21, 27);
  const dobField = l2.slice(13, 19);
  const nowYY = new Date().getFullYear() % 100;

  const names = l1.slice(5).split('<<');
  const clean = (s) => (s || '').replace(/</g, ' ').trim();
  const surname = clean(names[0]);
  const given = clean(names[1]);

  const result = {
    number: numberField.replace(/</g, ''),
    nationality: l2.slice(10, 13).replace(/</g, ''),
    surname,
    given,
    name: [given, surname].filter(Boolean).join(' '),
    dob: yymmddToISO(dobField, dobField && Number(dobField.slice(0, 2)) > nowYY ? 1900 : 2000),
    expiry: yymmddToISO(expiryField, 2000),
    valid: checkDigit(numberField) === Number(l2[9]) && checkDigit(expiryField) === Number(l2[27]),
  };
  return result;
}
