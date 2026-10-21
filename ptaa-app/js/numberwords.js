// ---------------------------------------------------------------------------
// numberwords.js — numbers written out in words, the way the agreement does it.
//
// The D TERRA template writes each figure twice, in words and in digits:
//   "Thirty-six (36) months from the Commencement Date."
//   "Ten Per centum (10 %) of the total gross monthly rental…"
//
// So {{initial_term_months}} is the WORDS and {{initial_term_months_numberic}}
// is the digits — not the other way round.
// ---------------------------------------------------------------------------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven",
              "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
              "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
              "eighty", "ninety"];

function under1000(n) {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const o = n % 10;
    return o ? `${t}-${ONES[o]}` : t;          // "thirty-six"
  }
  const h = `${ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest ? `${h} and ${under1000(rest)}` : h;
}

/** 36 → "thirty-six", 1151 → "one thousand one hundred and fifty-one". */
export function numberToWords(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (n < 0) return "minus " + numberToWords(-n);
  n = Math.round(n);
  if (n === 0) return "zero";

  const parts = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;

  if (millions) parts.push(`${under1000(millions)} million`);
  if (thousands) parts.push(`${under1000(thousands)} thousand`);
  if (rest) parts.push(under1000(rest));
  return parts.join(" ");
}

/** "thirty-six" → "Thirty-six". Only the first letter, as the agreement does. */
export function capitaliseFirst(text) {
  const s = String(text || "");
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** 36 → "Thirty-six" */
export function numberInWords(value) {
  return capitaliseFirst(numberToWords(value));
}

/**
 * 10 → "Ten Per centum", matching the wording in the agreement.
 * A fraction is written out too: 12.5 → "Twelve point five Per centum".
 */
export function percentInWords(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const whole = Math.floor(Math.abs(n));
  const frac = Math.abs(n) - whole;
  let words = numberToWords(whole);
  if (frac > 0) {
    const digits = String(Math.round(frac * 100)).replace(/0+$/, "") || "0";
    words += " point " + [...digits].map(d => ONES[Number(d)]).join(" ");
  }
  return capitaliseFirst(words) + " Per centum";
}

/** 1 → "01st", 2 → "02nd", 21 → "21st", 30 → "30th" — as the documents write it. */
export function ordinalDay(day) {
  const n = Number(day);
  if (!Number.isFinite(n)) return "";
  const padded = String(n).padStart(2, "0");
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return padded + "th";
  return padded + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
}
