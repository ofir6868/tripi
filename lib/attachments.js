// A document handed to the chat — a flight ticket, a hotel confirmation, a screenshot
// of a booking — and what of it reaches the model.
//
// The browser does the reading (public/js/doc-text.js, the same ladder the מסמכים
// page climbs: a PDF's text layer, the platform's own OCR, tesseract in WASM) and
// sends TEXT. The file itself never comes here. Only when the device could not read
// a photo — no OCR on a weak phone, a blurry shot — does a reduced copy come instead
// (long edge ≤ 1024px, JPEG), and it goes to the model at `detail: low`: a fixed
// handful of tokens, whatever its size. Both paths are bounded here again, because a
// client is a client: text is cut at TEXT_MAX, an image at IMAGE_MAX bytes, and a
// message carries at most PER_MESSAGE of them.
//
// Three a day per user (the `files` meter) — the one hard rule the free tier needs:
// a photo read by the model is the costliest thing a turn can carry, and a traveller
// with a folder of thirty screenshots would spend a month of someone else's budget.
const { dailyQuota } = require('./quota');

const PER_MESSAGE = 3;
const TEXT_MAX = 3000;          // chars of a document's text the model sees
const TEXT_TOTAL = 6000;        // across one message
const IMAGE_MAX = 400 * 1024;   // bytes of a reduced JPEG, as a data URL
const NAME_MAX = 80;
const filesMeter = dailyQuota('files', 3); // AI_QUOTA_FILES overrides

// the client's attachments → the ones that can go to the model
function cleanAttachments(raw) {
  const out = [];
  let budget = TEXT_TOTAL;
  for (const a of (Array.isArray(raw) ? raw : []).slice(0, PER_MESSAGE)) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name || 'קובץ').replace(/[\r\n]/g, ' ').slice(0, NAME_MAX).trim() || 'קובץ';
    const kind = a.kind === 'pdf' ? 'pdf' : a.kind === 'image' ? 'image' : 'file';
    let text = String(a.text || '').replace(/\s+/g, ' ').trim().slice(0, Math.min(TEXT_MAX, budget));
    budget -= text.length;
    let image = null;
    if (typeof a.image === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a.image) && a.image.length <= IMAGE_MAX) {
      image = a.image;
    }
    if (!text && !image) { text = ''; } // the name alone still tells the model something arrived
    out.push({ name, kind, text, image });
  }
  return out;
}

// the block the model reads under the travellers' message
function promptBlock(attachments) {
  if (!attachments.length) return '';
  const lines = attachments.map((a, i) => {
    const what = a.kind === 'pdf' ? 'PDF' : a.kind === 'image' ? 'תמונה' : 'קובץ';
    if (a.text) return `[קובץ ${i + 1}: ${a.name} (${what}) — הטקסט שנקרא מתוכו]\n${a.text}\n[סוף קובץ ${i + 1}]`;
    if (a.image) return `[קובץ ${i + 1}: ${a.name} (${what}) — מצורף כתמונה; קראו ממנה את הפרטים]`;
    return `[קובץ ${i + 1}: ${a.name} (${what}) — לא הצלחנו לקרוא ממנו טקסט; אמרו זאת ובקשו את הפרטים במילים]`;
  });
  return `\n\nהמטיילים צירפו ${attachments.length === 1 ? 'קובץ' : `${attachments.length} קבצים`}:\n${lines.join('\n')}`;
}

// what is stored on the travellers' turn, and painted under their bubble: the names
// and kinds — never the text or the image
const stored = (attachments) => attachments.map((a) => ({ name: a.name, kind: a.kind, read: a.text ? 'text' : a.image ? 'image' : 'none' }));

const images = (attachments) => attachments.map((a) => a.image).filter(Boolean);

// the rule for the model, shared by both chats
const PROMPT_RULES = `קבצים מצורפים: כשהמטיילים צירפו קובץ (כרטיס טיסה, אישור מלון, הזמנה, צילום מסך), פתחו את text במשפט שאומר מה הבנתם ממנו — למשל "ראיתי שהעליתם כרטיסי טיסה עם קונקשן בציריך, איזה יופי!" — ואז עשו עם זה משהו: טיסה → עדכנו את תחנת הטיסה שבמסלול (update עם השעה ופרטי הטיסה ב-note) או הוסיפו אחת אם אין, וכשהתאריך כתוב ולטיול אין תאריך — dates_set; מלון → hotel_add/hotel_update עם הלילות והמחיר הכתובים; מחיר/תקציב → budget_set. רק מה שכתוב בקובץ, בלי השלמות. מה שלא ברור — שאלו שאלה אחת.`;

module.exports = { PER_MESSAGE, filesMeter, cleanAttachments, promptBlock, stored, images, PROMPT_RULES };
