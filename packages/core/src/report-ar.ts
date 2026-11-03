/**
 * E16: the UAE Entity Assessment Report in Arabic. The report's own wording (headings, labels, the fixed sentences)
 * is translated; what the engine or a person wrote (a rule's approved text, a finding, guidance, a place's name, an
 * address) stays as written, in English, marked as a left-to-right island (U+2066 … U+2069) so it reads correctly
 * inside the Arabic text. Like the rest of the Arabic, the wording is a draft until the Arabic reviewer signs it off
 * (gaps 111 and 129), and the API offers the Arabic report only where Arabic is available.
 *
 * Pure.
 */
import type { Report, ReportSection } from "./report.ts";

/** Left-to-right isolate: English data inside Arabic text. The PDF renderer reads the marks and does not draw them. */
export const ltr = (s: string) => {
  // Data is cleaned first: its own direction marks would unbalance the island, and a line break or tab is a space.
  const clean = s.replace(/[\u202A-\u202E\u2066-\u2069]/g, "").replace(/\s+/g, " ");
  return clean ? `\u2066${clean}\u2069` : clean;
};

const HEADINGS: Record<string, string> = {
  "Your business profile": "ملف نشاطك التجاري",
  "Structures compared": "مقارنة الهياكل",
  "Jurisdictions compared": "مقارنة الجهات",
  "Rejected or uncertain alternatives": "البدائل المستبعدة أو غير المؤكدة",
  "Rejected alternatives": "البدائل المستبعدة",
  "Licences, approvals and what follows after setup": "الرخص والموافقات وما يلي التأسيس",
  "Cross-border risks for a specialist": "مخاطر عابرة للحدود يراجعها مختص",
  "Unresolved questions": "أسئلة لم تُحسم",
  "Recommendation, subject to review": "التوصية، رهن المراجعة",
  "Recommendation and its limits": "التوصية وحدودها",
  "General guidance (approved wording)": "إرشادات عامة (صياغة معتمدة)",
  "Official sources": "المصادر الرسمية",
  "Next steps": "الخطوات التالية",
};

const TAGS: Record<string, string> = {
  CHECKED: "تم التحقق",
  "TO BE VERIFIED": "قيد التحقق",
  CONDITION: "شرط",
  "DOES NOT FIT": "لا يناسب",
  "TO CONFIRM": "للتأكيد",
  PASS: "مستوفى",
  "DATA MISSING": "بيانات ناقصة",
  "ANSWERS TO CHECK": "إجابات للمراجعة",
  "SPECIALIST REVIEW": "مراجعة مختص",
  "verified rule": "قاعدة متحقق منها",
  "rule of thumb": "قاعدة تقريبية",
  UNCERTAIN: "غير مؤكد",
  verified: "متحقق منه",
  "CHECKED: every reason behind it is approved for public display": "تم التحقق: كل سبب وراءه معتمد للعرض العام",
};
const tagAr = (t: string) => {
  const parts = t.split(", ");
  return parts.map((p) => (p === "stale" ? "قديم" : TAGS[p] ?? ltr(p))).join("، ");
};

const TOPICS: Record<string, string> = {
  "a point about the structure": "نقطة تخص الهيكل",
  "a point about this place": "نقطة تخص هذه الجهة",
  "a licence or approval": "رخصة أو موافقة",
  "an obligation after setup": "التزام بعد التأسيس",
  "a cross-border point": "نقطة عابرة للحدود",
  "a point": "نقطة",
};

const STATUS: Record<string, string> = {
  fits: "يناسب",
  "fits, with conditions": "يناسب بشروط",
  "to be verified": "قيد التحقق",
  "data missing": "بيانات ناقصة",
  "does not fit": "لا يناسب",
};

