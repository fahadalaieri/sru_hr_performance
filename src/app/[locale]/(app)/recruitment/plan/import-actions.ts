"use server";

import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PLAN_ITEM_IMPORT_COLUMNS } from "@/lib/importColumns";
import { recruitmentPriorities, recruitmentPriorityLabels } from "@/lib/recruitmentPlan";
import { applyMapping, parseImportOptions, updatesExisting, writesField } from "@/lib/excelImportOptions";
import { cellNumber, cellText, headerMap, loadImportWorkbook } from "@/lib/excelImport";

export type PlanItemsImportResult =
  | {
      status: "success";
      summary: { created: number; updated: number; skipped: number; rowErrors: string[] };
    }
  | { status: "error"; message: "invalid_input" | "unauthenticated" | "not_found" | "forbidden" | "unknown" };

/** رقم من خلية قد تصل نصًّا («٣» أو "3" أو 3). القيمة غير الرقمية تُردّ null. */

const C = PLAN_ITEM_IMPORT_COLUMNS;

/** «عالية» أو "high" — كلاهما يُقبل، فالملف قد يأتي من تصديرنا أو من يد كاتب. */
function parsePriority(raw: string | null): string | null | undefined {
  if (raw == null) return null;
  const normalized = raw.trim();
  const byCode = recruitmentPriorities.find((p) => p === normalized.toLowerCase());
  if (byCode) return byCode;
  const byLabel = recruitmentPriorities.find((p) => recruitmentPriorityLabels[p] === normalized);
  // `undefined` تعني قيمةً مكتوبة لكنها غير مفهومة — تُبلَّغ ولا تُخمَّن.
  return byLabel ?? undefined;
}

/** «الربع الأول» أو "Q1" أو "1". */
function parseQuarter(raw: string | null): number | null | undefined {
  if (raw == null) return null;
  const text = raw.trim();
  const direct = cellNumber(text);
  if (direct != null && Number.isInteger(direct) && direct >= 1 && direct <= 4) return direct;
  const q = /^q\s*([1-4])$/i.exec(text);
  if (q) return Number(q[1]);
  const arabic: Record<string, number> = {
    "الربع الأول": 1,
    "الربع الثاني": 2,
    "الربع الثالث": 3,
    "الربع الرابع": 4,
  };
  return arabic[text] ?? undefined;
}

/**
 * استيراد بنود خطة التوظيف من ملف إكسل.
 *
 * يمرّ بالحوار المشترك (`ExcelImportDialog`)، فيأتي منه ثلاثة اختيارات:
 * أيُحدَّث الموجود أم يُضاف الجديد وحده، وأي عمود يقابل أي حقل، وأي الحقول
 * تُكتب فعلًا. لا شيء من ذلك يُعاد تنفيذه هنا.
 *
 * الصلاحية من RLS وحدها: كل كتابة تمرّ بعميل المستخدم نفسه، فالحاجز هو
 * `recruitment_plan_items_insert/update` كما هو للإضافة اليدوية — لا بوابة
 * ثانية في هذا الملف. وقراءة الخطة أولًا تكشف حالتها، إذ لا يُستورَد إلى
 * خطة غادرت يد الإعداد.
 *
 * [استنتاج] مفتاح التكرار: `recruitment_plan_items` لها فهرس فريد على
 * (plan_id, position_id) فقط، و`position_id` تبقى فارغة للبنود المستورَدة
 * (لا عمود لها في الملف)، فلا شيء يمنع تكرار الصف نفسه مرارًا. عُومل
 * (plan_id, org_unit_id, job_title_id) بين غير المحذوفة مفتاحًا طبيعيًا —
 * بندٌ واحد لكل مسمى في كل وحدة — كما فُعل في استيراد الشواغر وللسبب نفسه.
 * ومن أراد بندين لنفس المسمى في نفس الوحدة لا يعبّر عنهما بهذا الاستيراد.
 */
