// Turn DVLA (Vehicle Enquiry Service) and DVSA (MOT History) responses into
// one tidy summary for the Car screen. Defensive about missing fields.

const title = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const isoDay = (s) => (s ? String(s).slice(0, 10).replace(/\./g, '-') : '');

const DEFECT_ORDER = { DANGEROUS: 0, MAJOR: 1, FAIL: 1, PRS: 2, MINOR: 3, ADVISORY: 4, 'USER ENTERED': 5 };
const DEFECT_LABEL = { DANGEROUS: 'Dangerous', MAJOR: 'Major', FAIL: 'Failure', PRS: 'Fixed during test', MINOR: 'Minor', ADVISORY: 'Advisory', 'USER ENTERED': 'Note' };

export function summariseCar(dvla, mot) {
  const d = (dvla && dvla.data) || {};
  const m = (mot && mot.data) || {};
  const tests = (m.motTests || [])
    .map((t) => {
      const defects = (t.defects || t.rfrAndComments || []).map((x) => {
        const type = String(x.type || '').toUpperCase();
        return { type, label: DEFECT_LABEL[type] || title(type), text: x.text || x.comment || '', dangerous: !!x.dangerous || type === 'DANGEROUS' };
      }).sort((a, b) => (DEFECT_ORDER[a.type] ?? 9) - (DEFECT_ORDER[b.type] ?? 9));
      const miles = Number(t.odometerValue);
      return {
        date: isoDay(t.completedDate),
        passed: /^PASS/i.test(t.testResult || ''),
        result: /^PASS/i.test(t.testResult || '') ? 'Pass' : 'Fail',
        expiry: isoDay(t.expiryDate),
        mileage: Number.isFinite(miles) ? (String(t.odometerUnit || 'mi').toUpperCase().startsWith('K') ? Math.round(miles * 0.621371) : miles) : null,
        number: t.motTestNumber || '',
        defects,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  // Average yearly mileage across the MOT history.
  const withMiles = tests.filter((t) => t.mileage != null && t.date);
  let milesPerYear = null;
  if (withMiles.length >= 2) {
    const newest = withMiles[0], oldest = withMiles[withMiles.length - 1];
    const years = (new Date(newest.date) - new Date(oldest.date)) / (365.25 * 86400000);
    if (years > 0.5) milesPerYear = Math.round((newest.mileage - oldest.mileage) / years);
  }
  const latestPass = tests.find((t) => t.passed && t.expiry);
  return {
    reg: d.registrationNumber || m.registration || '',
    make: title(d.make || m.make),
    model: title(m.model),
    colour: title(d.colour || m.primaryColour),
    year: d.yearOfManufacture || (m.manufactureDate ? Number(String(m.manufactureDate).slice(0, 4)) : null),
    fuel: title(d.fuelType || m.fuelType),
    engineCc: d.engineCapacity || (m.engineSize ? Number(m.engineSize) : null),
    co2: d.co2Emissions ?? null,
    firstRegistered: d.monthOfFirstRegistration || isoDay(m.firstUsedDate || m.registrationDate),
    taxStatus: d.taxStatus || '',
    taxDue: isoDay(d.taxDueDate),
    motStatus: d.motStatus || '',
    motExpiry: isoDay(d.motExpiryDate) || (latestPass ? latestPass.expiry : ''),
    outstandingRecall: m.hasOutstandingRecall === true || m.hasOutstandingRecall === 'Yes',
    tests,
    milesPerYear,
    sources: { dvla: dvla?.configured ? (dvla.data ? 'ok' : dvla.notFound ? 'not found' : dvla.error || 'error') : 'not set up', mot: mot?.configured ? (mot.data ? 'ok' : mot.notFound ? 'not found' : mot.error || 'error') : 'not set up' },
  };
}

/** A full-length modern UK plate — safe to look up while still typing. */
export function isFullModernReg(value) {
  const r = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(r) || /^[A-Z]\d{1,3}[A-Z]{3}$/.test(r) || /^[A-Z]{3}\d{1,3}[A-Z]$/.test(r);
}
/** Any UK registration (incl. short dateless / private and Northern Ireland plates). */
export function looksLikeUkReg(value) {
  const r = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(r) // current: AB17 CDE
    || /^[A-Z]\d{1,3}[A-Z]{3}$/.test(r) // prefix: A123 BCD
    || /^[A-Z]{3}\d{1,3}[A-Z]$/.test(r) // suffix: ABC 123D
    || /^[A-Z]{1,3}\d{1,4}$/.test(r) // dateless / NI: ABC 1234
    || /^\d{1,4}[A-Z]{1,3}$/.test(r); // dateless: 1234 AB
}
