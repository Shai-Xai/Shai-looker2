// Device identifier → marketing name. Phones report machine ids, not names:
// iOS $device_model is "iPhone14,2", Android $device_name is a build codename
// ("pa3q") and $device_model an "SM-S926B"-style code. This table covers the
// handsets actually seen in Howler's PostHog data (mostly ZA market: Samsung,
// Apple, Pixel, Huawei) — unknown ids fall through unchanged, so the table
// only ever improves readability, never hides data.

const APPLE = {
  'iPhone9,1': 'iPhone 7', 'iPhone9,3': 'iPhone 7', 'iPhone9,2': 'iPhone 7 Plus', 'iPhone9,4': 'iPhone 7 Plus',
  'iPhone10,1': 'iPhone 8', 'iPhone10,4': 'iPhone 8', 'iPhone10,2': 'iPhone 8 Plus', 'iPhone10,5': 'iPhone 8 Plus',
  'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X',
  'iPhone11,2': 'iPhone XS', 'iPhone11,4': 'iPhone XS Max', 'iPhone11,6': 'iPhone XS Max', 'iPhone11,8': 'iPhone XR',
  'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro', 'iPhone12,5': 'iPhone 11 Pro Max', 'iPhone12,8': 'iPhone SE (2nd gen)',
  'iPhone13,1': 'iPhone 12 mini', 'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro', 'iPhone13,4': 'iPhone 12 Pro Max',
  'iPhone14,4': 'iPhone 13 mini', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max', 'iPhone14,6': 'iPhone SE (3rd gen)',
  'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus', 'iPhone15,2': 'iPhone 14 Pro', 'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus', 'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus', 'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max', 'iPhone17,5': 'iPhone 16e',
};

// Samsung build codenames (what Android reports as $device_name).
const SAMSUNG_CODE = {
  o1q: 'Galaxy S21', t2q: 'Galaxy S21+', p3q: 'Galaxy S21 Ultra', r9q: 'Galaxy S21 FE',
  r0q: 'Galaxy S22', g0q: 'Galaxy S22+', b0q: 'Galaxy S22 Ultra',
  dm1q: 'Galaxy S23', dm2q: 'Galaxy S23+', dm3q: 'Galaxy S23 Ultra', r11q: 'Galaxy S23 FE',
  e1q: 'Galaxy S24', e2q: 'Galaxy S24+', e3q: 'Galaxy S24 Ultra', r12s: 'Galaxy S24 FE',
  pa1q: 'Galaxy S25', pa2q: 'Galaxy S25+', pa3q: 'Galaxy S25 Ultra',
  a05: 'Galaxy A05', a05m: 'Galaxy A05s', a06: 'Galaxy A06', a15: 'Galaxy A15', a16: 'Galaxy A16',
  a24: 'Galaxy A24', a25x: 'Galaxy A25', a26x: 'Galaxy A26',
  a33x: 'Galaxy A33', a34x: 'Galaxy A34', a35x: 'Galaxy A35', a36xq: 'Galaxy A36',
  a52q: 'Galaxy A52', a53x: 'Galaxy A53', a54x: 'Galaxy A54', a55x: 'Galaxy A55', a56x: 'Galaxy A56',
  a73xq: 'Galaxy A73', m34x: 'Galaxy M34',
  q4q: 'Galaxy Z Flip4', b4q: 'Galaxy Z Fold4', q5q: 'Galaxy Z Flip5', q6q: 'Galaxy Z Flip6',
  gts8: 'Galaxy Tab S8', gts9: 'Galaxy Tab S9',
};

// Samsung SM- model numbers (what Android reports as $device_model), matched
// on the 4-digit core so regional suffixes (B/N/U/DS…) don't matter.
const SAMSUNG_SM = {
  G991: 'Galaxy S21', G996: 'Galaxy S21+', G998: 'Galaxy S21 Ultra', G990: 'Galaxy S21 FE',
  S901: 'Galaxy S22', S906: 'Galaxy S22+', S908: 'Galaxy S22 Ultra',
  S911: 'Galaxy S23', S916: 'Galaxy S23+', S918: 'Galaxy S23 Ultra', S711: 'Galaxy S23 FE',
  S921: 'Galaxy S24', S926: 'Galaxy S24+', S928: 'Galaxy S24 Ultra', S721: 'Galaxy S24 FE',
  S931: 'Galaxy S25', S936: 'Galaxy S25+', S938: 'Galaxy S25 Ultra',
  A055: 'Galaxy A05', A057: 'Galaxy A05s', A065: 'Galaxy A06', A155: 'Galaxy A15', A165: 'Galaxy A16', A166: 'Galaxy A16',
  A245: 'Galaxy A24', A256: 'Galaxy A25', A265: 'Galaxy A26',
  A336: 'Galaxy A33', A346: 'Galaxy A34', A356: 'Galaxy A35', A366: 'Galaxy A36',
  A525: 'Galaxy A52', A536: 'Galaxy A53', A546: 'Galaxy A54', A556: 'Galaxy A55', A566: 'Galaxy A56',
};

// Google Pixel build codenames.
const PIXEL = {
  oriole: 'Pixel 6', raven: 'Pixel 6 Pro', bluejay: 'Pixel 6a',
  panther: 'Pixel 7', cheetah: 'Pixel 7 Pro', lynx: 'Pixel 7a',
  shiba: 'Pixel 8', husky: 'Pixel 8 Pro', akita: 'Pixel 8a',
  tokay: 'Pixel 9', caiman: 'Pixel 9 Pro', komodo: 'Pixel 9 Pro XL', tegu: 'Pixel 9a',
};

export function prettyDevice(v) {
  const raw = String(v || '').trim();
  if (!raw) return raw;
  if (APPLE[raw]) return APPLE[raw];
  if (/^iPad/i.test(raw)) return 'iPad';
  const lower = raw.toLowerCase();
  if (SAMSUNG_CODE[lower]) return SAMSUNG_CODE[lower];
  if (PIXEL[lower]) return PIXEL[lower];
  const sm = raw.match(/^SM-([A-Z]\d{3})/i);
  if (sm && SAMSUNG_SM[sm[1].toUpperCase()]) return SAMSUNG_SM[sm[1].toUpperCase()];
  return raw; // unknown ids stay visible as-is
}

export const DEVICE_KEYS = new Set(['$device_name', '$device_model']);