const STRUCTURE: Record<string, string> = {
  "Free zone company": "شركة منطقة حرة",
  "Mainland company": "شركة في البر الرئيسي",
  "Offshore company": "شركة خارجية (أوفشور)",
  "DIFC or ADGM company": "شركة في مركز دبي المالي العالمي أو سوق أبوظبي العالمي",
};
const structureAr = (s: string) => STRUCTURE[s] ?? ltr(s);

const PROFILE_KEYS: Record<string, string> = {
  Company: "الشركة",
  Activity: "النشاط",
  Customers: "العملاء",
  "Residence visas": "تأشيرات الإقامة",
  Premises: "المقر",
  "Setup budget": "ميزانية التأسيس",
  "Expected yearly revenue": "الإيرادات السنوية المتوقعة",
  Owners: "المالكون",
  "Owner tax resident outside the UAE": "مالك مقيم ضريبياً خارج الإمارات",
  "Structure in mind": "الهيكل المفضل",
  "Wants to start": "موعد البدء",
  Emirate: "الإمارة",
  "Place in mind": "الجهة المفضلة",
};
const PROFILE_VALUES: Record<string, string> = {
  "inside the UAE": "داخل الإمارات",
  "outside the UAE": "خارج الإمارات",
  "inside and outside the UAE": "داخل الإمارات وخارجها",
  "a company": "شركة",
  "one or more individuals": "فرد أو أكثر",
  yes: "نعم",
  no: "لا",
  "within a month": "خلال شهر",
  "within three months": "خلال ثلاثة أشهر",
  later: "لاحقاً",
  ...STRUCTURE,
};

const COLUMNS: Record<string, string> = { Place: "الجهة", Emirate: "الإمارة", Status: "الحالة", "Setup estimate": "تقدير التأسيس", Visas: "التأشيرات", Timeline: "المدة" };

