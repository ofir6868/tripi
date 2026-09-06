// The מסמכים folder classifier, run against realistic documents — the strings a phone
// would actually hand it: file names people save, the text layer of an airline PDF,
// the OCR of a passport photo, a hotel confirmation e-mail. No network, no cost:
//   node tools/docs-classify-check.js
// Exits 1 when a fixture lands in the wrong folder. Add a case whenever a real
// document was tagged wrong — the fix is a rule in public/js/doc-classify.js, and
// the case here is what keeps it fixed.
const { classify, folderOf } = require('../public/js/doc-classify.js');

const CASES = [
  // ---- file name only: what the picker hands us before any text is read ----
  { name: 'ElAl_boarding_pass_LY385.pdf', want: 'flights' },
  { name: 'Wizz Air e-ticket TLV-BUD.pdf', want: 'flights' },
  { name: 'כרטיס טיסה לאתונה.pdf', want: 'flights' },
  { name: 'passport_scan.png', want: 'id' },
  { name: 'דרכון רגב.jpg', want: 'id' },
  { name: 'ESTA approval.pdf', want: 'id' },
  { name: 'Hotel Artemide booking 4471.pdf', want: 'stay' },
  { name: 'airbnb-reservation-HM2XYZ.pdf', want: 'stay' },
  { name: 'אישור הזמנה מלון דן.pdf', want: 'stay' },
  { name: 'Harel travel insurance policy.pdf', want: 'insurance' },
  { name: 'פוליסת ביטוח נסיעות.pdf', want: 'insurance' },
  { name: 'Sixt rental voucher 2026.pdf', want: 'car' },
  { name: 'Trenitalia Roma-Firenze.pdf', want: 'car' },
  { name: 'vaccination certificate.pdf', want: 'health' },
  { name: 'מרשם תרופות.jpg', want: 'health' },
  { name: 'receipt_zara_2026-08-14.jpg', want: 'money' },
  { name: 'חשבונית מס 1187.pdf', want: 'money' },
  { name: 'IMG_20260814_101533.jpg', want: 'other' },
  { name: 'WhatsApp Image 2026-08-14 at 10.15.33.jpeg', want: 'other' },
  { name: 'Screenshot_20260814-101533.png', want: 'other' },
  { name: 'scan0001.pdf', want: 'other' },

  // ---- a flight e-ticket, as pdf.js reads its text layer ----
  { name: 'Document.pdf', want: 'flights', text: `EL AL ISRAEL AIRLINES
ELECTRONIC TICKET ITINERARY / RECEIPT
Passenger: COHEN/DAVID MR
Ticket number: 114-2401234567
Booking reference: Q7X2LM
LY 315  TLV → ATH   14 AUG 2026  Dep 07:10  Arr 09:45  Economy (Light)  Seat 22C
LY 316  ATH → TLV   21 AUG 2026  Dep 10:50  Arr 13:20  Economy (Light)  Seat 22C
Baggage: 1 x 23 kg   Cabin bag: 8 kg
Total paid: 1,890.00 ILS  Visa **** 4411` },
  // a Wizz photo/screenshot after OCR: caps, noise, no punctuation to speak of
  { name: 'Screenshot_20260814-101533.png', want: 'flights', text: `WIZZ AIR
BOARDING PASS
MR REGEV LEVI
TLV  BUD
W6 2312  14 AUG  06:05
GATE B7   SEAT 14A   SEQ 118
CONFIRMATION CODE  K9XR2P
PRIORITY BOARDING` },
  // the user's cue: "TLV" and "Mr" on their own should read as a flight
  { name: 'IMG_0007.jpg', want: 'flights', text: 'MR DAVID COHEN TLV 22 AUG 09:40' },
  // a hotel confirmation, which also mentions the flight number and the airport shuttle
  { name: 'Confirmation.pdf', want: 'stay', text: `Booking.com
Your booking is confirmed
Hotel Artemide, Via Nazionale 22, Rome
Confirmation number: 3311.552.874   PIN: 4471
Check-in: Thursday 14 August 2026 (from 14:00)
Check-out: Sunday 17 August 2026 (until 11:00)
3 nights, 1 room — Double Room, breakfast included, free cancellation until 10 August
Guests: 2 adults   Mr David Cohen
Airport shuttle available (flight number LY 315)
Total price: € 690 (includes VAT, city tax € 6 per person per night is paid at the property)` },
  // an Airbnb e-mail saved as text
  { name: 'Reservation confirmed - Airbnb.eml', want: 'stay', text: `Reservation confirmed
Your host Marta has confirmed your stay. Apartment in Lisbon, Alfama
Check-in Fri, Aug 14 after 3:00 PM · Checkout Mon, Aug 17 before 11:00 AM
3 nights · 2 guests · Confirmation code HMABC123
Total (EUR) €412.00 · Cleaning fee €30` },
  // a Hebrew hotel voucher, OCR'd
  { name: 'scan0002.jpg', want: 'stay', text: `שובר אירוח
מלון ישרוטל ים סוף, אילת
כניסה: 14/08/2026   יציאה: 17/08/2026   3 לילות
חדר זוגי, חצי פנסיון, 2 מבוגרים
מספר הזמנה: 88231145
סה"כ שולם: 4,200 ש"ח` },
  // an insurance policy schedule — it talks about flights, hotels and baggage too
  { name: 'policy.pdf', want: 'insurance', text: `PassportCard — ביטוח נסיעות לחו"ל
דף פרטי ביטוח / Policy Schedule
שם המבוטח: דוד כהן   ת.ז. 012345678   מספר פוליסה: 7781-2026-001
תקופת הביטוח: 14/08/2026 – 21/08/2026   יעד: אירופה
כיסויים: הוצאות רפואיות בחו"ל עד 5,000,000 $, ביטול/קיצור נסיעה, אובדן כבודה, איחור טיסה,
ספורט אתגרי, מצב רפואי קודם, צד שלישי   השתתפות עצמית: 50 $
מוקד חירום 24/7: +972-3-9200000   פרמיה: 312 ש"ח` },
  { name: 'Document (3).pdf', want: 'insurance', text: `Allianz Travel — Certificate of Insurance
Policy number: ATI-44-889-2026   Insured: Mr David Cohen   Trip: Israel to Greece, 14–21 Aug 2026
Coverage: Emergency medical expenses up to USD 1,000,000; Trip cancellation; Baggage loss; Flight delay
Premium: USD 48.00   24/7 assistance: +44 20 8666 9333` },
  // a passport, OCR'd (MRZ survives OCR far better than the printed fields do)
  { name: 'IMG_0031.jpg', want: 'id', text: `STATE OF ISRAEL מדינת ישראל
PASSPORT דרכון
Type P  Code ISR  Passport No 31234567
Surname COHEN  Given names DAVID
Nationality ISRAELI  Date of birth 12 MAR 1988  Sex M
Date of issue 03 JAN 2022  Date of expiry 02 JAN 2032
P<ISRCOHEN<<DAVID<<<<<<<<<<<<<<<<<<<<<<<<<<<<
3123456<7ISR8803125M3201021<<<<<<<<<<<<<<04` },
  { name: 'IMG_0032.jpg', want: 'id', text: `מדינת ישראל  משרד הפנים
תעודת זהות   מספר זהות 0-1234567-8
שם משפחה כהן  שם פרטי דוד  תאריך לידה 12.03.1988` },
  { name: 'approval.pdf', want: 'id', text: `U.S. Customs and Border Protection — Electronic System for Travel Authorization
ESTA Application Number: 8H2K3L4M5N6P   Status: AUTHORIZATION APPROVED
Passport Number: 31234567   Country of Citizenship: ISRAEL (ISR)   Expires: 02 Jan 2028` },
  { name: 'IMG_0040.jpg', want: 'id', text: `רישיון נהיגה  DRIVING LICENCE  מדינת ישראל
מספר רישיון 7654321  דרגה B  בתוקף עד 12.03.2030` },
  // car rental — mentions insurance (CDW) and a deposit, and the driver's licence
  { name: 'voucher.pdf', want: 'car', text: `Europcar — Rental Voucher / Confirmation
Reservation no. 1223344556   Driver: Mr David Cohen   Driving licence required at pick-up
Pick-up: Athens Airport (ATH) 14 Aug 2026 10:30   Drop-off: Athens Airport 21 Aug 2026 09:00
Vehicle: Toyota Yaris or similar (Compact, Automatic)   Fuel policy: Full to Full
Included: CDW, Theft Protection, Unlimited mileage   Excess: € 900   Deposit: € 300 (credit card)
Total: € 245.00` },
  { name: 'scan.jpg', want: 'car', text: `אלדן השכרת רכב — חוזה שכירות מס' 55871
נהג: דוד כהן   רישיון נהיגה 7654321   מספר רישוי 123-45-678
איסוף הרכב: 14/08/2026 נתב"ג   החזרת הרכב: 21/08/2026   דלק: מלא-מלא   ק"מ ללא הגבלה` },
  { name: 'ticket.pdf', want: 'car', text: `Trenitalia — Frecciarossa 9515
Roma Termini 08:50 → Firenze S.M.N. 10:24   Coach 5  Seat 12A   Passenger: David Cohen
PNR: X7YQ2A   Ticket price € 39.90   Train Frecciarossa` },
  { name: 'flixbus.pdf', want: 'car', text: `FlixBus — Your booking 4419-2211-887
Prague ÚAN Florenc → Vienna Erdberg   14.08.2026 09:15 – 13:30   Passenger: David Cohen   Seat 3C
Total € 24.99` },
  // health
  { name: 'IMG_0055.jpg', want: 'health', text: `INTERNATIONAL CERTIFICATE OF VACCINATION OR PROPHYLAXIS
Yellow fever — vaccine: Stamaril  Date: 02/06/2026  Valid for life  Clinic: Maccabi Travel Clinic, Tel Aviv` },
  { name: 'מרשם.pdf', want: 'health', text: `מכבי שירותי בריאות — מרשם
מטופל: דוד כהן  ת.ז. 012345678   רופא: ד"ר לוי רונית
Ventolin inhaler 100 mcg — משאף, 2 שאיפות לפי הצורך   Acamol 500 mg — 1-2 טבליות עד 4 פעמים ביום
תוקף המרשם: 6 חודשים` },
  { name: 'letter.pdf', want: 'health', text: `Dr. R. Levi, MD — Medical letter
To whom it may concern: Mr David Cohen (DOB 12/03/1988) is under my care for asthma and carries an inhaler and an EpiPen (peanut allergy). Fit to fly.` },
  // money — a receipt, a tax-free form, a bank exchange slip
  { name: 'IMG_0060.jpg', want: 'money', text: `ZARA  Via del Corso 189, Roma
14/08/2026 18:22   Cashier 04   Ticket 0021
Jacket  1 x 59,95   T-shirt  2 x 12,95
Subtotal 85,85   IVA 22% 15,48   TOTAL EUR 85,85   Visa **** 4411   Thank you` },
  { name: 'doc.pdf', want: 'money', text: `Global Blue — Tax Free Form 12 3456 7890
Purchase amount € 412,00   VAT refund € 51,00   Passport 31234567   Please stamp at customs before departure` },
  { name: 'קבלה.pdf', want: 'money', text: `חשבונית מס/קבלה מס' 20261187
בנק הפועלים — המרת מט"ח   שער חליפין 3.71   סה"כ לתשלום 1,855.00 ש"ח   שולם בכרטיס אשראי ישראכרט` },
  // nothing to go on: a photo with no text, and a page of prose in Hebrew
  { name: 'IMG_0070.jpg', want: 'other', text: '' },
  { name: 'notes.txt', want: 'other', text: 'לזכור לקנות מתאם לשקע, לבדוק את המזוודה ולהתקשר לסבתא לפני הטיסה' },
  { name: 'packing.txt', want: 'other', text: `packing list: chargers, adapter, sunglasses, hat, book, headphones` },
];

let bad = 0;
for (const c of CASES) {
  const r = classify({ name: c.name, text: c.text || '' });
  const ok = r.folder === c.want;
  if (!ok) bad++;
  const top = Object.entries(r.scores).map(([k, v]) => `${k}:${v.score}`).filter((s) => !s.endsWith(':0')).sort((a, b) => +b.split(':')[1] - +a.split(':')[1]).slice(0, 3).join(' ');
  console.log(`${ok ? '✓' : '✗'} ${folderOf(r.folder).emoji} ${r.folder.padEnd(9)} ${c.name}${ok ? '' : `   WANT ${c.want}`}   [${r.tags.join(', ')}] via ${r.via}   ${top}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} fixtures in the right folder`);
process.exit(bad ? 1 : 0);
