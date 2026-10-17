import type { Rendered, TemplateName, Vars } from "./templates.ts";

/**
 * Arabic client templates (O9). A draft until the owner's Arabic reviewer signs it off; the notifier uses
 * these only for client recipients whose language is Arabic and only once the sign-off is recorded. The
 * brand stays "تأسيس، من MKW Advisors"; amounts, references, codes and links are never translated.
 */
export const BRAND_AR = { name: "Tasees تأسيس، من MKW Advisors", signOff: "Tasees تأسيس، من MKW Advisors" };

const aed = (fils: unknown) => {
  const n = Number(fils ?? 0) / 100;
  return n.toLocaleString("en-AE", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 }) + " درهم";
};
const ref = (id: unknown) => String(id ?? "").slice(0, 8).toUpperCase();

/** Returns null for templates with no Arabic version (the notifier then falls back to English). */
export function renderTemplateAr(template: TemplateName, vars: Vars, appUrl: string): Rendered | null {
  const link = (path: string) => `${appUrl.replace(/\/$/, "")}/#${path}`;
  const sign = `\n\n${BRAND_AR.signOff}`;
  switch (template) {
    case "login_code":
      return { inApp: false, secret: true, subject: `${vars.code} هو رمز الدخول إلى ${BRAND_AR.name}`, body: `رمز الدخول الخاص بك هو ${vars.code}. يعمل لمدة 10 دقائق ولمرة واحدة فقط.\n\nإذا لم تطلب رمزاً، يمكنك تجاهل هذه الرسالة.${sign}` };
    case "offer_ready":
      return { inApp: true, subject: "عروضك جاهزة", body: `قمنا بتسعير طلبك وعروضك جاهزة للمراجعة. افتح ${link(`/offer/${vars.offerId}`)} لمقارنتها وقبول العرض الذي يناسبك.\n\nيعرض كل عرض سعراً واحداً واضحاً، مع ضريبة القيمة المضافة والرسوم الحكومية مدرجة بشكل منفصل.${sign}` };
    case "payment_due":
      return {
        inApp: true,
        subject: vars.kind === "balance" ? `الرصيد المتبقي ${aed(vars.amountFils)} مستحق عند الإنجاز` : `دفعة مقدمة ${aed(vars.amountFils)} لبدء العمل`,
        body:
          (vars.kind === "balance"
            ? `اكتمل العمل. الرصيد المتبقي ${aed(vars.amountFils)} (النصف الثاني من الأتعاب المهنية) مستحق الآن.`
            : `شكراً لقبولك العرض. لبدء العمل، يرجى سداد الدفعة المقدمة ${aed(vars.amountFils)}: نصف الأتعاب المهنية بالإضافة إلى جميع الرسوم الحكومية التي نمررها بسعر التكلفة.`) +
          `\n\nيمكنك الدفع بالتحويل المصرفي إلى MKW Advisors مع ذكر المرجع ${ref(vars.engagementId)}${vars.payUrl ? `، أو بالبطاقة عبر ${vars.payUrl}` : ""}. صفحة العمل: ${link(`/engagement/${vars.engagementId}`)}.${sign}`,
      };
    case "milestone_ready_for_review":
      return { inApp: true, subject: "خطوة جاهزة لموافقتك", body: `راجعت MKW Advisors خطوة من عملك وهي جاهزة لموافقتك: ${link(`/engagement/${vars.engagementId ?? ""}`)}.\n\nإذا لم تتخذ أي إجراء خلال 5 أيام عمل، تُعتبر الخطوة معتمدة وفق شروط العميل.${sign}` };
    case "change_order_to_approve":
      return { inApp: true, subject: "تغيير في نطاق العمل يحتاج موافقتك", body: `اقترح الشريك المنفذ تغييراً في نطاق عملك وقامت MKW Advisors بتسعيره. يرجى الموافقة عليه أو رفضه عبر ${link(`/engagement/${vars.engagementId ?? ""}`)}. لا يبدأ أي عمل إضافي قبل موافقتك.${sign}` };
    case "invoice_issued":
      return {
        inApp: true,
        subject: vars.creditNote ? `إشعار دائن ${vars.number} بمبلغ ${aed(vars.amountFils)}` : `فاتورة ضريبية ${vars.number} بمبلغ ${aed(vars.amountFils)}`,
        body: vars.creditNote
          ? `قمنا برد مبلغ ${aed(vars.amountFils)} وأصدرنا إشعاراً دائناً رقم ${vars.number}. يمكنك تنزيله من صفحة العمل: ${link(`/engagement/${vars.engagementId}`)}.${sign}`
          : `شكراً لسدادك مبلغ ${aed(vars.amountFils)}. الفاتورة الضريبية ${vars.number} جاهزة للتنزيل من صفحة العمل: ${link(`/engagement/${vars.engagementId}`)}.${sign}`,
      };
    case "intake_received":
      return { inApp: true, subject: "استلمنا طلبك", body: `شكراً لك. استلمنا طلبك لـ ${vars.company} ونعمل على إعداد عروضك؛ وحيثما تكون قاعدة ما غير مؤكدة لحالتك، يتحقق منها شخص أولاً.${vars.newAccount ? `\n\nتم إنشاء حساب لك. سجّل الدخول بعنوان البريد هذا عبر ${link("/")}: نرسل رمزاً من ستة أرقام في كل مرة، دون كلمة مرور.` : `\n\nتابع التقدم عبر ${link("/")}.`}${sign}` };
    case "intake_signin":
      return { inApp: false, subject: "تابع طلبك", body: `شكراً لتواصلك. للمتابعة، سجّل الدخول بعنوان البريد هذا عبر ${link("/")}: نرسل رمزاً من ستة أرقام في كل مرة، دون كلمة مرور. إذا لم تملأ نموذجنا، يمكنك تجاهل هذه الرسالة.${sign}` };
    case "documents_requested":
      return { inApp: true, subject: `مستندات مطلوبة لعملك ${ref(vars.engagementId)}`, body: `لبدء "${vars.step}" نحتاج منك ${vars.count} مستند(ات): ${vars.kinds}. ارفعها عبر ${link(`/engagement/${vars.engagementId}`)}. تُحفظ ملفاتك داخل الإمارات ولا تُشارك إلا مع الشركة المنفذة لهذا العمل.${sign}` };
    case "step_delayed_client":
      return { inApp: true, subject: `تحديث بشأن عملك ${ref(vars.engagementId)}: "${vars.step}" متأخرة`, body: `كان موعد "${vars.step}" في ${vars.dueDate} ولم تكتمل بعد. الموعد الجديد المتوقع هو ${vars.expectedDate}. نحن نتابع الأمر؛ وإذا تأخرت خطوة أكثر من خمسة أيام عمل، يسري ضمان الخدمة: يُحتسب رصيد من جزء من الأتعاب وفق القاعدة ويؤكده فريقنا.\n\n${link(`/engagement/${vars.engagementId}`)}${sign}` };
    case "guarantee_credit":
      return { inApp: true, subject: `رصيد ضمان الخدمة بقيمة ${vars.amountAed} درهم على ${ref(vars.engagementId)}`, body: `تأخرت "${vars.step}" أكثر من خمسة أيام عمل، لذا وبموجب ضمان الخدمة يُضاف لك رصيد بقيمة ${vars.amountAed} درهم${vars.how === "applied" ? " ويُخصم من دفعة الرصيد المتبقي" : "؛ وسيتولى فريق المالية لدينا ترتيب الاسترداد"}.\n\n${link(`/engagement/${vars.engagementId}`)}${sign}` };
    case "obligation_reminder":
      return {
        inApp: true,
        subject: vars.when === "overdue" ? `متأخر: ${vars.title} كان مستحقاً في ${vars.dueDate}` : `تذكير: ${vars.title} مستحق في ${vars.dueDate} (${vars.when === "7 days" ? "7 أيام" : vars.when === "30 days" ? "30 يوماً" : vars.when})`,
        body: `${vars.title} مستحق في ${vars.dueDate}${vars.when === "overdue" ? " ولم نستلم منك تأكيد التقديم بعد" : ""}.${vars.uncertain ? " هذا التاريخ تقدير من جانبنا (غير مؤكد)؛ تحقق منه مع MKW Advisors قبل الاعتماد عليه." : ""}\n\nعند التقديم، ارفع التأكيد عبر ${link("/compliance")} ونسجله كمنجز. نحن لا نقدّم الإقرارات نيابة عنك؛ اطلب منا ذلك كخدمة إن رغبت.${sign}`,
      };
    case "user_invited":
      return { inApp: false, subject: `تمت إضافتك إلى ${BRAND_AR.name}`, body: `تم إنشاء حساب لك لدى ${vars.orgName}. سجّل الدخول ببريد عملك عبر ${link("/")}؛ نرسل لك رمزاً من ستة أرقام في كل مرة، دون كلمة مرور.${sign}` };
    default:
      return null;
  }
}