const EXACT: Record<string, string> = {
  "No structure fits every answer yet: a specialist at MKW Advisors looks at the case.": "لا يناسب أي هيكل كل الإجابات بعد: ينظر مختص في MKW Advisors في الحالة.",
  "The structure is to be confirmed by a person: not every reason behind it is approved for public display yet.": "يؤكد شخص الهيكل: لم تُعتمد بعد كل الأسباب وراءه للعرض العام.",
  "No place fits every answer yet.": "لا توجد جهة تناسب كل الإجابات بعد.",
  "No places to show yet; a person reviews which fit.": "لا جهات للعرض بعد؛ يراجع شخص ما يناسب منها.",
  "None shown: every place the engine knows is listed above, as fitting or to be verified.": "لا شيء: كل جهة يعرفها النظام مذكورة أعلاه، مناسبة أو قيد التحقق.",
  "Nothing to show yet.": "لا شيء للعرض بعد.",
  "None raised by your answers.": "لم تُثر إجاباتك أياً منها.",
  "None raised by the answers.": "لم تُثر الإجابات أياً منها.",
  "None: every answer the engine needed was given.": "لا شيء: قُدّمت كل إجابة احتاجها النظام.",
  "No recommendation is made on this page; a person at MKW Advisors reviews the case first.": "لا توصية في هذا التقرير؛ يراجع شخص في MKW Advisors الحالة أولاً.",
  "Ask MKW Advisors to review this: a person checks every point marked to be verified, confirms what applies to you, and sends priced offers from vetted partner firms. No payment until you accept an offer.":
    "اطلب من MKW Advisors مراجعة هذا: يتحقق شخص من كل نقطة قيد التحقق، ويؤكد ما ينطبق عليك، ويرسل عروضاً مسعّرة من شركات شريكة معتمدة. لا دفع حتى تقبل عرضاً.",
  "Open the page again with your saved code to see this result on the rules of that day.": "افتح الصفحة مجدداً برمزك المحفوظ لترى هذه النتيجة وفق قواعد ذلك اليوم.",
  "No structure fits every answer as they stand; the structure named below is an explanation, not a recommendation.": "لا يناسب أي هيكل كل الإجابات كما هي؛ الهيكل المذكور أدناه شرح وليس توصية.",
  "No structure recommended.": "لا هيكل موصى به.",
  "No place fits every answer.": "لا توجد جهة تناسب كل الإجابات.",
  "None.": "لا شيء.",
  "Some points above rest on rules or figures marked rule of thumb or UNCERTAIN; they are confirmed before the offer is priced and nothing is filed on them.":
    "تستند بعض النقاط أعلاه إلى قواعد أو أرقام موسومة بقاعدة تقريبية أو غير مؤكد؛ تُؤكَّد قبل تسعير العرض ولا يُقدَّم عليها أي ملف.",
  "Every point above rests on a verified rule or figure as of the data date.": "تستند كل نقطة أعلاه إلى قاعدة أو رقم متحقق منه حتى تاريخ البيانات.",
  "Your request is with MKW Advisors; the offers that follow price exactly the structure and place settled here. Sign in to Tasees to follow the request and reply to any question.":
    "طلبك لدى MKW Advisors؛ تسعّر العروض التالية الهيكل والجهة المحددين هنا بالضبط. سجّل الدخول إلى تأسيس لمتابعة الطلب والرد على أي سؤال.",
  "None shown yet: a place's official source appears once a named person has checked its figures.": "لا شيء بعد: يظهر المصدر الرسمي لجهة ما بعد أن يتحقق شخص مسمّى من أرقامها.",
  "No official source is on record for the places above.": "لا يوجد مصدر رسمي مسجّل للجهات أعلاه.",
  "  Figures: to be verified by a person": "  الأرقام: يتحقق منها شخص",
  "  Yearly renewal: to be verified": "  التجديد السنوي: قيد التحقق",
  "  Yearly renewal: not on record": "  التجديد السنوي: غير مسجّل",
  "  the place you named": "  الجهة التي ذكرتها",
  "Preliminary general information, not advice. Tasees is a service of MKW Advisors; partner firms deliver the work; MKW Advisors manages scope, price, quality and payment. Nothing is filed automatically.":
    "معلومات عامة أوّلية، وليست مشورة. تأسيس خدمة من MKW Advisors؛ تنفّذ الشركات الشريكة العمل، وتدير MKW Advisors النطاق والسعر والجودة والدفع. لا يُقدَّم أي ملف تلقائياً.",
  "Reviewed advice for the client named above. Tasees is a service of MKW Advisors; partner firms deliver the work; MKW Advisors manages scope, price, quality and payment. Nothing is filed automatically.":
    "مشورة مراجَعة للعميل المذكور أعلاه. تأسيس خدمة من MKW Advisors؛ تنفّذ الشركات الشريكة العمل، وتدير MKW Advisors النطاق والسعر والجودة والدفع. لا يُقدَّم أي ملف تلقائياً.",
  "PRELIMINARY: general information from your answers, not reviewed by a person and not advice.": "أوّلي: معلومات عامة من إجاباتك، لم يراجعها شخص، وليست مشورة.",
  "PRELIMINARY: your request is with MKW Advisors for review; this is general information from your answers, not advice.": "أوّلي: طلبك لدى MKW Advisors للمراجعة؛ هذه معلومات عامة من إجاباتك وليست مشورة.",
  "REVIEWED by MKW Advisors.": "تمت المراجعة من MKW Advisors.",
};

const money = (a: string, b: string) => `من ${ltr(`AED ${a}`)} إلى ${ltr(`AED ${b}`)}`;
const days = (n: string) => `نحو ${n} يوم عمل`;

/** A finding or statement with its tag at the start: the tag in Arabic, the approved text as written. */
const tagged = (m: RegExpMatchArray) => {
  const [, indent, tag, rest] = m;
  const topic = TOPICS[rest!];
  return `${indent}[${tagAr(tag!)}] ${topic ?? ltr(rest!)}`;
};