export async function importPlanItemsExcel(
  _prevState: PlanItemsImportResult | null,
  formData: FormData
): Promise<PlanItemsImportResult> {
  const file = formData.get("file");
  const planId = formData.get("planId");
  if (!(file instanceof File) || file.size === 0 || typeof planId !== "string" || planId === "") {
    return { status: "error", message: "invalid_input" };
  }

  const supabase = await createClient();
  const {
    data: { user: actor },
  } = await supabase.auth.getUser();
  if (!actor) return { status: "error", message: "unauthenticated" };

  const { data: plan } = await supabase
    .from("recruitment_plans")
    .select("id, status")
    .eq("id", planId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!plan) return { status: "error", message: "not_found" };
  // خطةٌ غادرت الإعداد راجعتها المالية واعتمدها صاحب الاعتماد على بنودها،
  // فإضافة بنود إليها بعد ذلك تغيّر ما اعتُمد دون أن يمرّ بأحد.
  if (plan.status !== "draft") return { status: "error", message: "forbidden" };

  // Size and row limits are enforced here, not only in the preview dialog
  // (src/lib/excelImport.ts). A limit the import itself does not check is
  // no limit, since this action can be called directly with any file.
  const loaded = await loadImportWorkbook(file);
  if (!loaded.ok) return { status: "error", message: "invalid_input" };
  const workbook = loaded.workbook;

  const sheet =
    workbook.worksheets.find((w) => w.name.trim() === "بنود الخطة") ??
    workbook.worksheets.find((w) => /بنود|خطة/.test(w.name)) ??
    workbook.worksheets[0];
  if (!sheet) return { status: "error", message: "invalid_input" };

  const options = parseImportOptions(formData);
  const cols = applyMapping(headerMap(sheet), options, C);
  if (!cols.has(C.orgUnit)) return { status: "error", message: "invalid_input" };

  const get = (row: ExcelJS.Row, col: string) => (cols.has(col) ? row.getCell(cols.get(col)!).value : null);

  interface ParsedRow {
    rowNumber: number;
    orgUnitNameAr: string;
    jobTitleNameAr: string | null;
    jobFamilyNameAr: string | null;
    headcount: number | null;
    targetQuarter: number | null;
    priority: string | null;
    monthlyCost: number | null;
    justification: string | null;
  }

  const parsed: ParsedRow[] = [];
  const rowErrors: string[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const orgUnitNameAr = cellText(get(row, C.orgUnit));
    const jobTitleNameAr = cellText(get(row, C.jobTitle));
    if (!orgUnitNameAr && !jobTitleNameAr) continue;
    if (!orgUnitNameAr) {
      rowErrors.push(`الصف ${r}: الوحدة التنظيمية مطلوبة — تم التجاوز`);
      continue;
    }

    const headcount = cellNumber(get(row, C.headcount));
    if (headcount != null && (!Number.isInteger(headcount) || headcount < 1)) {
      rowErrors.push(`الصف ${r}: العدد المطلوب يجب أن يكون رقمًا صحيحًا أكبر من صفر — تم التجاوز`);
      continue;
    }

    const quarter = parseQuarter(cellText(get(row, C.targetQuarter)));
    if (quarter === undefined) {
      rowErrors.push(`الصف ${r}: الربع المستهدف غير مفهوم (المتوقع ١-٤ أو «الربع الأول») — تم التجاوز`);
      continue;
    }

    const priority = parsePriority(cellText(get(row, C.priority)));
    if (priority === undefined) {
      rowErrors.push(`الصف ${r}: الأولوية غير مفهومة (المتوقع عالية/متوسطة/منخفضة) — تم التجاوز`);
      continue;
    }

    const monthlyCost = cellNumber(get(row, C.monthlyCost));
    if (monthlyCost != null && monthlyCost < 0) {
      rowErrors.push(`الصف ${r}: التكلفة الشهرية لا تصح سالبة — تم التجاوز`);
      continue;
    }

    parsed.push({
      rowNumber: r,
      orgUnitNameAr,
      jobTitleNameAr,
      jobFamilyNameAr: cellText(get(row, C.jobFamily)),
      headcount,
      targetQuarter: quarter,
      priority,
      monthlyCost,
      justification: cellText(get(row, C.justification)),
    });
  }

  // البيانات المرجعية بعميل المستخدم نفسه: ما لا يراه لا يُطابَق، فيظهر
  // خطأً في صفّه بدل كتابةٍ صامتة خارج نطاقه.
  const [{ data: orgUnitsData }, { data: jobTitlesData }, { data: jobFamiliesData }] = await Promise.all([
    supabase.from("org_units").select("id, name_ar"),
    supabase.from("job_titles").select("id, name_ar, job_family_id").is("deleted_at", null),
    supabase.from("job_families").select("id, name_ar"),
  ]);

  const familyNameById = new Map((jobFamiliesData ?? []).map((f) => [f.id, f.name_ar]));

  const orgUnitIdsByName = new Map<string, string[]>();
  for (const ou of orgUnitsData ?? []) {
    const list = orgUnitIdsByName.get(ou.name_ar) ?? [];
    list.push(ou.id);
    orgUnitIdsByName.set(ou.name_ar, list);
  }

  const jobTitlesByName = new Map<string, { id: string; familyNameAr: string | null }[]>();
  for (const jt of jobTitlesData ?? []) {
    const list = jobTitlesByName.get(jt.name_ar) ?? [];
    list.push({ id: jt.id, familyNameAr: familyNameById.get(jt.job_family_id) ?? null });
    jobTitlesByName.set(jt.name_ar, list);
  }

  const { data: existingItems } = await supabase
    .from("recruitment_plan_items")
    .select("id, org_unit_id, job_title_id")
    .eq("plan_id", planId)
    .is("deleted_at", null);

  const naturalKey = (orgUnitId: string, jobTitleId: string | null) => `${orgUnitId}::${jobTitleId ?? ""}`;
  const existingByKey = new Map(
    (existingItems ?? []).map((i) => [naturalKey(i.org_unit_id, i.job_title_id), i.id])
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of parsed) {
    const orgUnitIds = orgUnitIdsByName.get(row.orgUnitNameAr) ?? [];
    if (orgUnitIds.length === 0) {
      rowErrors.push(`الصف ${row.rowNumber}: لا توجد وحدة تنظيمية بالاسم «${row.orgUnitNameAr}» — تم التجاوز`);
      continue;
    }
    if (orgUnitIds.length > 1) {
      rowErrors.push(`الصف ${row.rowNumber}: الاسم «${row.orgUnitNameAr}» يطابق أكثر من وحدة تنظيمية — تم التجاوز`);
      continue;
    }

    let jobTitleId: string | null = null;
    if (row.jobTitleNameAr) {
      let candidates = jobTitlesByName.get(row.jobTitleNameAr) ?? [];
      if (candidates.length === 0) {
        rowErrors.push(`الصف ${row.rowNumber}: لا يوجد مسمى وظيفي بالاسم «${row.jobTitleNameAr}» — تم التجاوز`);
        continue;
      }
      // اسم المسمى فريد داخل العائلة لا مطلقًا، فعمود العائلة يفصل بين
      // المتشابهَين. وما بقي ملتبسًا يُبلَّغ ولا يُخمَّن.
      if (candidates.length > 1 && row.jobFamilyNameAr) {
        candidates = candidates.filter((c) => c.familyNameAr === row.jobFamilyNameAr);
      }
      if (candidates.length !== 1) {
        rowErrors.push(
          `الصف ${row.rowNumber}: الاسم «${row.jobTitleNameAr}» يطابق أكثر من مسمى وظيفي — حدّد العائلة الوظيفية — تم التجاوز`
        );
        continue;
      }
      jobTitleId = candidates[0].id;
    }

    const key = naturalKey(orgUnitIds[0], jobTitleId);
    const existingId = existingByKey.get(key);

    // الحقول التي أذن الحوار بكتابتها فقط.
    const writable: Record<string, unknown> = {};
    if (writesField(options, "headcount") && row.headcount != null) writable.headcount = row.headcount;
    if (writesField(options, "targetQuarter")) writable.target_quarter = row.targetQuarter;
    if (writesField(options, "priority")) writable.priority = row.priority;
    if (writesField(options, "monthlyCost")) writable.estimated_monthly_cost = row.monthlyCost;
    if (writesField(options, "justification")) writable.justification = row.justification;

    if (existingId) {
      if (!updatesExisting(options)) {
        skipped += 1;
        continue;
      }
      if (Object.keys(writable).length === 0) {
        skipped += 1;
        continue;
      }
      const { error } = await supabase.from("recruitment_plan_items").update(writable).eq("id", existingId);
      if (error) {
        rowErrors.push(`الصف ${row.rowNumber}: تعذّر التحديث — ${error.message}`);
        continue;
      }
      updated += 1;
      continue;
    }

    const { data: inserted, error } = await supabase
      .from("recruitment_plan_items")
      .insert({
        plan_id: planId,
        org_unit_id: orgUnitIds[0],
        job_title_id: jobTitleId,
        headcount: row.headcount ?? 1,
        ...writable,
      })
      .select("id")
      .single();
    if (error) {
      rowErrors.push(`الصف ${row.rowNumber}: تعذّر الإدراج — ${error.message}`);
      continue;
    }
    created += 1;
    // يمنع تكرار صفّين متطابقين داخل الملف نفسه من إنشاء بندين.
    existingByKey.set(key, inserted.id);
  }

  const admin = createAdminClient();
  await admin.from("audit_log").insert({
    actor_id: actor.id,
    action: "recruitment_plan_items_excel_imported",
    entity: "recruitment_plans",
    entity_id: planId,
    after_data: { created, updated, skipped, rowErrorCount: rowErrors.length, mode: options.mode },
  });

  return { status: "success", summary: { created, updated, skipped, rowErrors } };
}
