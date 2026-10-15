/**
 * Canonical field key -> the column label each importer reads it from.
 *
 * These live here, and not beside their importers, for a hard reason: an
 * import action is a `"use server"` module, and such a module may only export
 * async functions. Exporting these objects from there compiled fine and
 * type-checked fine, then failed at runtime with
 * `A "use server" file can only export async functions, found object` — found
 * by loading the page, not by any check before it.
 */

export const VACANCY_IMPORT_COLUMNS = {
  jobTitle: "المسمى الوظيفي",
  orgUnit: "الوحدة التنظيمية",
  jobFamily: "العائلة الوظيفية",
  status: "الحالة",
  requirements: "المتطلبات",
} as const;

export const JOB_TITLE_IMPORT_COLUMNS = {
  nameAr: "اسم المسمى الوظيفي",
  jobFamily: "العائلة الوظيفية",
  gradeLevel: "الدرجة",
  category: "الفئة",
  nameEn: "الاسم بالإنجليزية",
  qualification: "المؤهل المطلوب",
  description: "الوصف",
} as const;

export const CAREER_PATH_IMPORT_COLUMNS = {
  fromJobTitle: "من (المسمى الوظيفي)",
  toJobTitle: "إلى (المسمى الوظيفي)",
  requirements: "متطلبات الانتقال",
} as const;

/**
 * التقييم الدائري (360): the "قالب" workbook -- one sheet per catalog
 * table (rater_group / rating_scale / competency / item). Column headers
 * are the literal snake_case field names given directly by the project
 * owner ("بمفاتيح مطابقة لملف الاستيراد المرفق") rather than this app's
 * usual Arabic-label convention, since no actual reference file exists to
 * derive Arabic labels from -- the given field names ARE the reference.
 */
export const THREE_SIXTY_RATER_GROUP_COLUMNS = {
  relationshipCode: "relationship_code",
  nameAr: "name_ar",
  groupWeightPct: "group_weight_pct",
  minRatersInGroup: "min_raters_in_group",
  maxRatersInGroup: "max_raters_in_group",
  shownSeparately: "shown_separately",
  employeeMayNominate: "employee_may_nominate",
} as const;

export const THREE_SIXTY_RATING_SCALE_COLUMNS = {
  scaleCode: "scale_code",
  optionCode: "option_code",
  labelAr: "label_ar",
  numericValue: "numeric_value",
  countedInScore: "counted_in_score",
} as const;

export const THREE_SIXTY_COMPETENCY_COLUMNS = {
  competencyCode: "competency_code",
  nameAr: "name_ar",
  definitionAr: "definition_ar",
  weightPct: "weight_pct",
  appliesTo: "applies_to",
} as const;

export const THREE_SIXTY_ITEM_COLUMNS = {
  itemCode: "item_code",
  competencyCode: "competency_code",
  itemType: "item_type",
  textAr: "text_ar",
  raterGroups: "rater_groups",
  required: "required",
  reverseScored: "reverse_scored",
  scaleCode: "scale_code",
  displayOrder: "display_order",
  behavioralLevel: "behavioral_level",
} as const;

/**
 * Spans BOTH sheets of the employees/org-structure workbook. The mapping is
 * applied to each sheet's own header row, so a label only ever matches the
 * sheet that actually has it.
 */
export const ORG_STRUCTURE_IMPORT_COLUMNS = {
  employeeNumber: "EMPLOYEE NUMBER",
  fullNameAr: "اسم الموظف",
  email: "EMAIL ID",
  fullNameEn: "Employee Name",
  gradeCode: "GRADE CODE",
  hireDate: "Hire Date",
  qualification: "Qualification",
  educationSpeciality: "Education Speciality",
  dateOfBirth: "DATE OF BIRTH (YYYY-MM-DD)",
  mobile: "Mobile",
  maritalStatus: "MARITIAL STATUS",
  gender: "GENDER",
  nationality: "NATIONALITY",
  department: "الادارة",
  positionAr: "اسم الوظيفة",
  positionEn: "POSITION",
  employeeCategory: "Category",
  insuranceCategory: "Insurance Category",
  role: "الدور في النظام",
  supervisorNumber: "الرقم الوظيفي للرئيس المباشر",
  structLevel: "المستوى",
  structCode: "الرمز",
  structUnit: "الوحدة التنظيمية",
  structUnitEn: "Organizational Unit",
  structParentCode: "رمز التبعية",
  structHolderNumber: "الرقم الوظيفي لمن يشغل المنصب",
} as const;

export const COMPETENCY_IMPORT_COLUMNS = {
  pillar: "المحور",
  domain: "المجال",
  nameAr: "اسم الجدارة",
  classification: "التصنيف",
  jobFamily: "العائلة الوظيفية",
  definition: "التعريف",
  expectedImpact: "الأثر المرجو",
  basic: "أساسي",
  practitioner: "ممارس",
  advanced: "متقدم",
  professional: "محترف",
} as const;

/**
 * بنود خطة التوظيف. الوحدة التنظيمية وحدها إلزامية في قاعدة البيانات
 * (`org_unit_id NOT NULL`)، لكن المسمى الوظيفي يُعامَل مفتاحًا معها لأن
 * البند يُعرَّف بهما معًا — راجع مفتاح التكرار في `import-actions`.
 */
export const PLAN_ITEM_IMPORT_COLUMNS = {
  orgUnit: "الوحدة التنظيمية",
  jobTitle: "المسمى الوظيفي",
  jobFamily: "العائلة الوظيفية",
  headcount: "العدد المطلوب",
  targetQuarter: "الربع المستهدف",
  priority: "الأولوية",
  monthlyCost: "التكلفة الشهرية التقديرية",
  justification: "المبرر",
} as const;

/**
 * الوحدات التنظيمية. الاسم العربي هو المفتاح: `unit_code` اختياري على كثير
 * من الوحدات فلا يصلح وحده معرّفًا، بينما القيد `UNIQUE(parent_id, name_ar)`
 * يجعل (الاسم + التبعية) معًا فريدين — راجع مطابقة الصف في `import-actions`.
 */
export const ORG_UNIT_IMPORT_COLUMNS = {
  // Deliberately the same labels the export writes (src/app/api/org-units/
  // export/route.ts reads them from the same message keys the screen uses),
  // so a file exported from the screen imports back with no remapping at all.
  nameAr: "الاسم (عربي)",
  parentName: "التبعية",
  kind: "الشكل التنظيمي",
  type: "نوع الإدارة",
  level: "المستوى",
  nameEn: "الاسم (إنجليزي)",
  unitCode: "الرمز",
} as const;