const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^REVIEWED by (.+) at MKW Advisors on (\S+)\.$/, (m) => `تمت المراجعة من ${ltr(m[1]!)} في MKW Advisors بتاريخ ${ltr(m[2]!)}.`],
  [/^Pathway that fits your answers: (.+) \[(CHECKED: .+)\]$/, (m) => `الهيكل الذي يناسب إجاباتك: ${structureAr(m[1]!)} [${tagAr(m[2]!)}]`],
  [/^Recommended structure: (.+)$/, (m) => `الهيكل الموصى به: ${structureAr(m[1]!)}`],
  [/^The answers point to: (.+)\. A person at MKW Advisors confirms it against the current rules before anything is priced\.$/, (m) => `تشير الإجابات إلى: ${structureAr(m[1]!)}. يؤكده شخص في MKW Advisors وفق القواعد الحالية قبل أي تسعير.`],
  [/^(\d+) of (\d+) statements and (\d+) of (\d+) places in this report have been checked by a named person for public display; the rest are marked to be verified\.$/,
    (m) => `تحقق شخص مسمّى من ${m[1]} من ${m[2]} عبارة و${m[3]} من ${m[4]} جهة في هذا التقرير للعرض العام؛ والباقي موسوم «قيد التحقق».`],
  [/^Rules and place data as of (\S+)\.$/, (m) => `القواعد وبيانات الجهات حتى ${ltr(m[1]!)}.`],
  [/^Rules and place data as of (\S+)\. Nothing in this report is a statutory conclusion or a filing; a priced offer follows a person's scoping review\.$/,
    (m) => `القواعد وبيانات الجهات حتى ${ltr(m[1]!)}. لا شيء في هذا التقرير استنتاج قانوني أو ملف مقدَّم؛ يأتي العرض المسعّر بعد مراجعة شخص للنطاق.`],
  // A structure line: "Free zone company: to be verified; [TAG] text; [TAG] text"
  [/^(Free zone company|Mainland company|Offshore company|DIFC or ADGM company): ([a-z ,]+?)((?:; .+)?)$/,
    (m) => `${structureAr(m[1]!)}: ${STATUS[m[2]!] ?? ltr(m[2]!)}${m[3] ? m[3].slice(2).split("; ").map((f) => `؛ ${line(f)}`).join("") : ""}`],
  // A place's heading line: "IFZA (Dubai, licensed by IFZA Authority): fits"
  [/^(.+?) \((.+?)(?:, licensed by (.+))?\): (fits|fits, with conditions|to be verified|data missing|does not fit)$/,
    (m) => `${ltr(m[1]!)} (${ltr(m[2]!)}${m[3] ? `، مرخّصة من ${ltr(m[3])}` : ""}): ${STATUS[m[4]!]}`],
  // An excluded place: "RAK ICC: does not fit; [TAG] text" or "...: does not fit (the reason is to be verified by a person)"
  [/^(.+?): does not fit \(the reason is to be verified by a person\)$/, (m) => `${ltr(m[1]!)}: لا يناسب (يتحقق شخص من السبب)`],
  [/^(.+?): does not fit; (.+)$/, (m) => `${ltr(m[1]!)}: لا يناسب؛ ${line(m[2]!)}`],
  [/^(.+?): does not fit$/, (m) => `${ltr(m[1]!)}: لا يناسب`],
  // Place details, indented.
  [/^ {2}Setup estimate AED ([\d,]+) to AED ([\d,]+) \[([^\]]+)\]; (\d+) visa\(s\) in the standard package; about (\d+) working days$/,
    (m) => `  تقدير التأسيس ${money(m[1]!, m[2]!)} [${tagAr(m[3]!)}]؛ ${m[4]} تأشيرة في الباقة الأساسية؛ ${days(m[5]!)}`],
  [/^ {2}Yearly renewal estimate AED ([\d,]+) to AED ([\d,]+) \[([^\]]+)\]$/, (m) => `  تقدير التجديد السنوي ${money(m[1]!, m[2]!)} [${tagAr(m[3]!)}]`],
  [/^ {2}Facilities on record: (.+)$/, (m) => `  المرافق المسجّلة: ${ltr(m[1]!)}`],
  [/^ {2}(?:Official source|Source): (\S+)$/, (m) => `  المصدر الرسمي: ${ltr(m[1]!)}`],
  [/^ {2}in (.+)$/, (m) => `  في ${ltr(m[1]!)}`],
  [/^ {2}known for (.+) businesses$/, (m) => `  معروفة بأنشطة ${ltr(m[1]!)}`],
  [/^ {2}(\d+) visa\(s\) in the standard package$/, (m) => `  ${m[1]} تأشيرة في الباقة الأساسية`],
  // Tagged statements and findings, at the start or (with a confidence) at the end.
  [/^(\s*)\[([A-Z][A-Z :,]*?)\] (.+?) \[(verified rule|rule of thumb|UNCERTAIN)\](?: \[(SPECIALIST REVIEW)\])?$/,
    (m) => `${m[1]}[${tagAr(m[2]!)}] ${ltr(m[3]!)} [${tagAr(m[4]!)}]${m[5] ? ` [${tagAr(m[5])}]` : ""}`],
  [/^(\s*)\[([A-Z][A-Z :,]*?)\] (.+?)(?: \[(SPECIALIST REVIEW)\])?$/, (m) => `${tagged(m)}${m[4] ? ` [${tagAr(m[4])}]` : ""}`],
  [/^(.+) \[(verified rule|rule of thumb|UNCERTAIN)\](?: \[(SPECIALIST REVIEW)\])?$/, (m) => `${ltr(m[1]!)} [${tagAr(m[2]!)}]${m[3] ? ` [${tagAr(m[3])}]` : ""}`],
  // A profile line: "Activity: tech".
  [/^([A-Z][A-Za-z ]+): (.+)$/, (m) => (PROFILE_KEYS[m[1]!] ? `${PROFILE_KEYS[m[1]!]}: ${PROFILE_VALUES[m[2]!] ?? ltr(m[2]!)}` : ltr(m[0]))],
];

/** One line of the report in Arabic; anything the report did not write itself stays as written, isolated. */
function line(raw: string): string {
  // A line is one line: a tab or line break from data is a space, so the patterns still recognise it.
  const l = raw.replace(/[\t\r\n]+/g, " ");
  if (!l) return l;
  if (EXACT[l]) return EXACT[l]!;
  for (const [re, fn] of PATTERNS) {
    const m = l.match(re);
    if (m) return fn(m);
  }
  const indent = l.match(/^\s*/)![0];
  return indent + ltr(l.slice(indent.length));
}

const cell = (c: string): string => {
  const m = c.match(/^AED ([\d,]+) to AED ([\d,]+)(?: \[([^\]]+)\])?$/);
  if (m) return `${money(m[1]!, m[2]!)}${m[3] ? ` [${tagAr(m[3])}]` : ""}`;
  const d = c.match(/^about (\d+) working days$/);
  if (d) return days(d[1]!);
  return STATUS[c] ?? (/^\d+$/.test(c) ? c : ltr(c));
};

export function arabicReport(r: Report): Report {
  const section = (s: ReportSection): ReportSection => ({
    heading: HEADINGS[s.heading] ?? ltr(s.heading),
    lines: s.lines.map(line),
    ...(s.table ? { table: { columns: s.table.columns.map((c) => COLUMNS[c] ?? ltr(c)), rows: s.table.rows.map((row) => row.map(cell)) } } : {}),
  });
  return {
    ...r,
    title: "تقرير تقييم الكيان في الإمارات",
    brand: "تأسيس، من MKW Advisors",
    statusLine: line(r.statusLine),
    sections: r.sections.map(section),
    closing: line(r.closing),
    lang: "ar",
  };
}
