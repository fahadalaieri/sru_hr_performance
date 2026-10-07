import React, { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ScatterChart, Scatter, ZAxis, ReferenceLine, PieChart, Pie, Legend,
} from "recharts";
import {
  LayoutGrid, BarChart3, Users2, Award, ShieldCheck, ChevronDown,
  AlertTriangle, CheckCircle2, Search, Bell, Menu, X, Sparkles,
  ArrowUpRight, ArrowDownRight, Filter, Star, TrendingUp,
  UploadCloud, Download, FileSpreadsheet, ChevronRight, Layers,
  BookOpen, XCircle, Trash2, Lock, UserPlus, Target, ClipboardList,
  Plus, Pencil, Users, ListChecks, GitBranch, Briefcase, Wallet, ClipboardCheck,
} from "lucide-react";

/* ============================= بيانات مرجعية من وثيقة BRD ============================= */

const BRAND = {
  cyan: "#29ABE2",
  cyanDark: "#1C87B8",
  purple: "#662D91",
  purpleDark: "#4E2170",
  gray: "#808285",
  dark: "#231F20",
  bg: "#F5F4F7",
  card: "#FFFFFF",
};

const JOB_FAMILIES = [
  { id: "leadership", name: "القياديون", examples: "عميد كلية، نائب رئيس، مدير عام، مدير إدارة", strategic: 60, bau: 10, competency: 30, count: 22 },
  { id: "faculty", name: "أعضاء هيئة التدريس", examples: "أستاذ، أستاذ مشارك، محاضر، رئيس قسم أكاديمي", strategic: 50, bau: 20, competency: 30, count: 253 },
  { id: "admin", name: "الإداريون", examples: "منسقو العمليات، السكرتارية التنفيذية، مساعدو إداريون", strategic: 35, bau: 35, competency: 30, count: 178 },
  { id: "professional", name: "المهنيون", examples: "أخصائيو القبول والتسجيل، المحاسبون، أخصائيو الموارد البشرية", strategic: 40, bau: 30, competency: 30, count: 151 },
  { id: "engineers", name: "المهندسون", examples: "مهندسو الصيانة، مهندسو تقنية المعلومات، مهندس استشاري", strategic: 25, bau: 45, competency: 30, count: 70 },
  { id: "technicians", name: "الفنيون", examples: "فنيو المختبرات الطبية، فنيو الشبكات، الدعم الفني", strategic: 25, bau: 45, competency: 30, count: 118 },
  { id: "security", name: "الخدمات المساندة والأمن", examples: "أمن، سائقون، مشرفو حركة", strategic: 10, bau: 60, competency: 30, count: 154 },
  { id: "blue", name: "عمالة الياقة الزرقاء", examples: "نظافة، زراعة، صيانة بسيطة", strategic: 0, bau: 70, competency: 30, count: 267 },
];

const RATING_BANDS = [
  { key: "excellent", label: "ممتاز", range: "90% - 100%", min: 90, max: 100, bonus: "150%", merit: "5% – 7%", action: "خطة القادة الواعدين", color: BRAND.purple, target: 15 },
  { key: "veryGood", label: "جيد جداً", range: "80% - 89%", min: 80, max: 89, bonus: "100%", merit: "3% – 4.9%", action: "تدريب تخصصي متقدم", color: BRAND.cyan, target: 30 },
  { key: "good", label: "جيد", range: "70% - 79%", min: 70, max: 79, bonus: "50%", merit: "1% – 2.9%", action: "سد فجوات الجدارات", color: "#9AA0A6", target: 35 },
  { key: "fair", label: "مرضي", range: "60% - 69%", min: 60, max: 69, bonus: "لا يستحق", merit: "0%", action: "تنبيه وإعادة توجيه", color: "#E8A33D", target: 15 },
  { key: "unsatisfactory", label: "غير مرضٍ", range: "أقل من 60%", min: 0, max: 59, bonus: "لا يستحق", merit: "0%", action: "إلحاق إجباري بـ PIP", color: "#D14848", target: 5 },
];
const bandForScore = (score) => RATING_BANDS.find((b) => score >= b.min) || RATING_BANDS[RATING_BANDS.length - 1];

// توزيع فعلي أولي (قبل التسوية) لكل كلية/إدارة — قابل للتعديل من HR
const INITIAL_ACTUAL = { excellent: 24, veryGood: 33, good: 28, fair: 11, unsatisfactory: 4 };

// وحدات الهيكل التنظيمي الفعلي للجامعة مع عدد المنسوبين الفعلي بكل جهة (ليس فقط الكليات)
const COLLEGES = [
  { name: "كلية الطب", count: 90 },
  { name: "كلية التمريض", count: 65 },
  { name: "كلية العلوم الصحية", count: 60 },
  { name: "كلية الأعمال", count: 60 },
]; // إجمالي عدد المنسوبين في العمادات الأربع = 275

const DEPARTMENTS_STAFF = [
  { name: "الإدارة التنفيذية لتطوير الأعمال", count: 15 },
  { name: "إدارة التدريب والاستشارات", count: 22 },
  { name: "إدارة الشراكات", count: 12 },
  { name: "إدارة تطوير المنتجات والخدمات", count: 14 },
  { name: "النائب المساعد لتجربة الطالب", count: 10 },
  { name: "مكتب القبول", count: 18 },
  { name: "مكتب المنح والحلول المالية", count: 9 },
  { name: "مكتب التسجيل والإرشاد الأكاديمي", count: 20 },
  { name: "إدارة الحياة الجامعية", count: 25 },
  { name: "مكتب رعاية الخريجين", count: 8 },
  { name: "النائب المساعد للتميز الأكاديمي", count: 10 },
  { name: "مركز التعليم والتعلم", count: 16 },
  { name: "مركز التقييم والقياس", count: 14 },
  { name: "إدارة التجهيزات التعليمية", count: 30 },
  { name: "مكتب الإعتماد الأكاديمي", count: 9 },
  { name: "النائب المساعد للدراسات العليا والبحث العلمي", count: 8 },
  { name: "مكتب الدراسات العليا", count: 11 },
  { name: "مكتب البحث العلمي", count: 13 },
  { name: "الإدارة التنفيذية للاتصالات وتقنية المعلومات", count: 12 },
  { name: "إدارة الأمن السيبراني", count: 20 },
  { name: "إدارة التحول الرقمي", count: 18 },
  { name: "إدارة تقنية المعلومات", count: 65 },
  { name: "مكتب إدارة البيانات", count: 15 },
  { name: "الإدارة التنفيذية للخدمات المشتركة", count: 10 },
  { name: "إدارة الشؤون المالية", count: 55 },
  { name: "إدارة رأس المال البشري", count: 48 },
  { name: "إدارة المرافق", count: 120 },
  { name: "الإدارة الهندسية", count: 40 },
  { name: "إدارة المشتريات", count: 25 },
  { name: "إدارة المستودعات", count: 22 },
  { name: "إدارة التميز المؤسسي", count: 14 },
  { name: "إدارة الاتصال المؤسسي", count: 16 },
  { name: "إدارة المسؤولية المجتمعية", count: 10 },
  { name: "إدارة المراجعة الداخلية", count: 12 },
  { name: "الإدارة القانونية", count: 9 },
];

const ORG_UNIT_STAFF = [...COLLEGES, ...DEPARTMENTS_STAFF]; // كل جهة برأس مالها البشري الخاص
const ORG_UNITS = ORG_UNIT_STAFF.map((u) => u.name);
const DEPARTMENTS = ["كل الجهات", ...ORG_UNITS];
const TOTAL_STAFF = ORG_UNIT_STAFF.reduce((a, u) => a + u.count, 0);

// السلم الوظيفي العام (مستخرج من ملف مسارات الوظائف المعتمد Career Path)
const CAREER_LEVELS = [
  { level: 14, title: "مدير عام" },
  { level: 13, title: "مدير إدارة أول" },
  { level: 12, title: "مدير إدارة" },
  { level: 11, title: "مدير" },
  { level: 10, title: "رئيس قسم / رئيس مكتب" },
  { level: 9, title: "استشاري / قائد فريق" },
  { level: 8, title: "أخصائي أول" },
  { level: 7, title: "أخصائي" },
  { level: 6, title: "أخصائي مساعد" },
  { level: 5, title: "مساعد" },
  { level: 4, title: "فني رئيسي" },
  { level: 3, title: "فني أول" },
  { level: 2, title: "فني" },
  { level: 1, title: "مشرف / عامل" },
];
const levelTitle = (lvl) => CAREER_LEVELS.find((l) => l.level === lvl)?.title || "—";
const nextLevelTitle = (lvl) => levelTitle(lvl + 1);

// مسارات وظيفية تفصيلية لأهم التخصصات (تبسيط تمثيلي لملف Career Path المعتمد — 22 مساراً كاملاً في الملف الأصلي)
const CAREER_TRACKS = [
  { id: "admin", name: "الوظائف الإدارية العامة", rungs: [
    { level: 14, title: "الرئيس التنفيذي للخدمات المشتركة" }, { level: 12, title: "مدير إدارة" },
    { level: 11, title: "مدير" }, { level: 10, title: "رئيس قسم / رئيس مكتب" }, { level: 9, title: "استشاري / قائد فريق" },
    { level: 8, title: "أخصائي أول" }, { level: 7, title: "أخصائي" }, { level: 6, title: "أخصائي مساعد" }, { level: 5, title: "مساعد إداري" },
  ]},
  { id: "it", name: "تقنية المعلومات", rungs: [
    { level: 14, title: "مدير عام الاتصالات وتقنية المعلومات" }, { level: 11, title: "مدير تقنية المعلومات / التحول الرقمي / الأمن السيبراني" },
    { level: 10, title: "رئيس قسم الشبكات / الدعم الفني" }, { level: 9, title: "استشاري تقنية معلومات" },
    { level: 8, title: "أخصائي أول تقنية معلومات" }, { level: 7, title: "أخصائي تقنية معلومات" },
    { level: 6, title: "أخصائي مساعد تقنية معلومات" }, { level: 5, title: "فني شبكات / فني دعم فني" },
  ]},
  { id: "hr", name: "رأس المال البشري", rungs: [
    { level: 11, title: "مدير إدارة رأس المال البشري" }, { level: 9, title: "استشاري تطوير مؤسسي / استقطاب مواهب" },
    { level: 8, title: "أخصائي أول موارد بشرية" }, { level: 7, title: "أخصائي موارد بشرية" }, { level: 6, title: "أخصائي مساعد موارد بشرية" },
  ]},
  { id: "finance", name: "المالية والمحاسبية", rungs: [
    { level: 14, title: "مدير عام الشؤون المالية والإدارية" }, { level: 11, title: "مدير الإدارة المالية" },
    { level: 8, title: "محاسب أول" }, { level: 7, title: "محاسب" }, { level: 6, title: "محاسب مساعد" },
  ]},
  { id: "facilities", name: "المرافق والهندسة", rungs: [
    { level: 12, title: "مدير إدارة المرافق" }, { level: 10, title: "رئيس قسم الشؤون الفنية / الأمن والسلامة" },
    { level: 9, title: "مهندس استشاري / مستشار مرافق" }, { level: 8, title: "مهندس محترف" }, { level: 7, title: "مهندس مشارك" },
    { level: 6, title: "مهندس" }, { level: 4, title: "فني رئيسي" }, { level: 3, title: "فني أول (كهرباء/سباكة/ميكانيكا)" },
    { level: 2, title: "فني (كهربائي/سباك/نجار)" }, { level: 1, title: "مشرف أمن / سائق / عامل" },
  ]},
  { id: "quality", name: "الجودة والتميز المؤسسي", rungs: [
    { level: 11, title: "مدير التميز المؤسسي" }, { level: 9, title: "استشاري جودة وتميز مؤسسي" },
    { level: 8, title: "أخصائي أول جودة" }, { level: 7, title: "أخصائي جودة" }, { level: 6, title: "أخصائي مساعد جودة" },
  ]},
];
const trackTitleAt = (trackId, lvl) => CAREER_TRACKS.find((t) => t.id === trackId)?.rungs.find((r) => r.level === lvl)?.title;
const trackNextRung = (trackId, lvl) => {
  const rungs = CAREER_TRACKS.find((t) => t.id === trackId)?.rungs || [];
  return rungs.filter((r) => r.level > lvl).sort((a, b) => a.level - b.level)[0] || null;
};

// عينة موظفين لمصفوفة 9-Box ومراجعة التسوية والترقيات
const EMPLOYEES = [
  { name: "د. سلطان العتيبي", dept: "كلية الطب", family: "القياديون", track: null, manager: null, level: 12, tenureYears: 4, vacantTarget: true, performance: 96, potential: 88, score: 96, flag: null },
  { name: "منى الحربي", dept: "إدارة الشؤون المالية", family: "المهنيون", track: "finance", manager: "أحمد الغامدي", level: 8, tenureYears: 3, vacantTarget: true, performance: 91, potential: 65, score: 91, flag: null },
  { name: "خالد الزهراني", dept: "إدارة تقنية المعلومات", family: "الفنيون", track: "it", manager: "تركي المطيري", level: 3, tenureYears: 1, vacantTarget: false, performance: 58, potential: 40, score: 58, flag: "PIP" },
  { name: "فهد القحطاني", dept: "إدارة المرافق", family: "الخدمات المساندة والأمن", track: "facilities", manager: "بندر السبيعي", level: 1, tenureYears: 6, vacantTarget: false, performance: 74, potential: 55, score: 74, flag: null },
  { name: "د. ريم الدوسري", dept: "كلية التمريض", family: "القياديون", track: null, manager: null, level: 11, tenureYears: 5, vacantTarget: true, performance: 94, potential: 92, score: 94, flag: "ترقية" },
  { name: "عبدالله الشمري", dept: "إدارة المرافق", family: "عمالة الياقة الزرقاء", track: "facilities", manager: "بندر السبيعي", level: 2, tenureYears: 2, vacantTarget: true, performance: 82, potential: 45, score: 82, flag: null },
  { name: "سارة المطيري", dept: "كلية الأعمال", family: "المهنيون", track: "admin", manager: "فيصل العنزي", level: 7, tenureYears: 1, vacantTarget: false, performance: 68, potential: 50, score: 68, flag: "مراجعة" },
  { name: "ياسر آل مبارك", dept: "إدارة تقنية المعلومات", family: "المهندسون", track: "it", manager: "تركي المطيري", level: 9, tenureYears: 4, vacantTarget: true, performance: 88, potential: 80, score: 88, flag: null },
];
const MANAGERS = [...new Set(EMPLOYEES.map((e) => e.manager).filter(Boolean))];
const promotionEligible = (e) => e.performance >= 90 && e.potential >= 80 && e.tenureYears >= 2;
const getPromotionCandidates = () => EMPLOYEES.filter(promotionEligible).sort((a, b) => b.tenureYears - a.tenureYears);

// الوظائف الشاغرة المعتمدة حالياً
const VACANCIES = [
  { id: 1, title: "مدير تقنية المعلومات", level: 11, dept: "إدارة تقنية المعلومات", track: "it" },
  { id: 2, title: "رئيس قسم الشبكات", level: 10, dept: "إدارة تقنية المعلومات", track: "it" },
  { id: 3, title: "مدير الإدارة المالية", level: 11, dept: "إدارة الشؤون المالية", track: "finance" },
  { id: 4, title: "مشرف أمن ومرافق", level: 2, dept: "إدارة المرافق", track: "facilities" },
];

// إطار جدارات الجامعة الرسمي 3×3×3 (3 مجالات × 3 أبعاد فرعية × 3 جدارات) — من مصفوفة الجدارات المعتمدة
const COMPETENCY_FRAMEWORK = [
  {
    domain: "دعم", sub: "الحوكمة", values: "تعظيم الله، الإخلاص، المسؤولية، النزاهة",
    items: [
      { name: "الامتثال والالتزام", type: "أساسية", def: "التقيد اليومي بالأنظمة والسياسات واللوائح المعتمدة وتنفيذها بدقة مع الالتزام بقيم الجامعة وأخلاقيات المهنة.", levels: ["الالتزام بالحضور والتعليمات وإتمام المهام دون تأخير", "الحفاظ على دقة الأعمال اليومية وسرية المعلومات وترتيب الأولويات", "الإشراف على التزام الفريق ووضع آليات لضمان الجودة", "ترسيخ ثقافة الانضباط المؤسسي وتمثيل الإدارة أمام الجهات الرقابية"] },
      { name: "إدارة المخاطر", type: "أساسية", def: "التعرف على مصادر المخاطر في بيئة العمل وتقييم احتمالية حدوثها والمساهمة في التصدي لها.", levels: ["التعرف على المخاطر البسيطة والإبلاغ الفوري عنها", "المشاركة في تقييم المخاطر التشغيلية ومتابعة الإجراءات الوقائية", "قيادة تحليل المخاطر المعقدة ومراجعة خطط إدارة المخاطر دورياً", "وضع سياسات واستراتيجيات شاملة لإدارة المخاطر وبناء ثقافة مؤسسية للوعي بها"] },
      { name: "الأداء المالي", type: "أساسية", def: "الاستخدام الأمثل للموارد المالية باتباع السياسات والإجراءات لتعظيم العائد من الصرف.", levels: ["الالتزام بسياسات الصرف وتجنب الهدر المالي", "مراقبة الإنفاق وتحليل البيانات المالية الدورية وتقديم التوصيات", "إدارة مخصصات مراكز التكلفة والمشاركة في إعداد الميزانية", "تطوير السياسات المالية وقيادة التخطيط المالي على مستوى الجامعة"] },
    ],
  },
  {
    domain: "دعم", sub: "الولاء", values: "الاعتزاز بالهوية، الولاء والانتماء، الاحترام، التسامح، الإحسان",
    items: [
      { name: "التواصل الفعال", type: "أساسية", def: "إيصال الأفكار والمعلومات بوضوح واحترام والاستماع الفعّال وبناء علاقات مهنية إيجابية.", levels: ["الاستماع للآخرين بوضوح والتواصل باحترام عبر القنوات الرسمية", "طرح الأسئلة للتأكد من وضوح الرسالة وبناء علاقات عمل قائمة على الثقة", "إعداد وتقديم عروض مناسبة وتكوين شبكات علاقات مهنية قوية", "تطوير استراتيجيات تواصل مؤسسية وبناء علاقات استراتيجية مع أصحاب المصلحة"] },
      { name: "روح الفريق", type: "أساسية", def: "العمل بفعالية ضمن الفرق والتعاون مع الآخرين لتحقيق الأهداف المشتركة.", levels: ["التعاون مع الزملاء واحترام الآراء المختلفة", "مساندة أعضاء الفريق وتشجيع تبادل الخبرات", "إدارة التحديات والصراعات ضمن الفريق باحترافية", "بناء فرق عمل متعددة التخصصات ورسم استراتيجيات العمل الجماعي"] },
      { name: "خدمة العميل", type: "أساسية", def: "تقديم خدمات عالية الجودة للمستفيدين والسعي لحل مشاكلهم وتحقيق رضاهم.", levels: ["الاستجابة السريعة للاستفسارات ومعاملة العميل باحترام", "متابعة تقييم رضا العملاء وحل المشكلات باحترافية", "ابتكار حلول لتطوير تجربة العميل وتحديد مؤشرات الجودة", "تطوير استراتيجيات شاملة لتحسين تجربة العميل المؤسسية"] },
    ],
  },
  {
    domain: "دعم", sub: "الإتقان", values: "الاحترافية، التعلم مدى الحياة، الرضا",
    items: [
      { name: "إدارة المهام والمشاريع", type: "أساسية", def: "تخطيط وتنظيم وتنفيذ المهام والمشاريع بفعالية وإدارة الوقت والموارد.", levels: ["تنظيم المهام اليومية وفق الأولويات وتوثيقها", "تخطيط المشروعات الصغيرة ومتابعة سير المهام الجماعية", "قيادة فرق العمل ووضع خطط عمل تفصيلية لإدارة المشاريع", "تصميم برامج متكاملة لإدارة المهام والمشاريع على مستوى الجامعة"] },
      { name: "التعامل مع التقارير والبيانات", type: "أساسية", def: "جمع وتحليل وتفسير البيانات وإعداد التقارير الدقيقة لدعم اتخاذ القرار.", levels: ["جمع البيانات الأساسية بدقة والالتزام بسرية البيانات", "تحليل البيانات وتفسير النتائج داخل التقارير", "إعداد تقارير متقدمة وقياس أثر النتائج", "قيادة تطوير سياسات جمع وتحليل البيانات وتقديم رؤى استراتيجية"] },
      { name: "التعامل مع التقنية والتحول الرقمي", type: "أساسية", def: "استخدام التقنيات الحديثة بفعالية والتكيف مع التطورات ودعم مبادرات التحول الرقمي.", levels: ["استخدام المنصات الرقمية المعتمدة في المهام اليومية", "توظيف الأنظمة الرقمية ومشاركة المعرفة التقنية مع الزملاء", "تطوير وتخصيص المنصات الرقمية وتقديم التدريب العملي", "قيادة التغيير التقني ووضع الخطط الاستراتيجية للتحول الرقمي"] },
    ],
  },
  {
    domain: "أكاديمي", sub: "البيئة الأكاديمية", values: "",
    items: [
      { name: "المساهمة في الإدارة الأكاديمية", type: "تخصصية", def: "المشاركة الفعّالة في العمليات الإدارية للمؤسسة الأكاديمية ودعم اتخاذ القرارات.", levels: ["المشاركة المنتظمة في الاجتماعات الإدارية وتنفيذ القرارات", "قيادة فرق عمل أو لجان إدارية مؤقتة والمساهمة في تطوير الإجراءات", "إدارة الموارد البشرية والمالية للقسم ووضع خطط العمل الإدارية", "تطوير السياسات والهياكل الإدارية للكلية وقيادة التخطيط الاستراتيجي"] },
      { name: "المشاركة في الاعتماد الأكاديمي والتصنيف", type: "تخصصية", def: "المساهمة في عمليات الاعتماد الأكاديمي ومبادرات التصنيف وفق معايير الجودة.", levels: ["الالتزام بمعايير الجودة وتوفير الوثائق المطلوبة للاعتماد", "المساهمة في إعداد تقارير التقييم الذاتي والمشاركة في زيارات المراجعين", "قيادة عمليات التقييم الذاتي ووضع خطط التحسين المستمر", "تطوير استراتيجيات الاعتماد وإدارة علاقات الجامعة مع هيئات الاعتماد"] },
      { name: "التوجيه والإرشاد الأكاديمي", type: "تخصصية", def: "تقديم التوجيه والإرشاد الأكاديمي للطلاب وأعضاء هيئة التدريس ودعم قراراتهم التعليمية.", levels: ["توجيه الطلاب في اختيار المقررات ومتابعة تقدمهم الأكاديمي", "تنسيق برامج الإرشاد الأكاديمي وتدريب الزملاء الجدد عليها", "وضع سياسات وبرامج الإرشاد على مستوى القسم أو الكلية", "تطوير الاستراتيجية الشاملة للإرشاد الأكاديمي في الكلية والجامعة"] },
    ],
  },
  {
    domain: "أكاديمي", sub: "التدريس", values: "",
    items: [
      { name: "تطوير المحتوى الأكاديمي", type: "تخصصية", def: "تطوير وتحديث المحتوى الأكاديمي للبرامج والمقررات وفق المعايير الأكاديمية.", levels: ["تحديث محتوى المقررات وتطوير مواد تعليمية إضافية", "المشاركة في لجان تطوير المناهج وتطوير مقررات جديدة", "قيادة مراجعة وتطوير البرامج الأكاديمية ووضع معايير الجودة", "تطوير الاستراتيجية الشاملة لتطوير المحتوى الأكاديمي في الكلية"] },
      { name: "تنويع استراتيجيات وتقنيات التعلم", type: "تخصصية", def: "تطبيق استراتيجيات وتقنيات تعليمية متنوعة تلبي احتياجات الطلاب وتوظف التكنولوجيا التعليمية.", levels: ["استخدام استراتيجيات تدريس متنوعة وتوظيف التقنيات الرقمية", "تدريب الزملاء وتطوير أدوات تعليمية تفاعلية", "وضع معايير اختيار استراتيجيات التدريس وقيادة مبادرات التطوير التعليمي", "قيادة التحول الرقمي في التعليم ووضع رؤية مستقبلية للتعلم"] },
      { name: "التقويم والقياس", type: "تخصصية", def: "تصميم وتطبيق أساليب التقويم والقياس المناسبة لتقييم تحصيل الطلاب بعدالة وشفافية.", levels: ["تصميم اختبارات متنوعة وتقديم تغذية راجعة بناءة", "تطوير أدوات قياس متقدمة وتحليل البيانات الإحصائية للنتائج", "وضع سياسات ومعايير التقويم ومراجعة فعالية أدواته", "تطوير الاستراتيجية الشاملة للتقويم والقياس في الكلية والجامعة"] },
    ],
  },
  {
    domain: "أكاديمي", sub: "البحث العلمي", values: "",
    items: [
      { name: "النشر العلمي في المجلات المحكمة والمصنفة", type: "تخصصية", def: "إنتاج ونشر بحوث علمية عالية الجودة في مجلات محكمة ومصنفة محلياً وعالمياً.", levels: ["النشر في مجلات محكمة والالتزام بالمعايير الأخلاقية للبحث", "النشر في مجلات مصنفة عالمياً وقيادة مشاريع بحثية متعددة التخصصات", "النشر في مجلات عالية التأثير وقيادة مبادرات بحثية استراتيجية", "النشر في أرقى المجلات العالمية وقيادة البرامج البحثية الاستراتيجية للجامعة"] },
      { name: "الإشراف على الرسائل العلمية", type: "تخصصية", def: "توجيه وإرشاد طلاب الدراسات العليا في إعداد رسائلهم العلمية ومتابعة تقدمهم البحثي.", levels: ["المشاركة في الإشراف المشترك وتقديم التوجيه المنهجي للطلاب", "الإشراف المستقل على رسائل الماجستير وبعض رسائل الدكتوراه", "الإشراف على رسائل الدكتوراه المتقدمة وقيادة برامج الدراسات العليا", "توجيه السياسات العامة لبرامج الدراسات العليا وبناء شبكات إشراف دولية"] },
      { name: "تمكين الجيل القادم من الباحثين", type: "تخصصية", def: "إشراك الطلاب في الأنشطة البحثية وتطوير مهاراتهم البحثية وبناء ثقافة بحثية تكاملية.", levels: ["إشراك الطلاب في مشاريع بحثية بسيطة وتقديم توجيهات أساسية", "تنظيم ورش تدريبية للطلاب وقيادة فرق بحثية مختلطة", "وضع استراتيجيات لدمج الطلاب في الأنشطة البحثية على مستوى القسم", "تطوير السياسات المؤسسية لدعم تمكين الطلاب البحثي في الجامعة"] },
    ],
  },
  {
    domain: "ابتكار", sub: "الإسهام", values: "",
    items: [
      { name: "المشاركة في المسؤولية المجتمعية والعمل التطوعي", type: "أساسية", def: "المساهمة الفعالة في خدمة المجتمع من خلال الأنشطة التطوعية والمبادرات المجتمعية.", levels: ["المشاركة في الأنشطة التطوعية التي تنظمها الجامعة", "تنظيم أنشطة تطوعية وتوظيف الخبرات المهنية في خدمة المجتمع", "قيادة فرق العمل التطوعي والتنسيق مع الجهات الخارجية", "وضع الاستراتيجية الشاملة للمسؤولية المجتمعية وبناء شراكات استراتيجية"] },
      { name: "المساهمة في تعزيز الصورة الذهنية للجامعة", type: "أساسية", def: "تمثيل الجامعة بصورة إيجابية والمساهمة في بناء سمعتها من خلال السلوك المهني المتميز.", levels: ["تمثيل الجامعة بسلوك مهني متميز في المناسبات", "المشاركة في الفعاليات العامة ونشر المحتوى الإيجابي عن الجامعة", "قيادة مبادرات تحسين الصورة الذهنية والتنسيق مع وسائل الإعلام", "وضع الاستراتيجية الشاملة لإدارة الصورة الذهنية للجامعة"] },
      { name: "المشاركة في برامج تطوير الأعمال", type: "تخصصية", def: "المشاركة في مبادرات تطوير الأعمال والعمليات وتبني الابتكار في أساليب العمل.", levels: ["المشاركة في برامج التدريب وتقديم اقتراحات لتحسين العمليات", "قيادة مبادرات تحسين صغيرة والمشاركة في فرق تطوير العمليات", "قيادة مشاريع تطوير الأعمال الكبرى ووضع خطط التحسين المستمر", "وضع الاستراتيجية الشاملة لتطوير الأعمال في الجامعة"] },
    ],
  },
  {
    domain: "ابتكار", sub: "القيادة", values: "",
    items: [
      { name: "التخطيط والتطوير", type: "تخصصية", def: "وضع الخطط والاستراتيجيات لتحقيق الأهداف وتطوير العمليات واستشراف المستقبل.", levels: ["المشاركة في وضع الخطط التشغيلية ومتابعة تنفيذ المهام", "وضع خطط تفصيلية للمشاريع واقتراح حلول مبتكرة للمشكلات", "قيادة التخطيط الاستراتيجي وتحليل البيئة الداخلية والخارجية", "وضع الرؤية والاستراتيجية العامة للجامعة وقيادة التطوير الاستراتيجي"] },
      { name: "تطوير المواهب والتحسين المستمر", type: "تخصصية", def: "تحديد وتنمية المواهب وتطبيق مبادئ التحسين المستمر لرفع مستوى الأداء والجودة.", levels: ["السعي للتطوير الذاتي المستمر وتطبيق مبادئ الجودة في العمل اليومي", "تحديد الاحتياجات التطويرية ومساعدة الزملاء في تطوير مهاراتهم", "تحديد المواهب لدى الموظفين ووضع برامج تطويرية مخصصة للفرق", "وضع الاستراتيجية الشاملة لتطوير المواهب وقيادة ثقافة التحسين المستمر"] },
      { name: "تبني التغيير", type: "تخصصية", def: "قبول التغييرات والتكيف معها بسرعة والانفتاح على الأفكار الجديدة والمساهمة في تطبيقها.", levels: ["إبداء المرونة في تقبل التغييرات والتفاعل الإيجابي مع التحديثات", "مساندة الزملاء في فهم التغييرات والمشاركة في مبادرات دعمها", "قيادة عمليات التغيير داخل الفريق ووضع خطط تواصل فعّالة", "ابتكار سياسات وبيئات عمل تشجع على التغيير والتطوير المستدام"] },
    ],
  },
  {
    domain: "ابتكار", sub: "الريادة والابتكار", values: "الإيجابية",
    items: [
      { name: "التصميم والتطوير الابتكاري", type: "تخصصية", def: "توليد الأفكار الإبداعية وتصميم وتطوير عمليات ومنتجات وخدمات جديدة.", levels: ["اقتراح أفكار جديدة والمشاركة في جلسات العصف الذهني", "تطوير حلول مبتكرة والمشاركة في فرق التصميم والتطوير", "قيادة فرق الابتكار ووضع استراتيجيات التصميم للعمليات والخدمات", "وضع الرؤية الشاملة للابتكار وقيادة التحول نحو الجامعة الذكية"] },
      { name: "التفكير الريادي واقتناص الفرص", type: "تخصصية", def: "تحديد الفرص الجديدة وتحويلها إلى مبادرات قابلة للتنفيذ بعقلية ريادية استباقية.", levels: ["إظهار الاستعداد لتجريب أساليب عمل جديدة ومناقشة الفرص", "تحديد الفرص المتاحة وتطوير أفكار ومبادرات جديدة", "قيادة مبادرات ريادية وتطوير نماذج أعمال للخدمات الجديدة", "وضع الاستراتيجية الريادية للجامعة واستثمار الفرص الكبرى"] },
      { name: "تأسيس وإدارة المشاريع والشركات الناشئة", type: "تخصصية", def: "تحويل الأفكار المبتكرة إلى مشاريع ناشئة قابلة للحياة وإدارة دورة حياتها.", levels: ["تعلم أساسيات ريادة الأعمال والمشاركة في أنشطة الحاضنات", "تطوير خطة عمل متكاملة لمشروع ناشئ والمشاركة في برامج الحاضنات", "تأسيس وإدارة مشاريع ناشئة والإشراف على برامج احتضان المشاريع", "وضع الاستراتيجية الشاملة لريادة الأعمال وتأسيس حاضنات الجامعة"] },
    ],
  },
];
const COMPETENCY_LEVEL_LABELS = ["أساسي", "ممارس", "متقدم", "محترف"];

// أعمدة نموذج استيراد الموظفين عبر Excel
const IMPORT_TEMPLATE_COLUMNS = [
  "الرقم الوظيفي", "الاسم الكامل", "البريد الإلكتروني", "الجهة / الإدارة",
  "الفئة الوظيفية", "المسمى الوظيفي", "المشرف المباشر", "تاريخ الالتحاق",
];
const IMPORT_REQUIRED_COLUMNS = ["الرقم الوظيفي", "الاسم الكامل", "الجهة / الإدارة", "الفئة الوظيفية"];

const NAV = [
  { id: "overview", label: "نظرة عامة", icon: LayoutGrid },
  { id: "curve", label: "منحنى التوزيع والتسوية", icon: BarChart3 },
  { id: "families", label: "الفئات الوظيفية والأوزان", icon: Users2 },
  { id: "evaluationSources", label: "مصادر التقييم", icon: BookOpen },
  { id: "assignment", label: "إسناد الأهداف والجدارات", icon: Target },
  { id: "evaluation", label: "تقييم الأداء", icon: ClipboardCheck },
  { id: "careerPaths", label: "المسارات الوظيفية", icon: GitBranch },
  { id: "vacancies", label: "الوظائف الشاغرة", icon: Briefcase },
  { id: "rewards", label: "الترقيات والمكافآت", icon: Award },
  { id: "permissions", label: "الصلاحيات وإدارة المستخدمين", icon: Lock },
];

/* ============================= الصلاحيات والمستخدمون (نموذج VPRA) ============================= */

// مستويات الصلاحية: عرض (View) - إعداد (Prepare) - ترشيح (Recommend) - اعتماد (Approve)
const VPRA_LEVELS = [
  { key: "none", label: "-" },
  { key: "view", label: "عرض" },
  { key: "prepare", label: "إعداد" },
  { key: "recommend", label: "ترشيح" },
  { key: "approve", label: "اعتماد" },
];

// مجالات العمليات التي تُبنى عليها مصفوفة الصلاحيات
const PROCESS_AREAS = [
  { key: "goalsLibrary", label: "مكتبة الأهداف الاستراتيجية" },
  { key: "competencyFramework", label: "إطار الجدارات" },
  { key: "defaultTemplates", label: "القوالب الافتراضية للإسناد" },
  { key: "goalAssignment", label: "إسناد الأهداف الفردية" },
  { key: "bauTasks", label: "المهام اليومية (BAU) ومؤشراتها" },
  { key: "evaluation", label: "تقييم الأداء (Rubric / 360)" },
  { key: "calibration", label: "تسوية المنحنى (Bell Curve)" },
  { key: "promotions", label: "الترقيات والمكافآت" },
  { key: "vacancies", label: "الوظائف الشاغرة" },
  { key: "careerPath", label: "المسار الوظيفي" },
  { key: "employeeData", label: "بيانات الموظفين والاستيراد" },
  { key: "userManagement", label: "إدارة المستخدمين والصلاحيات" },
];

const DEFAULT_ROLES = [
  {
    id: "employee", name: "الموظف", scope: "all",
    matrix: { goalsLibrary: "view", competencyFramework: "view", defaultTemplates: "view", goalAssignment: "view", bauTasks: "view", evaluation: "prepare", calibration: "none", promotions: "view", vacancies: "view", careerPath: "view", employeeData: "none", userManagement: "none" },
  },
  {
    id: "manager", name: "المدير / المقيّم المباشر", scope: "all",
    matrix: { goalsLibrary: "view", competencyFramework: "view", defaultTemplates: "none", goalAssignment: "prepare", bauTasks: "prepare", evaluation: "prepare", calibration: "view", promotions: "recommend", vacancies: "view", careerPath: "view", employeeData: "view", userManagement: "none" },
  },
  {
    id: "dean", name: "عميد كلية", scope: COLLEGES.map((c) => c.name),
    matrix: { goalsLibrary: "view", competencyFramework: "view", defaultTemplates: "recommend", goalAssignment: "recommend", bauTasks: "view", evaluation: "recommend", calibration: "recommend", promotions: "recommend", vacancies: "recommend", careerPath: "view", employeeData: "view", userManagement: "none" },
  },
  {
    id: "committee", name: "اللجنة الأكاديمية / الإدارية", scope: "all",
    matrix: { goalsLibrary: "view", competencyFramework: "view", defaultTemplates: "view", goalAssignment: "view", bauTasks: "view", evaluation: "recommend", calibration: "approve", promotions: "recommend", vacancies: "view", careerPath: "view", employeeData: "view", userManagement: "none" },
  },
  {
    id: "field_supervisor", name: "مشرف ميداني (تطبيق الجوال)", scope: "all",
    matrix: { goalsLibrary: "none", competencyFramework: "view", defaultTemplates: "none", goalAssignment: "view", bauTasks: "prepare", evaluation: "prepare", calibration: "none", promotions: "none", vacancies: "none", careerPath: "none", employeeData: "view", userManagement: "none" },
  },
  {
    id: "hr_admin", name: "الموارد البشرية", scope: "all",
    matrix: { goalsLibrary: "prepare", competencyFramework: "prepare", defaultTemplates: "approve", goalAssignment: "view", bauTasks: "view", evaluation: "view", calibration: "recommend", promotions: "prepare", vacancies: "approve", careerPath: "prepare", employeeData: "prepare", userManagement: "prepare" },
  },
  {
    id: "super_admin", name: "مدير النظام", scope: "all",
    matrix: Object.fromEntries(PROCESS_AREAS.map((a) => [a.key, "approve"])),
  },
];

const SEED_USERS = [
  { id: 1, title: "", firstName: "نورة", middleName: "", lastName: "القحطاني", email: "n.alqahtani@sru.edu.sa", role: "hr_admin", dept: "إدارة رأس المال البشري", family: "المهنيون", status: "نشط" },
  { id: 2, title: "د.", firstName: "سلطان", middleName: "", lastName: "العتيبي", email: "s.alotaibi@sru.edu.sa", role: "dean", dept: "كلية الطب", family: "القياديون", status: "نشط" },
  { id: 3, title: "", firstName: "خالد", middleName: "", lastName: "الزهراني", email: "k.alzahrani@sru.edu.sa", role: "field_supervisor", dept: "إدارة الأمن السيبراني", family: "الفنيون", status: "نشط" },
  { id: 4, title: "", firstName: "سارة", middleName: "", lastName: "المطيري", email: "s.almutairi@sru.edu.sa", role: "employee", dept: "كلية الأعمال", family: "المهنيون", status: "غير نشط" },
  { id: 5, title: "د.", firstName: "ريم", middleName: "", lastName: "الدوسري", email: "r.aldosari@sru.edu.sa", role: "committee", dept: "كلية التمريض", family: "القياديون", status: "نشط" },
];
const fullName = (u) => [u.title, u.firstName, u.middleName, u.lastName].filter(Boolean).join(" ");

// دليل تجريبي لمحاكاة جهة Active Directory الخاصة بالجامعة
const AD_DIRECTORY = [
  { firstName: "فيصل", middleName: "عبدالله", lastName: "العنزي", email: "f.alenezi@sru.edu.sa", dept: "كلية الأعمال" },
  { firstName: "تركي", middleName: "", lastName: "المطيري", email: "t.almutairi@sru.edu.sa", dept: "إدارة تقنية المعلومات" },
  { firstName: "بندر", middleName: "سعد", lastName: "السبيعي", email: "b.alsubaie@sru.edu.sa", dept: "إدارة المرافق" },
  { firstName: "أحمد", middleName: "", lastName: "الغامدي", email: "a.alghamdi@sru.edu.sa", dept: "إدارة الشؤون المالية" },
  { firstName: "منى", middleName: "", lastName: "الحربي", email: "m.alharbi@sru.edu.sa", dept: "إدارة الشؤون المالية" },
];

/* ============================= مكتبة الأهداف الاستراتيجية ============================= */

const STRATEGIC_GOALS = [
  {
    id: 1, name: "رفع التنافسية الأكاديمية والبحثية",
    subGoals: [
      { id: 101, name: "رفع نسبة النشر العلمي المصنف", kpi: "عدد الأبحاث المنشورة في Scopus/ISI", targetYear: "3 أبحاث خلال العام الحالي", targetPlan: "5 أبحاث سنوياً بنهاية الخطة" },
      { id: 102, name: "تحسين نتائج الاعتماد الأكاديمي للبرامج", kpi: "نسبة البرامج الحاصلة على اعتماد ساري", targetYear: "75% من البرامج", targetPlan: "90% من البرامج بنهاية الخطة" },
    ],
  },
  {
    id: 2, name: "تحسين تجربة الطالب",
    subGoals: [
      { id: 201, name: "رفع رضا الطلاب عن الخدمات التعليمية", kpi: "متوسط تقييم رضا الطلاب", targetYear: "4.0 من 5", targetPlan: "4.3 من 5 بنهاية الخطة" },
      { id: 202, name: "خفض زمن معالجة طلبات القبول والتسجيل", kpi: "متوسط أيام معالجة الطلب", targetYear: "4 أيام عمل", targetPlan: "3 أيام عمل بنهاية الخطة" },
    ],
  },
  {
    id: 3, name: "تسريع التحول الرقمي المؤسسي",
    subGoals: [
      { id: 301, name: "أتمتة الخدمات الإدارية الأساسية", kpi: "نسبة الخدمات المؤتمتة بالكامل", targetYear: "55% من الخدمات", targetPlan: "80% من الخدمات بنهاية الخطة" },
      { id: 302, name: "خفض زمن إنجاز المعاملات الإدارية", kpi: "متوسط زمن إنجاز المعاملة", targetYear: "3 أيام عمل", targetPlan: "أقل من يومي عمل بنهاية الخطة" },
    ],
  },
  {
    id: 4, name: "تعزيز السلامة والالتزام المؤسسي",
    subGoals: [
      { id: 401, name: "رفع الالتزام بمعايير السلامة في الحرم الجامعي", kpi: "نسبة الالتزام بجولات التفتيش الدورية", targetYear: "88%", targetPlan: "95% بنهاية الخطة" },
    ],
  },
  {
    id: 5, name: "تنمية مصادر الدخل الذاتي",
    subGoals: [
      { id: 501, name: "زيادة الإيرادات من البرامج التدريبية والاستشارات", kpi: "نمو الإيرادات السنوية", targetYear: "8% نمو خلال العام الحالي", targetPlan: "15% نمو سنوي بنهاية الخطة" },
      { id: 502, name: "تعزيز الشراكات الاستراتيجية مع القطاع الخاص", kpi: "عدد الشراكات الفعّالة الجديدة", targetYear: "شراكتان خلال العام الحالي", targetPlan: "5 شراكات سنوياً بنهاية الخطة" },
    ],
  },
];
const FLAT_SUBGOALS = STRATEGIC_GOALS.flatMap((g) => g.subGoals.map((sg) => ({ ...sg, goalId: g.id, goalName: g.name })));

// مكتبة الأعمال الروتينية (BAU) — تُسند منها المهام اليومية بدل الكتابة الحرة الكاملة
const ROUTINE_TASKS = [
  { id: 1, name: "الالتزام بالساعات المكتبية وسرعة رصد الدرجات", kpi: "رصد الدرجات خلال 48 ساعة من الاختبار", family: "أعضاء هيئة التدريس" },
  { id: 2, name: "المشاركة في اللجان الأكاديمية", kpi: "حضور 90% من اجتماعات اللجنة", family: "أعضاء هيئة التدريس" },
  { id: 3, name: "سرعة الاستجابة لتذاكر الدعم الفني", kpi: "إغلاق التذكرة خلال SLA المعتمد", family: "الفنيون" },
  { id: 4, name: "الصيانة الدورية للمرافق والمختبرات", kpi: "إنجاز خطة الصيانة الدورية الشهرية بالكامل", family: "المهندسون" },
  { id: 5, name: "الالتزام بنوبات الحراسة والدوريات الأمنية", kpi: "تغطية 100% من نوبات الحراسة المجدولة", family: "الخدمات المساندة والأمن" },
  { id: 6, name: "الالتزام بجدول النظافة اليومي للمباني", kpi: "نسبة إنجاز 95% من بنود جدول النظافة", family: "عمالة الياقة الزرقاء" },
  { id: 7, name: "دقة وسرعة إقفال المعاملات المالية", kpi: "إقفال المعاملة خلال يومي عمل", family: "المهنيون" },
  { id: 8, name: "متابعة طلبات المستفيدين وشكاواهم", kpi: "الرد على الطلب خلال 24 ساعة", family: "الإداريون" },
  { id: 9, name: "متابعة تنفيذ القرارات والتنسيق بين الإدارات", kpi: "إغلاق بنود المتابعة خلال أسبوع", family: "القياديون" },
];

/* ============================= إسناد الأهداف والجدارات ============================= */

const FLAT_COMPETENCIES = COMPETENCY_FRAMEWORK.flatMap((g) => g.items.map((i) => ({ name: i.name, domain: g.domain, type: i.type })));

const DEFAULT_ASSIGNMENTS = {};
const emptyAssignment = () => ({ goals: [], tasks: [], competencies: [] });

/* ============================= مكونات مساعدة ============================= */

function KpiCard({ label, value, delta, positive, icon: Icon }) {
  return (
    <div className="bg-white rounded-2xl border border-black/5 p-5 flex flex-col gap-3 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-sm text-[#808285]">{label}</span>
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "#662D9114" }}>
          <Icon size={18} color={BRAND.purple} />
        </div>
      </div>
      <div className="flex items-end justify-between">
        <span className="text-3xl font-extrabold" style={{ color: BRAND.dark }}>{value}</span>
        {delta && (
          <span className={`flex items-center gap-1 text-xs font-bold ${positive ? "text-emerald-600" : "text-red-500"}`}>
            {positive ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
            {delta}
          </span>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ eyebrow, title, children }) {
  return (
    <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 mb-5">
      <div>
        {eyebrow && <div className="text-xs font-bold tracking-wide" style={{ color: BRAND.cyan }}>{eyebrow}</div>}
        <h2 className="text-xl font-extrabold" style={{ color: BRAND.dark }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}

/* ============================= التبويب: نظرة عامة ============================= */

function OverviewTab({ dept, setDept }) {
  const donutData = RATING_BANDS.map((b) => ({ name: b.label, value: INITIAL_ACTUAL[b.key], color: b.color }));
  const famBarData = JOB_FAMILIES.map((f) => ({ name: f.name.split(" ").slice(0, 2).join(" "), عدد: f.count }));

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="لوحة الموارد البشرية" title="نظرة عامة على دورة التقييم الحالية">
        <div className="relative">
          <select
            value={dept}
            onChange={(e) => setDept(e.target.value)}
            className="appearance-none bg-white border border-black/10 rounded-xl pl-9 pr-4 py-2 text-sm font-semibold text-[#231F20] focus:outline-none focus:ring-2"
            style={{ boxShadow: "none" }}
          >
            {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
          </select>
          <ChevronDown size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#808285]" />
        </div>
      </SectionTitle>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="إجمالي المنسوبين المشمولين" value={TOTAL_STAFF.toLocaleString("en-US")} delta="+3.1%" positive icon={Users2} />
        <KpiCard label="نسبة إنجاز التقييمات" value="87%" delta="+12%" positive icon={CheckCircle2} />
        <KpiCard label="متوسط الأداء العام" value="82.4" delta="+1.6" positive icon={TrendingUp} />
        <KpiCard label="حالات بانتظار التسوية" value="46" delta="-8" positive={false} icon={AlertTriangle} />
      </div>

      <div className="grid lg:grid-cols-5 gap-5">
        <div className="lg:col-span-3 bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
          <h3 className="font-bold text-sm mb-4" style={{ color: BRAND.dark }}>عدد المنسوبين حسب الفئة الوظيفية</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={famBarData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: BRAND.gray }} interval={0} angle={-10} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 11, fill: BRAND.gray }} />
              <Tooltip contentStyle={{ fontFamily: "Cairo", borderRadius: 12, border: "1px solid #eee" }} />
              <Bar dataKey="عدد" radius={[8, 8, 0, 0]}>
                {famBarData.map((_, i) => (
                  <Cell key={i} fill={i % 2 === 0 ? BRAND.purple : BRAND.cyan} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="lg:col-span-2 bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
          <h3 className="font-bold text-sm mb-2" style={{ color: BRAND.dark }}>توزيع التقييم النهائي الحالي</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
              <Tooltip contentStyle={{ fontFamily: "Cairo", borderRadius: 12 }} formatter={(v) => `${v}%`} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center -mt-2">
            {donutData.map((d) => (
              <span key={d.name} className="flex items-center gap-1.5 text-xs text-[#808285]">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} /> {d.name}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h3 className="font-bold text-sm" style={{ color: BRAND.dark }}>توزيع المنسوبين حسب كل جهة ودرجة التقييم</h3>
          <span className="text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: "#662D9114", color: BRAND.purple }}>
            {ORG_UNIT_STAFF.length} جهة — الإجمالي {TOTAL_STAFF} منسوباً
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
          {RATING_BANDS.map((b) => (
            <span key={b.key} className="flex items-center gap-1.5 text-[11px] text-[#808285]">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: b.color }} /> {b.label}
            </span>
          ))}
        </div>
        <div className="grid sm:grid-cols-2 gap-2.5 max-h-96 overflow-y-auto pr-1">
          {[...ORG_UNIT_STAFF].sort((a, b) => b.count - a.count).map((u) => (
            <div key={u.name} className="rounded-lg border border-black/5 px-3 py-2.5" style={{ background: BRAND.bg }}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-[#231F20] truncate pl-2">{u.name}</span>
                <span className="text-xs font-extrabold shrink-0" style={{ color: BRAND.purple }}>{u.count}</span>
              </div>
              <div className="w-full h-2.5 rounded-full bg-black/5 overflow-hidden flex">
                {RATING_BANDS.map((b) => (
                  <div key={b.key} style={{ width: `${INITIAL_ACTUAL[b.key]}%`, background: b.color }} title={`${b.label}: ${INITIAL_ACTUAL[b.key]}%`} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================= التبويب: منحنى التوزيع والتسوية ============================= */

function CurveTab() {
  const [targets, setTargets] = useState(Object.fromEntries(RATING_BANDS.map((b) => [b.key, b.target])));
  const [actual] = useState(INITIAL_ACTUAL);
  const [dept, setDept] = useState("كل الجهات");
  const total = Object.values(targets).reduce((a, b) => a + Number(b || 0), 0);
  const flagged = EMPLOYEES.filter((e) => e.flag && (dept === "كل الجهات" || e.dept === dept));
  const scopeEmployees = EMPLOYEES.filter((e) => dept === "كل الجهات" || e.dept === dept);

  const chartData = RATING_BANDS.map((b) => ({
    name: b.label,
    "المستهدف (Bell Curve)": targets[b.key],
    "الفعلي قبل التسوية": actual[b.key],
    color: b.color,
  }));

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="المرحلة الثالثة من دورة التقييم" title="تسوية المنحنى الطبيعي (Calibration)">
        <div className="flex items-center gap-2">
          <div className="relative">
            <select value={dept} onChange={(e) => setDept(e.target.value)} className="appearance-none bg-white border border-black/10 rounded-xl pl-9 pr-4 py-2 text-sm font-semibold text-[#231F20] focus:outline-none">
              {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
            </select>
            <ChevronDown size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#808285]" />
          </div>
          <span className={`text-xs font-bold px-3 py-1.5 rounded-full ${total === 100 ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
            إجمالي النسب المستهدفة: {total}%
          </span>
        </div>
      </SectionTitle>
      {dept !== "كل الجهات" && (
        <p className="text-xs text-[#808285] -mt-4">
          عرض بيانات جهة: <span className="font-bold" style={{ color: BRAND.purple }}>{dept}</span> — {scopeEmployees.length} سجل ضمن هذا النموذج التجريبي (منحنى التوزيع العام يبقى مرجعياً على مستوى الجامعة).
        </p>
      )}

      <div className="grid lg:grid-cols-5 gap-5">
        <div className="lg:col-span-3 bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
          <h3 className="font-bold text-sm mb-1" style={{ color: BRAND.dark }}>مقارنة التوزيع الفعلي بالمنحنى المستهدف</h3>
          <p className="text-xs text-[#808285] mb-4">لمنع التساهل أو التحيز في التقييمات قبل اعتمادها نهائياً</p>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: BRAND.gray }} />
              <YAxis tick={{ fontSize: 11, fill: BRAND.gray }} unit="%" />
              <Tooltip contentStyle={{ fontFamily: "Cairo", borderRadius: 12, border: "1px solid #eee" }} />
              <Legend wrapperStyle={{ fontFamily: "Cairo", fontSize: 12 }} />
              <Bar dataKey="المستهدف (Bell Curve)" fill={BRAND.purple} radius={[6, 6, 0, 0]} />
              <Bar dataKey="الفعلي قبل التسوية" fill={BRAND.cyan} radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>

          <div className="mt-5 border-t border-black/5 pt-4">
            <h4 className="text-xs font-bold text-[#808285] mb-3">ضبط النسب المستهدفة يدوياً</h4>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {RATING_BANDS.map((b) => (
                <div key={b.key} className="flex flex-col gap-1">
                  <label className="text-[11px] font-bold" style={{ color: b.color }}>{b.label}</label>
                  <div className="flex items-center border border-black/10 rounded-lg overflow-hidden">
                    <input
                      type="number" min={0} max={100} value={targets[b.key]}
                      onChange={(e) => setTargets((t) => ({ ...t, [b.key]: Number(e.target.value) }))}
                      className="w-full px-2 py-1.5 text-sm text-center focus:outline-none"
                    />
                    <span className="text-xs text-[#808285] pl-2">%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
          <h3 className="font-bold text-sm mb-1" style={{ color: BRAND.dark }}>مصفوفة الأداء والإمكانات (9-Box)</h3>
          <p className="text-xs text-[#808285] mb-2">الأداء الحالي مقابل الإمكانات المستقبلية</p>
          <ResponsiveContainer width="100%" height={260}>
            <ScatterChart margin={{ top: 10, right: 15, bottom: 10, left: -15 }}>
              <CartesianGrid stroke="#eee" />
              <XAxis type="number" dataKey="performance" name="الأداء" unit="%" domain={[0, 100]} tick={{ fontSize: 10, fill: BRAND.gray }} />
              <YAxis type="number" dataKey="potential" name="الإمكانات" unit="%" domain={[0, 100]} tick={{ fontSize: 10, fill: BRAND.gray }} />
              <ZAxis range={[80, 80]} />
              <ReferenceLine x={65} stroke="#ddd" />
              <ReferenceLine y={65} stroke="#ddd" />
              <Tooltip cursor={{ strokeDasharray: "3 3" }} contentStyle={{ fontFamily: "Cairo", borderRadius: 12 }}
                formatter={(v, n) => [v, n]} labelFormatter={() => ""} />
              <Scatter data={EMPLOYEES} fill={BRAND.purple}>
                {EMPLOYEES.map((e, i) => (
                  <Cell key={i} fill={e.flag === "ترقية" ? BRAND.cyan : e.flag === "PIP" ? "#D14848" : BRAND.purple} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <h3 className="font-bold text-sm mb-4 flex items-center gap-2" style={{ color: BRAND.dark }}>
          <AlertTriangle size={16} color="#E8A33D" /> حالات بحاجة لمراجعة اللجنة قبل الاعتماد النهائي
        </h3>
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-right text-[#808285] text-xs border-b border-black/5">
                <th className="py-2 px-2 font-semibold">الاسم</th>
                <th className="py-2 px-2 font-semibold">الجهة</th>
                <th className="py-2 px-2 font-semibold">الفئة الوظيفية</th>
                <th className="py-2 px-2 font-semibold">الدرجة</th>
                <th className="py-2 px-2 font-semibold">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((e) => (
                <tr key={e.name} className="border-b border-black/5 last:border-0">
                  <td className="py-2.5 px-2 font-semibold" style={{ color: BRAND.dark }}>{e.name}</td>
                  <td className="py-2.5 px-2 text-[#808285]">{e.dept}</td>
                  <td className="py-2.5 px-2 text-[#808285]">{e.family}</td>
                  <td className="py-2.5 px-2 font-bold">{e.score}</td>
                  <td className="py-2.5 px-2">
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                      e.flag === "PIP" ? "bg-red-50 text-red-500" : e.flag === "ترقية" ? "bg-[#29ABE214] text-[#1C87B8]" : "bg-amber-50 text-amber-600"
                    }`}>
                      {e.flag === "PIP" ? "خطة تحسين أداء إجبارية" : e.flag === "ترقية" ? "مرشح للترقية" : "بانتظار المراجعة"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================= التبويب: الفئات الوظيفية والأوزان ============================= */

function guessDeptFamily(deptName) {
  if (deptName.includes("كلية")) return "أعضاء هيئة التدريس";
  if (deptName.includes("تقنية") || deptName.includes("الأمن السيبراني") || deptName.includes("التحول الرقمي") || deptName.includes("الهندسية")) return "المهندسون";
  if (deptName.includes("المرافق")) return "الخدمات المساندة والأمن";
  if (deptName.includes("المالية") || deptName.includes("رأس المال البشري") || deptName.includes("المشتريات") || deptName.includes("المستودعات")) return "المهنيون";
  return "الإداريون";
}

function FamiliesTab() {
  const [sub, setSub] = useState("family");
  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="مصفوفة الفئات الوظيفية" title="محاور التقييم بناءً على الفئة الوظيفية">
        <div className="flex gap-2">
          <button onClick={() => setSub("family")} className="text-xs font-bold px-4 py-2 rounded-xl" style={sub === "family" ? { background: BRAND.purple, color: "#fff" } : { background: "#fff", color: BRAND.gray, border: "1px solid #eee" }}>حسب الفئة الوظيفية</button>
          <button onClick={() => setSub("dept")} className="text-xs font-bold px-4 py-2 rounded-xl" style={sub === "dept" ? { background: BRAND.purple, color: "#fff" } : { background: "#fff", color: BRAND.gray, border: "1px solid #eee" }}>حسب الإدارة</button>
        </div>
      </SectionTitle>

      {sub === "family" ? (
        <div className="grid md:grid-cols-2 gap-5">
          {JOB_FAMILIES.map((f) => (
            <div key={f.id} className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
              <div className="flex items-start justify-between mb-1">
                <h3 className="font-extrabold" style={{ color: BRAND.dark }}>{f.name}</h3>
                <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: "#662D9114", color: BRAND.purple }}>
                  {f.count} منسوب
                </span>
              </div>
              <p className="text-xs text-[#808285] mb-4">{f.examples}</p>

              <div className="space-y-2.5">
                <WeightBar label="الأهداف الاستراتيجية" value={f.strategic} color={BRAND.purple} />
                <WeightBar label="العمل اليومي والمهام (BAU)" value={f.bau} color={BRAND.cyan} />
                <WeightBar label="الجدارات والسلوكيات" value={f.competency} color="#9AA0A6" />
              </div>
            </div>
          ))}

          <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm flex flex-col justify-center gap-3 md:col-span-1">
            <div className="flex items-center gap-2">
              <Sparkles size={18} color={BRAND.cyan} />
              <h3 className="font-bold text-sm" style={{ color: BRAND.dark }}>ملاحظة آلية الإسقاط</h3>
            </div>
            <p className="text-xs leading-6 text-[#808285]">
              يتم إسقاط الأهداف الاستراتيجية من رئيس الجامعة إلى القياديين، ثم إلى رؤساء الأقسام، وصولاً إلى الموظف المعني (Cascading)،
              بينما تُسند الجدارات تلقائياً بناءً على المسمى الوظيفي والفئة دون تدخل يدوي.
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
          <p className="text-xs text-[#808285] mb-4">
            الفئة الوظيفية الغالبة تلقائياً على منسوبي كل إدارة (تقريبية لأغراض العرض) — وأوزان محاورها المطبّقة فعلياً هي نفس أوزان الفئة الوظيفية.
          </p>
          <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-1">
            {ORG_UNIT_STAFF.map((u) => {
              const famName = guessDeptFamily(u.name);
              const fam = JOB_FAMILIES.find((f) => f.name === famName);
              return (
                <div key={u.name} className="rounded-xl border border-black/5 px-4 py-3" style={{ background: BRAND.bg }}>
                  <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                    <span className="text-xs font-bold" style={{ color: BRAND.dark }}>{u.name}</span>
                    <span className="text-[11px] font-bold px-2.5 py-1 rounded-full" style={{ background: "#662D9114", color: BRAND.purple }}>{famName} — {u.count} منسوب</span>
                  </div>
                  <div className="space-y-2">
                    <WeightBar label="الأهداف الاستراتيجية" value={fam.strategic} color={BRAND.purple} />
                    <WeightBar label="العمل اليومي والمهام (BAU)" value={fam.bau} color={BRAND.cyan} />
                    <WeightBar label="الجدارات والسلوكيات" value={fam.competency} color="#9AA0A6" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function WeightBar({ label, value, color }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-[#231F20] font-semibold">{label}</span>
        <span className="font-bold" style={{ color }}>{value}%</span>
      </div>
      <div className="w-full h-2 rounded-full bg-black/5 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
    </div>
  );
}

/* ============================= التبويب: الترقيات والمكافآت ============================= */

function ExportButton({ rows, columns, filename, deptField }) {
  const [open, setOpen] = useState(false);
  const depts = deptField ? [...new Set(rows.map((r) => r[deptField]).filter(Boolean))] : [];
  const [selectedDept, setSelectedDept] = useState(depts[0] || "");

  const doExport = (list, suffix) => {
    const header = columns.map((c) => c.label);
    const data = list.map((r) => columns.map((c) => r[c.key] ?? ""));
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws["!cols"] = columns.map(() => ({ wch: 24 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "بيانات");
    XLSX.writeFile(wb, `${filename}${suffix ? "_" + suffix : ""}.xlsx`);
    setOpen(false);
  };

  return (
    <div className="relative inline-block">
      <button onClick={() => setOpen((s) => !s)} className="flex items-center gap-1.5 text-xs font-bold rounded-xl px-3.5 py-2 border border-black/10" style={{ color: BRAND.dark }}>
        <Download size={14} /> تصدير إلى Excel
      </button>
      {open && (
        <div className="absolute left-0 mt-2 z-20 bg-white rounded-xl border border-black/10 shadow-lg p-3 w-64 space-y-2.5">
          <button onClick={() => doExport(rows, "كامل")} className="w-full text-xs font-bold text-white rounded-lg py-2" style={{ background: BRAND.purple }}>
            تصدير الكل ({rows.length})
          </button>
          {deptField && depts.length > 0 && (
            <div className="pt-2 border-t border-black/5 space-y-2">
              <select value={selectedDept} onChange={(e) => setSelectedDept(e.target.value)} className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-xs">
                {depts.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <button onClick={() => doExport(rows.filter((r) => r[deptField] === selectedDept), selectedDept)} className="w-full text-xs font-bold rounded-lg py-2 border border-black/10" style={{ color: BRAND.dark }}>
                تصدير حسب هذه الإدارة
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function compositeScore(e, criteria) {
  return criteria.reduce((sum, c) => {
    let val = 70;
    if (c.name.includes("أداء")) val = e.performance;
    else if (c.name.includes("إمكان")) val = e.potential;
    else if (c.name.includes("أقدمية")) val = Math.min(100, e.tenureYears * 20);
    return sum + (c.weight / 100) * val;
  }, 0);
}

function EnginePanel({ criteria, setCriteria, conditions, setConditions }) {
  const [critForm, setCritForm] = useState({ name: "", weight: 10 });
  const [condForm, setCondForm] = useState("");
  const criteriaSum = criteria.reduce((a, c) => a + Number(c.weight), 0);

  const addCriterion = () => {
    if (!critForm.name.trim()) return;
    setCriteria((c) => [...c, { id: Date.now(), name: critForm.name, weight: Number(critForm.weight) }]);
    setCritForm({ name: "", weight: 10 });
  };
  const removeCriterion = (id) => setCriteria((c) => c.filter((x) => x.id !== id));
  const updateCriterionWeight = (id, w) => setCriteria((c) => c.map((x) => x.id === id ? { ...x, weight: Math.max(0, Math.min(100, Number(w) || 0)) } : x));

  const addCondition = () => {
    if (!condForm.trim()) return;
    setConditions((c) => [...c, { id: Date.now(), name: condForm }]);
    setCondForm("");
  };
  const removeCondition = (id) => setConditions((c) => c.filter((x) => x.id !== id));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-[#808285] flex-1">قواعد ربط شريحة التقييم النهائي بالمكافأة والزيادة السنوية والإجراء التطويري المناسب.</p>
        <ExportButton
          filename="محرك_الترقيات_والمكافآت"
          rows={RATING_BANDS.map((b) => ({ label: b.label, range: b.range, bonus: b.bonus, merit: b.merit, action: b.action }))}
          columns={[
            { key: "label", label: "التقييم النهائي" }, { key: "range", label: "النطاق المئوي" },
            { key: "bonus", label: "نسبة المكافأة" }, { key: "merit", label: "الزيادة السنوية" }, { key: "action", label: "الإجراء التطويري" },
          ]}
        />
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm overflow-x-auto">
        <h3 className="font-bold text-sm mb-4" style={{ color: BRAND.dark }}>محرك المكافآت المرتبط بشريحة التقييم</h3>
        <table className="w-full text-sm min-w-[680px]">
          <thead>
            <tr className="text-right text-[#808285] text-xs border-b border-black/5">
              <th className="py-2 px-2 font-semibold">التقييم النهائي</th>
              <th className="py-2 px-2 font-semibold">النطاق المئوي</th>
              <th className="py-2 px-2 font-semibold">نسبة المكافأة</th>
              <th className="py-2 px-2 font-semibold">الزيادة السنوية (Merit)</th>
              <th className="py-2 px-2 font-semibold">الإجراء التطويري</th>
            </tr>
          </thead>
          <tbody>
            {RATING_BANDS.map((b) => (
              <tr key={b.key} className="border-b border-black/5 last:border-0">
                <td className="py-3 px-2">
                  <span className="flex items-center gap-2 font-bold" style={{ color: b.color }}>
                    <span className="w-2 h-2 rounded-full" style={{ background: b.color }} /> {b.label}
                  </span>
                </td>
                <td className="py-3 px-2 text-[#231F20]">{b.range}</td>
                <td className="py-3 px-2 font-bold" style={{ color: BRAND.dark }}>{b.bonus}</td>
                <td className="py-3 px-2 text-[#231F20]">{b.merit}</td>
                <td className="py-3 px-2 text-[#808285]">{b.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <h3 className="font-bold text-sm mb-1 flex items-center gap-2" style={{ color: BRAND.dark }}>
          <ListChecks size={16} color={BRAND.purple} /> معايير الترقية (تُحتسب كدرجة — يجب أن يساوي مجموعها 100%)
        </h3>
        <p className="text-[11px] text-[#808285] mb-4">تعديل هذا القسم يتطلب صلاحية "إعداد" أو "اعتماد" على مجال الترقيات والمكافآت.</p>
        <div className="space-y-2 mb-3">
          {criteria.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-black/5 px-3.5 py-2.5">
              <span className="flex-1 text-xs font-semibold" style={{ color: BRAND.dark }}>{c.name}</span>
              <input type="number" min={0} max={100} value={c.weight} onChange={(e) => updateCriterionWeight(c.id, e.target.value)} className="w-16 text-center text-xs border border-black/10 rounded-md py-1" />
              <span className="text-[11px] text-[#808285]">%</span>
              <button onClick={() => removeCriterion(c.id)}><Trash2 size={13} color={BRAND.gray} /></button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mb-2">
          <input placeholder="اسم معيار جديد" value={critForm.name} onChange={(e) => setCritForm({ ...critForm, name: e.target.value })}
            className="flex-1 text-xs rounded-lg border border-black/10 px-3 py-2 focus:outline-none" />
          <input type="number" min={0} max={100} value={critForm.weight} onChange={(e) => setCritForm({ ...critForm, weight: e.target.value })} className="w-16 text-center text-xs border border-black/10 rounded-lg" />
          <button onClick={addCriterion} className="shrink-0 flex items-center gap-1 text-xs font-bold text-white rounded-lg px-3" style={{ background: BRAND.purple }}><Plus size={13} /></button>
        </div>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${criteriaSum === 100 ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
          إجمالي أوزان المعايير: {criteriaSum}%
        </span>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <h3 className="font-bold text-sm mb-1 flex items-center gap-2" style={{ color: BRAND.dark }}>
          <ShieldCheck size={16} color={BRAND.cyanDark} /> شروط الترقية (يجب توفرها جميعاً — لا تُحتسب كدرجة)
        </h3>
        <p className="text-[11px] text-[#808285] mb-4">الشرط بوابة (نعم/لا): عدم توفره يمنع الترقية بصرف النظر عن درجة المعايير أعلاه.</p>
        <div className="space-y-2 mb-3">
          {conditions.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-black/5 px-3.5 py-2.5">
              <ShieldCheck size={13} color={BRAND.cyanDark} className="shrink-0" />
              <span className="flex-1 text-xs font-semibold" style={{ color: BRAND.dark }}>{c.name}</span>
              <button onClick={() => removeCondition(c.id)}><Trash2 size={13} color={BRAND.gray} /></button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input placeholder="شرط جديد يجب توفره" value={condForm} onChange={(e) => setCondForm(e.target.value)}
            className="flex-1 text-xs rounded-lg border border-black/10 px-3 py-2 focus:outline-none" />
          <button onClick={addCondition} className="shrink-0 flex items-center gap-1 text-xs font-bold text-white rounded-lg px-3" style={{ background: BRAND.cyanDark }}><Plus size={13} /></button>
        </div>
      </div>
    </div>
  );
}

function PromotionsPanel({ criteria, conditions }) {
  const candidates = getPromotionCandidates().map((e) => ({ ...e, composite: compositeScore(e, criteria) })).sort((a, b) => b.composite - a.composite);
  const nearlyEligible = EMPLOYEES.filter((e) => e.performance >= 90 && e.potential >= 80 && e.tenureYears < 2);

  const exportRows = candidates.map((e) => ({
    name: e.name, dept: e.dept, current: levelTitle(e.level), next: nextLevelTitle(e.level),
    composite: e.composite.toFixed(1), tenure: `${e.tenureYears} سنوات`, vacant: e.vacantTarget ? "شاغرة" : "غير شاغرة",
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-bold text-sm flex items-center gap-2 flex-1" style={{ color: BRAND.dark }}>
          <ListChecks size={16} color={BRAND.purple} /> شروط ومعايير الترقية المعتمدة
        </h3>
        <ExportButton
          filename="مرشحو_الترقية" deptField="dept" rows={exportRows}
          columns={[
            { key: "name", label: "الاسم" }, { key: "dept", label: "الجهة" }, { key: "current", label: "المسمى الحالي" },
            { key: "next", label: "المسار المقترح" }, { key: "composite", label: "الدرجة المركبة" }, { key: "tenure", label: "مدة الخدمة" }, { key: "vacant", label: "حالة الشاغر" },
          ]}
        />
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <h4 className="text-xs font-extrabold mb-2" style={{ color: BRAND.cyanDark }}>الشروط الواجب توفرها (بوابة نعم/لا)</h4>
        <div className="flex flex-wrap gap-2 mb-4">
          {conditions.map((c) => (
            <span key={c.id} className="text-[11px] font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ background: "#29ABE214", color: BRAND.cyanDark }}>
              <ShieldCheck size={12} /> {c.name}
            </span>
          ))}
        </div>
        <h4 className="text-xs font-extrabold mb-2" style={{ color: BRAND.purple }}>معايير التقييم (تُحدد الأفضلية بين المستوفين للشروط)</h4>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {criteria.map((c) => (
            <div key={c.id} className="rounded-xl border border-black/5 p-3.5" style={{ background: BRAND.bg }}>
              <div className="text-xs font-extrabold mb-1" style={{ color: BRAND.purple }}>{c.name}</div>
              <p className="text-[11px] leading-5 text-[#231F20]">وزن {c.weight}% من الدرجة المركبة</p>
            </div>
          ))}
        </div>
        <p className="text-[10.5px] text-[#808285] mt-3">لتعديل النسب أو إضافة معايير وشروط أخرى، انتقل إلى تبويب "محرك الترقيات والمكافآت".</p>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm overflow-x-auto">
        <h3 className="font-bold text-sm mb-1 flex items-center gap-2" style={{ color: BRAND.dark }}>
          <Star size={16} color={BRAND.cyan} /> مرشحو الترقية المستوفون للشروط — مرتبون حسب الدرجة المركبة
        </h3>
        <p className="text-xs text-[#808285] mb-4">وفق 9-Box (أداء ≥90%، إمكانات ≥80%) + أقدمية سنتين فأكثر، ثم ترتيب حسب المعايير الموزونة أعلاه</p>
        <table className="w-full text-xs min-w-[820px]">
          <thead>
            <tr className="text-right text-[#808285] border-b border-black/5">
              <th className="py-2 px-2 font-semibold">الاسم</th>
              <th className="py-2 px-2 font-semibold">الجهة</th>
              <th className="py-2 px-2 font-semibold">المسمى الحالي</th>
              <th className="py-2 px-2 font-semibold">المسار المقترح</th>
              <th className="py-2 px-2 font-semibold">الدرجة المركبة</th>
              <th className="py-2 px-2 font-semibold">مدة الخدمة</th>
              <th className="py-2 px-2 font-semibold">حالة الشاغر</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((e, i) => (
              <tr key={e.name} className="border-b border-black/5 last:border-0">
                <td className="py-2.5 px-2 font-semibold flex items-center gap-1.5" style={{ color: BRAND.dark }}>
                  {i === 0 && <Star size={12} color={BRAND.purple} />} {e.name}
                </td>
                <td className="py-2.5 px-2 text-[#808285]">{e.dept}</td>
                <td className="py-2.5 px-2 text-[#808285]">{levelTitle(e.level)}</td>
                <td className="py-2.5 px-2 font-bold" style={{ color: BRAND.purple }}>{nextLevelTitle(e.level)}</td>
                <td className="py-2.5 px-2 font-bold" style={{ color: BRAND.dark }}>{e.composite.toFixed(1)}</td>
                <td className="py-2.5 px-2">{e.tenureYears} سنوات</td>
                <td className="py-2.5 px-2">
                  <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${e.vacantTarget ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
                    {e.vacantTarget ? "شاغرة" : "غير شاغرة"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {nearlyEligible.length > 0 && (
          <p className="text-[11px] text-[#808285] mt-3">
            {nearlyEligible.map((e) => e.name).join("، ")} — مستوفون لشرط الأداء لكن لم يكملوا الحد الأدنى لمدة الخدمة (سنتان) بعد.
          </p>
        )}
      </div>
    </div>
  );
}

/* ============================= التبويب: إطار الجدارات ============================= */

function CompetencyFrameworkTab({ framework, setFramework }) {
  const [openKey, setOpenKey] = useState(null);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [groupForm, setGroupForm] = useState({ domain: "دعم", sub: "", values: "" });
  const [compForms, setCompForms] = useState({});
  const fileRef = useRef(null);
  const domainColor = { "دعم": BRAND.purple, "أكاديمي": BRAND.cyan, "ابتكار": "#9AA0A6" };
  const domains = [...new Set(["دعم", "أكاديمي", "ابتكار", ...framework.map((g) => g.domain)])];

  const addGroup = () => {
    if (!groupForm.sub.trim()) return;
    setFramework((fw) => [...fw, { ...groupForm, items: [] }]);
    setGroupForm({ domain: "دعم", sub: "", values: "" });
    setShowAddGroup(false);
  };
  const removeGroup = (gi) => setFramework((fw) => fw.filter((_, i) => i !== gi));

  const getCompForm = (gi) => compForms[gi] || { name: "", type: "أساسية", def: "", levels: ["", "", "", ""] };
  const setCompForm = (gi, patch) => setCompForms((f) => ({ ...f, [gi]: { ...getCompForm(gi), ...patch } }));
  const setCompLevel = (gi, li, val) => {
    const cur = getCompForm(gi);
    const levels = [...cur.levels]; levels[li] = val;
    setCompForm(gi, { levels });
  };
  const addCompetency = (gi) => {
    const f = getCompForm(gi);
    if (!f.name.trim()) return;
    setFramework((fw) => fw.map((g, i) => i === gi ? { ...g, items: [...g.items, { ...f }] } : g));
    setCompForms((cf) => ({ ...cf, [gi]: { name: "", type: "أساسية", def: "", levels: ["", "", "", ""] } }));
  };
  const removeCompetency = (gi, ci) => setFramework((fw) => fw.map((g, i) => i === gi ? { ...g, items: g.items.filter((_, x) => x !== ci) } : g));

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        setFramework((prev) => {
          const next = prev.map((g) => ({ ...g, items: [...g.items] }));
          rows.forEach((r) => {
            const domain = String(r["النوع"] || "").trim();
            const sub = String(r["المجال"] || "").trim();
            const name = String(r["اسم الجدارة"] || "").trim();
            if (!domain || !sub || !name) return;
            let g = next.find((x) => x.domain === domain && x.sub === sub);
            if (!g) { g = { domain, sub, values: "", items: [] }; next.push(g); }
            g.items.push({
              name,
              type: String(r["نوع الجدارة"] || "أساسية"),
              def: String(r["التعريف"] || ""),
              levels: [
                String(r["المستوى الأساسي"] || ""),
                String(r["المستوى الممارس"] || ""),
                String(r["المستوى المتقدم"] || ""),
                String(r["المستوى المحترف"] || ""),
              ],
            });
          });
          return next;
        });
      } catch (err) { /* ignore malformed file */ }
    };
    reader.readAsBinaryString(file);
    e.target.value = "";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-[#808285] flex-1">
          الماستر (من يملك صلاحية "إعداد" على إطار الجدارات) يضيف النوع، ثم المجال ضمنه، ثم الجدارات مع تعريف كل منها ومستوياتها الأربعة.
        </p>
        <div className="flex gap-2">
          <button onClick={() => setShowAddGroup((s) => !s)} className="flex items-center gap-1.5 text-xs font-bold text-white rounded-lg px-3.5 py-2" style={{ background: BRAND.purple }}>
            <Plus size={13} /> إضافة نوع / مجال
          </button>
          <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 text-xs font-bold rounded-lg px-3.5 py-2 border border-black/10" style={{ color: BRAND.dark }}>
            <UploadCloud size={13} /> استيراد من Excel
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleImport} className="hidden" />
        </div>
      </div>
      <p className="text-[10.5px] text-[#808285] -mt-4">
        أعمدة ملف الاستيراد المتوقعة: النوع، المجال، اسم الجدارة، نوع الجدارة، التعريف، المستوى الأساسي، المستوى الممارس، المستوى المتقدم، المستوى المحترف.
      </p>

      {showAddGroup && (
        <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          <select value={groupForm.domain} onChange={(e) => setGroupForm({ ...groupForm, domain: e.target.value })} className="rounded-lg border border-black/10 px-3 py-2 text-xs">
            {domains.map((d) => <option key={d}>{d}</option>)}
          </select>
          <input placeholder="اسم المجال (مثال: الحوكمة)" value={groupForm.sub} onChange={(e) => setGroupForm({ ...groupForm, sub: e.target.value })}
            className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
          <input placeholder="القيم المرتبطة (اختياري)" value={groupForm.values} onChange={(e) => setGroupForm({ ...groupForm, values: e.target.value })}
            className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
          <button onClick={addGroup} className="rounded-lg text-xs font-bold text-white py-2" style={{ background: BRAND.cyanDark }}>حفظ المجال</button>
        </div>
      )}

      <div className="space-y-4">
        {framework.map((group, gi) => (
          <div key={gi} className="bg-white rounded-2xl border border-black/5 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 flex items-center justify-between border-b border-black/5" style={{ background: `${domainColor[group.domain] || BRAND.gray}0D` }}>
              <div className="flex items-center gap-2.5">
                <span className="text-[11px] font-extrabold px-2.5 py-1 rounded-full text-white" style={{ background: domainColor[group.domain] || BRAND.gray }}>
                  {group.domain}
                </span>
                <span className="font-bold text-sm" style={{ color: BRAND.dark }}>{group.sub}</span>
                {group.values && <span className="text-xs text-[#808285]">— {group.values}</span>}
              </div>
              <Trash2 size={14} color={BRAND.gray} onClick={() => removeGroup(gi)} className="cursor-pointer" />
            </div>
            <div className="divide-y divide-black/5">
              {group.items.map((c, ci) => {
                const key = `${gi}-${ci}`;
                const open = openKey === key;
                return (
                  <div key={key}>
                    <button
                      onClick={() => setOpenKey(open ? null : key)}
                      className="w-full flex items-center justify-between px-5 py-3 text-right hover:bg-black/[0.02] transition-colors"
                    >
                      <span className="flex items-center gap-2.5">
                        <ChevronRight size={15} className={`transition-transform ${open ? "rotate-90" : ""}`} color={BRAND.gray} />
                        <span className="font-semibold text-sm" style={{ color: BRAND.dark }}>{c.name}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${c.type === "أساسية" ? "bg-[#662D9114] text-[#662D91]" : "bg-[#29ABE214] text-[#1C87B8]"}`}>
                          {c.type}
                        </span>
                        <Trash2 size={13} color={BRAND.gray} onClick={(e) => { e.stopPropagation(); removeCompetency(gi, ci); }} />
                      </span>
                    </button>
                    {open && (
                      <div className="px-5 pb-5 pt-1">
                        <p className="text-xs leading-6 text-[#808285] mb-4">{c.def}</p>
                        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                          {c.levels.map((lvl, li) => (
                            <div key={li} className="rounded-xl border border-black/5 p-3" style={{ background: BRAND.bg }}>
                              <div className="text-[11px] font-extrabold mb-1.5" style={{ color: domainColor[group.domain] || BRAND.purple }}>
                                {COMPETENCY_LEVEL_LABELS[li]}
                              </div>
                              <p className="text-[11px] leading-5 text-[#231F20]">{lvl}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="p-4 border-t border-black/5 space-y-2" style={{ background: BRAND.bg }}>
              <div className="grid sm:grid-cols-2 gap-2">
                <input placeholder="اسم الجدارة" value={getCompForm(gi).name} onChange={(e) => setCompForm(gi, { name: e.target.value })}
                  className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
                <select value={getCompForm(gi).type} onChange={(e) => setCompForm(gi, { type: e.target.value })} className="rounded-lg border border-black/10 px-3 py-2 text-xs">
                  <option>أساسية</option><option>تخصصية</option>
                </select>
              </div>
              <input placeholder="تعريف الجدارة" value={getCompForm(gi).def} onChange={(e) => setCompForm(gi, { def: e.target.value })}
                className="w-full rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                {COMPETENCY_LEVEL_LABELS.map((l, li) => (
                  <input key={li} placeholder={`وصف مستوى ${l}`} value={getCompForm(gi).levels[li]} onChange={(e) => setCompLevel(gi, li, e.target.value)}
                    className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
                ))}
              </div>
              <button onClick={() => addCompetency(gi)} className="flex items-center gap-1.5 text-xs font-bold text-white rounded-lg px-4 py-2" style={{ background: BRAND.purple }}>
                <Plus size={13} /> إضافة جدارة لهذا المجال
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================= التبويب: استيراد الموظفين ============================= */

function ImportEmployeesTab() {
  const fileRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const downloadTemplate = () => {
    const wsData = [
      IMPORT_TEMPLATE_COLUMNS,
      ["10245", "سلطان بن عبدالله العتيبي", "s.alotaibi@sru.edu.sa", "إدارة تقنية المعلومات", "الفنيون", "فني أول", "خالد الزهراني", "2022-09-01"],
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = IMPORT_TEMPLATE_COLUMNS.map(() => ({ wch: 24 }));
    XLSX.utils.book_append_sheet(wb, ws, "قالب الموظفين");

    const unitsWs = XLSX.utils.aoa_to_sheet([["الجهات / الإدارات المعتمدة"], ...ORG_UNITS.map((u) => [u])]);
    unitsWs["!cols"] = [{ wch: 34 }];
    XLSX.utils.book_append_sheet(wb, unitsWs, "الإدارات المعتمدة");

    const famWs = XLSX.utils.aoa_to_sheet([["الفئات الوظيفية المعتمدة"], ...JOB_FAMILIES.map((f) => [f.name])]);
    famWs["!cols"] = [{ wch: 30 }];
    XLSX.utils.book_append_sheet(wb, famWs, "الفئات الوظيفية");

    const titlesWs = XLSX.utils.aoa_to_sheet([["المسمى الوظيفي", "المستوى"], ...CAREER_LEVELS.map((l) => [l.title, l.level])]);
    titlesWs["!cols"] = [{ wch: 28 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, titlesWs, "المسميات الوظيفية");

    XLSX.writeFile(wb, "نموذج_استيراد_الموظفين_SRU.xlsx");
  };

  const parseFile = (file) => {
    setFileName(file.name);
    setConfirmed(false);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
        setRows(json);
      } catch (err) {
        setRows([]);
        setFileName("");
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) parseFile(file);
  };

  const isRowValid = (r) => IMPORT_REQUIRED_COLUMNS.every((col) => String(r[col] ?? "").trim() !== "");
  const validCount = rows.filter(isRowValid).length;
  const invalidCount = rows.length - validCount;

  const clearAll = () => {
    setRows([]);
    setFileName("");
    setConfirmed(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="تمكين تقني للفئات ذات الأجهزة المحدودة" title="استيراد بيانات الموظفين عبر Excel" />

      <div className="grid lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "#662D9114" }}>
              <FileSpreadsheet size={18} color={BRAND.purple} />
            </div>
            <div>
              <h3 className="font-bold text-sm" style={{ color: BRAND.dark }}>الخطوة 1 — تنزيل النموذج</h3>
              <p className="text-xs text-[#808285] mt-1 leading-5">
                نموذج Excel معتمد يتضمن أعمدة البيانات المطلوبة، بالإضافة إلى ثلاث أوراق مرجعية: الإدارات المعتمدة،
                الفئات الوظيفية، والمسميات الوظيفية — لضبط عملية الإدخال (اختيار من القوائم داخل Excel نفسه بعد التنزيل).
              </p>
            </div>
          </div>
          <button
            onClick={downloadTemplate}
            className="w-full flex items-center justify-center gap-2 text-sm font-bold text-white rounded-xl py-2.5 transition-transform hover:-translate-y-0.5"
            style={{ background: `linear-gradient(135deg, ${BRAND.cyan}, ${BRAND.purple})` }}
          >
            <Download size={16} /> تنزيل نموذج Excel
          </button>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {IMPORT_TEMPLATE_COLUMNS.map((c) => (
              <span key={c} className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-black/[0.04] text-[#231F20]">{c}</span>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "#29ABE214" }}>
              <UploadCloud size={18} color={BRAND.cyanDark} />
            </div>
            <div>
              <h3 className="font-bold text-sm" style={{ color: BRAND.dark }}>الخطوة 2 — رفع الملف المعبأ</h3>
              <p className="text-xs text-[#808285] mt-1 leading-5">اسحب الملف هنا أو اختره من جهازك لمراجعة البيانات قبل الاعتماد.</p>
            </div>
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className="flex-1 min-h-[110px] rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors"
            style={{ borderColor: dragOver ? BRAND.cyan : "#e5e5e5", background: dragOver ? "#29ABE20A" : "transparent" }}
          >
            <UploadCloud size={22} color={BRAND.gray} />
            <span className="text-xs font-semibold text-[#808285]">{fileName || "اسحب ملف Excel (.xlsx) هنا أو انقر للاختيار"}</span>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFileChange} className="hidden" />
          </div>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="font-bold text-sm flex items-center gap-2" style={{ color: BRAND.dark }}>
              معاينة البيانات المستوردة — {fileName}
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-600 flex items-center gap-1">
                <CheckCircle2 size={13} /> {validCount} صف صالح
              </span>
              {invalidCount > 0 && (
                <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-red-50 text-red-500 flex items-center gap-1">
                  <XCircle size={13} /> {invalidCount} بحاجة لمراجعة
                </span>
              )}
              <button onClick={clearAll} className="text-xs font-bold px-3 py-1.5 rounded-full bg-black/[0.04] text-[#808285] flex items-center gap-1">
                <Trash2 size={13} /> مسح
              </button>
            </div>
          </div>

          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-xs min-w-[820px]">
              <thead>
                <tr className="text-right text-[#808285] border-b border-black/5">
                  {IMPORT_TEMPLATE_COLUMNS.map((c) => <th key={c} className="py-2 px-2 font-semibold whitespace-nowrap">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 25).map((r, i) => (
                  <tr key={i} className={`border-b border-black/5 last:border-0 ${!isRowValid(r) ? "bg-red-50/50" : ""}`}>
                    {IMPORT_TEMPLATE_COLUMNS.map((c) => (
                      <td key={c} className="py-2 px-2 whitespace-nowrap" style={{ color: BRAND.dark }}>{String(r[c] ?? "") || "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 25 && <p className="text-[11px] text-[#808285] mt-2">وعرض 25 من أصل {rows.length} صف مستورد.</p>}

          <div className="flex items-center justify-between mt-5 pt-4 border-t border-black/5">
            <p className="text-xs text-[#808285]">
              هذه معاينة أولية داخل النموذج التجريبي فقط — عند الربط بقاعدة البيانات الفعلية سيتم التحقق الآلي والدمج مع سجلات الموارد البشرية.
            </p>
            <button
              disabled={validCount === 0}
              onClick={() => setConfirmed(true)}
              className="shrink-0 text-sm font-bold text-white rounded-xl px-5 py-2.5 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: BRAND.purple }}
            >
              اعتماد الاستيراد ({validCount})
            </button>
          </div>
          {confirmed && (
            <div className="mt-3 flex items-center gap-2 text-sm font-semibold text-emerald-600">
              <CheckCircle2 size={16} /> تم اعتماد {validCount} سجل موظف بنجاح.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================= التبويب: الصلاحيات وإدارة المستخدمين ============================= */

function PermissionsTab() {
  const [roles, setRoles] = useState(DEFAULT_ROLES);
  const [selectedRoleId, setSelectedRoleId] = useState(DEFAULT_ROLES[0].id);
  const [users, setUsers] = useState(SEED_USERS);
  const [showAdd, setShowAdd] = useState(false);
  const [showAddRole, setShowAddRole] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [adSync, setAdSync] = useState(false);
  const [form, setForm] = useState({ firstName: "", middleName: "", lastName: "", email: "", role: "employee", dept: ORG_UNITS[0], family: JOB_FAMILIES[0].name });
  const [roleForm, setRoleForm] = useState({ name: "", scopeAll: true, scopeUnits: [] });
  const [showAdSearch, setShowAdSearch] = useState(false);
  const [adQuery, setAdQuery] = useState("");
  const selectedRole = roles.find((r) => r.id === selectedRoleId);

  const setCell = (roleId, areaKey, level) => {
    setRoles((rs) => rs.map((r) => r.id === roleId ? { ...r, matrix: { ...r.matrix, [areaKey]: level } } : r));
  };

  const toggleScopeUnit = (unit) => {
    setRoleForm((f) => ({ ...f, scopeUnits: f.scopeUnits.includes(unit) ? f.scopeUnits.filter((u) => u !== unit) : [...f.scopeUnits, unit] }));
  };

  const addRole = () => {
    if (!roleForm.name.trim()) return;
    const id = "role_" + Date.now();
    setRoles((rs) => [...rs, {
      id, name: roleForm.name,
      scope: roleForm.scopeAll ? "all" : roleForm.scopeUnits,
      matrix: Object.fromEntries(PROCESS_AREAS.map((a) => [a.key, "none"])),
    }]);
    setSelectedRoleId(id);
    setRoleForm({ name: "", scopeAll: true, scopeUnits: [] });
    setShowAddRole(false);
  };

  const [editingId, setEditingId] = useState(null);

  const addUser = () => {
    if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim()) return;
    if (editingId) {
      setUsers((u) => u.map((x) => x.id === editingId ? { ...x, ...form } : x));
      setEditingId(null);
    } else {
      setUsers((u) => [...u, { id: Date.now(), title: "", ...form, status: "نشط" }]);
    }
    setForm({ firstName: "", middleName: "", lastName: "", email: "", role: "employee", dept: ORG_UNITS[0], family: JOB_FAMILIES[0].name });
    setShowAdd(false);
  };

  const startEdit = (u) => {
    setForm({ firstName: u.firstName, middleName: u.middleName || "", lastName: u.lastName, email: u.email, role: u.role, dept: u.dept, family: u.family });
    setEditingId(u.id);
    setShowAdd(true);
  };

  const fillFromAD = (entry) => {
    setForm((f) => ({ ...f, firstName: entry.firstName, middleName: entry.middleName, lastName: entry.lastName, email: entry.email, dept: entry.dept }));
    setShowAdSearch(false);
    setShowAdd(true);
  };
  const adResults = AD_DIRECTORY.filter((p) => `${p.firstName} ${p.middleName} ${p.lastName} ${p.email}`.includes(adQuery));

  const toggleStatus = (id) => {
    setUsers((u) => u.map((x) => x.id === id ? { ...x, status: x.status === "نشط" ? "غير نشط" : "نشط" } : x));
  };
  const removeUser = (id) => setUsers((u) => u.filter((x) => x.id !== id));
  const roleName = (id) => roles.find((r) => r.id === id)?.name || id;
  const scopeLabel = (r) => r.scope === "all" ? "كل الإدارات" : `${r.scope.length} جهة محددة`;

  const cellStyle = {
    none: { background: "#00000008", color: BRAND.gray },
    view: { background: "#80828522", color: BRAND.gray },
    prepare: { background: "#29ABE21F", color: BRAND.cyanDark },
    recommend: { background: "#E8A33D22", color: "#A9711E" },
    approve: { background: BRAND.purple, color: "#fff" },
  };

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="ضبط الوصول حسب المستوى الهرمي (عرض - إعداد - ترشيح - اعتماد)" title="الصلاحيات وإدارة المستخدمين" />

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm overflow-x-auto">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="font-bold text-sm flex items-center gap-2" style={{ color: BRAND.dark }}>
            <ShieldCheck size={16} color={BRAND.purple} /> مصفوفة الصلاحيات حسب الدور (VPRA)
          </h3>
          <button onClick={() => setShowAddRole((s) => !s)} className="flex items-center gap-1.5 text-xs font-bold text-white rounded-xl px-3.5 py-2" style={{ background: BRAND.cyanDark }}>
            <Plus size={14} /> إضافة دور
          </button>
        </div>

        {showAddRole && (
          <div className="mb-4 p-4 rounded-xl space-y-3" style={{ background: BRAND.bg }}>
            <input placeholder="اسم الدور الجديد" value={roleForm.name} onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
            <div className="flex items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5 font-semibold" style={{ color: BRAND.dark }}>
                <input type="radio" checked={roleForm.scopeAll} onChange={() => setRoleForm({ ...roleForm, scopeAll: true })} /> صلاحية على كل الإدارات
              </label>
              <label className="flex items-center gap-1.5 font-semibold" style={{ color: BRAND.dark }}>
                <input type="radio" checked={!roleForm.scopeAll} onChange={() => setRoleForm({ ...roleForm, scopeAll: false })} /> إدارات محددة
              </label>
            </div>
            {!roleForm.scopeAll && (
              <div className="grid sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto p-2 rounded-lg bg-white border border-black/5">
                {ORG_UNITS.map((u) => (
                  <label key={u} className="flex items-center gap-1.5 text-[11px] text-[#231F20]">
                    <input type="checkbox" checked={roleForm.scopeUnits.includes(u)} onChange={() => toggleScopeUnit(u)} /> {u}
                  </label>
                ))}
              </div>
            )}
            <button onClick={addRole} className="text-xs font-bold text-white rounded-lg px-4 py-2" style={{ background: BRAND.purple }}>حفظ الدور</button>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-5">
          {roles.map((r) => (
            <button
              key={r.id} onClick={() => setSelectedRoleId(r.id)}
              className="text-xs font-bold px-4 py-2.5 rounded-xl text-right transition-colors"
              style={selectedRoleId === r.id ? { background: BRAND.purple, color: "#fff" } : { background: BRAND.bg, color: BRAND.dark }}
            >
              {r.name}
              <div className="text-[10px] font-normal" style={{ color: selectedRoleId === r.id ? "#ffffffcc" : BRAND.gray }}>{scopeLabel(r)}</div>
            </button>
          ))}
        </div>

        {selectedRole && (
          <div className="divide-y divide-black/5 border border-black/5 rounded-xl overflow-hidden">
            {PROCESS_AREAS.map((area) => {
              const level = selectedRole.matrix[area.key] || "none";
              return (
                <div key={area.key} className="flex items-center justify-between gap-3 px-4 py-3 flex-wrap">
                  <span className="text-xs font-semibold" style={{ color: BRAND.dark }}>{area.label}</span>
                  <div className="flex rounded-lg overflow-hidden border border-black/10">
                    {VPRA_LEVELS.map((l) => (
                      <button
                        key={l.key}
                        onClick={() => setCell(selectedRole.id, area.key, l.key)}
                        className="text-[10.5px] font-bold px-2.5 py-1.5 min-w-[44px]"
                        style={level === l.key ? cellStyle[l.key] : { background: "#fff", color: BRAND.gray }}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-[11px] text-[#808285] mt-3">اختر الدور من الأعلى، ثم حدد مستوى الصلاحية (- / عرض / إعداد / ترشيح / اعتماد) لكل مجال عملية — للتجربة داخل النموذج فقط.</p>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="font-bold text-sm flex items-center gap-2" style={{ color: BRAND.dark }}>
            <Users size={16} color={BRAND.cyanDark} /> المستخدمون ({users.length})
          </h3>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setShowImport((s) => !s)} className="flex items-center gap-1.5 text-xs font-bold rounded-xl px-3.5 py-2 border border-black/10" style={{ color: BRAND.dark }}>
              <UploadCloud size={14} /> استيراد بيانات الموظفين (Excel)
            </button>
            <button onClick={() => { setShowAdSearch((s) => !s); setShowAdd(false); }} className="flex items-center gap-1.5 text-xs font-bold rounded-xl px-3.5 py-2 border border-black/10" style={{ color: BRAND.dark }}>
              <ShieldCheck size={14} /> ربط عبر Active Directory
            </button>
            <button onClick={() => { setEditingId(null); setForm({ firstName: "", middleName: "", lastName: "", email: "", role: "employee", dept: ORG_UNITS[0], family: JOB_FAMILIES[0].name }); setShowAdSearch(false); setShowAdd((s) => !s); }} className="flex items-center gap-1.5 text-xs font-bold text-white rounded-xl px-3.5 py-2" style={{ background: BRAND.purple }}>
              <UserPlus size={14} /> إضافة مستخدم
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between mb-4 p-3 rounded-xl flex-wrap gap-2" style={{ background: BRAND.bg }}>
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} color={BRAND.gray} />
            <span className="text-xs font-semibold" style={{ color: BRAND.dark }}>مزامنة تلقائية مع Active Directory</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setAdSync((s) => !s)} className="w-10 h-5 rounded-full relative transition-colors" style={{ background: adSync ? BRAND.purple : "#00000022" }}>
              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ [adSync ? "right" : "left"]: "2px" }} />
            </button>
            <span className="text-[11px] text-[#808285]">{adSync ? "مفعّلة — سيتم الربط بخادم LDAP عند التكامل الفعلي" : "غير مفعّلة"}</span>
          </div>
        </div>

        {showAdSearch && (
          <div className="mb-5 border border-black/5 rounded-2xl p-4 space-y-3" style={{ background: BRAND.bg }}>
            <p className="text-[11px] text-[#808285]">بحث تجريبي في دليل Active Directory الخاص بالجامعة — اختر مستخدماً لتعبئة بياناته تلقائياً في نموذج الإضافة.</p>
            <input placeholder="ابحث بالاسم أو البريد الإلكتروني..." value={adQuery} onChange={(e) => setAdQuery(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {adResults.length === 0 && <p className="text-xs text-[#808285]">لا نتائج مطابقة.</p>}
              {adResults.map((p) => (
                <button key={p.email} onClick={() => fillFromAD(p)} className="w-full flex items-center justify-between text-right rounded-lg border border-black/5 bg-white px-3 py-2 hover:border-black/20">
                  <span className="text-xs font-semibold" style={{ color: BRAND.dark }}>{[p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ")}</span>
                  <span className="text-[11px] text-[#808285]">{p.email} — {p.dept}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {showImport && (
          <div className="mb-5 border border-black/5 rounded-2xl p-4" style={{ background: BRAND.bg }}>
            <ImportEmployeesTab />
          </div>
        )}

        {showAdd && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5 mb-4 p-3.5 rounded-xl" style={{ background: BRAND.bg }}>
            <input placeholder="الاسم الأول *" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
            <input placeholder="الاسم الأوسط (اختياري)" value={form.middleName} onChange={(e) => setForm({ ...form, middleName: e.target.value })}
              className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
            <input placeholder="الاسم الأخير *" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
            <input placeholder="البريد الإلكتروني" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="rounded-lg border border-black/10 px-3 py-2 text-xs">
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <select value={form.dept} onChange={(e) => setForm({ ...form, dept: e.target.value })} className="rounded-lg border border-black/10 px-3 py-2 text-xs">
              {ORG_UNITS.map((u) => <option key={u}>{u}</option>)}
            </select>
            <select value={form.family} onChange={(e) => setForm({ ...form, family: e.target.value })} className="rounded-lg border border-black/10 px-3 py-2 text-xs">
              {JOB_FAMILIES.map((f) => <option key={f.id}>{f.name}</option>)}
            </select>
            <button onClick={addUser} className="rounded-lg text-xs font-bold text-white py-2 lg:col-span-3" style={{ background: BRAND.cyanDark }}>{editingId ? "تحديث بيانات المستخدم" : "حفظ المستخدم"}</button>
            <p className="text-[10px] text-[#808285] lg:col-span-3">الحقول المميزة بـ * إجبارية.</p>
          </div>
        )}

        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="text-right text-[#808285] text-xs border-b border-black/5">
                <th className="py-2 px-2 font-semibold">الاسم</th>
                <th className="py-2 px-2 font-semibold">البريد الإلكتروني</th>
                <th className="py-2 px-2 font-semibold">الدور</th>
                <th className="py-2 px-2 font-semibold">الجهة</th>
                <th className="py-2 px-2 font-semibold">الفئة الوظيفية</th>
                <th className="py-2 px-2 font-semibold">الحالة</th>
                <th className="py-2 px-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-black/5 last:border-0">
                  <td className="py-2.5 px-2 font-semibold" style={{ color: BRAND.dark }}>{fullName(u)}</td>
                  <td className="py-2.5 px-2 text-[#808285]">{u.email}</td>
                  <td className="py-2.5 px-2">
                    <span className="text-[11px] font-bold px-2.5 py-1 rounded-full" style={{ background: "#662D9114", color: BRAND.purple }}>{roleName(u.role)}</span>
                  </td>
                  <td className="py-2.5 px-2 text-[#808285]">{u.dept}</td>
                  <td className="py-2.5 px-2 text-[#808285]">{u.family}</td>
                  <td className="py-2.5 px-2">
                    <button onClick={() => toggleStatus(u.id)} className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${u.status === "نشط" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
                      {u.status}
                    </button>
                  </td>
                  <td className="py-2.5 px-2 text-left">
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={() => startEdit(u)}><Pencil size={14} color={BRAND.gray} /></button>
                      <button onClick={() => removeUser(u.id)}><Trash2 size={14} color={BRAND.gray} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================= التبويب: مكتبة الأهداف الاستراتيجية ============================= */

function GoalsLibraryTab({ goals, setGoals }) {
  const [openId, setOpenId] = useState(goals[0]?.id ?? null);
  const [goalName, setGoalName] = useState("");
  const [subForms, setSubForms] = useState({});
  const fileRef = useRef(null);

  const addGoal = () => {
    if (!goalName.trim()) return;
    const id = Date.now();
    setGoals((g) => [...g, { id, name: goalName, subGoals: [] }]);
    setGoalName("");
    setOpenId(id);
  };
  const removeGoal = (id) => setGoals((g) => g.filter((x) => x.id !== id));

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        setGoals((prev) => {
          const next = [...prev];
          rows.forEach((r) => {
            const mainName = String(r["الهدف الرئيسي"] || "").trim();
            const subName = String(r["الهدف الفرعي"] || "").trim();
            if (!mainName || !subName) return;
            let g = next.find((x) => x.name === mainName);
            if (!g) { g = { id: Date.now() + Math.random(), name: mainName, subGoals: [] }; next.push(g); }
            g.subGoals.push({
              id: Date.now() + Math.random(),
              name: subName,
              kpi: String(r["مؤشر الأداء"] || ""),
              targetYear: String(r["مستهدف العام الحالي"] || ""),
              targetPlan: String(r["مستهدف نهاية الخطة"] || ""),
            });
          });
          return [...next];
        });
      } catch (err) { /* ignore malformed file */ }
    };
    reader.readAsBinaryString(file);
    e.target.value = "";
  };

  const getSubForm = (goalId) => subForms[goalId] || { name: "", kpi: "", targetYear: "", targetPlan: "" };
  const setSubForm = (goalId, patch) => setSubForms((f) => ({ ...f, [goalId]: { ...getSubForm(goalId), ...patch } }));

  const addSubGoal = (goalId) => {
    const f = getSubForm(goalId);
    if (!f.name.trim()) return;
    setGoals((gs) => gs.map((g) => g.id === goalId ? { ...g, subGoals: [...g.subGoals, { id: Date.now(), name: f.name, kpi: f.kpi, targetYear: f.targetYear, targetPlan: f.targetPlan }] } : g));
    setSubForm(goalId, { name: "", kpi: "", targetYear: "", targetPlan: "" });
  };
  const removeSubGoal = (goalId, subId) => setGoals((gs) => gs.map((g) => g.id === goalId ? { ...g, subGoals: g.subGoals.filter((sg) => sg.id !== subId) } : g));

  return (
    <div className="space-y-6">
      <p className="text-xs text-[#808285]">
        كل هدف استراتيجي رئيسي يتفرع إلى أهداف فرعية، ولكل هدف فرعي مؤشر أداء (KPI) ومستهدفان: مستهدف العام الحالي ومستهدف نهاية الخطة —
        وهذا الهدف الفرعي بالذات هو ما يُسنَد لاحقاً للموظف في شاشة الإسناد.
      </p>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <h3 className="font-bold text-sm mb-3" style={{ color: BRAND.dark }}>إضافة هدف استراتيجي رئيسي</h3>
        <div className="flex gap-2.5 flex-wrap">
          <input placeholder="اسم الهدف الاستراتيجي الرئيسي" value={goalName} onChange={(e) => setGoalName(e.target.value)}
            className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
          <button onClick={addGoal} className="flex items-center gap-1.5 text-xs font-bold text-white rounded-lg px-4 py-2 shrink-0" style={{ background: BRAND.purple }}>
            <Plus size={13} /> إضافة
          </button>
          <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 text-xs font-bold rounded-lg px-4 py-2 shrink-0 border border-black/10" style={{ color: BRAND.dark }}>
            <UploadCloud size={13} /> استيراد من Excel
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleImport} className="hidden" />
        </div>
        <p className="text-[10.5px] text-[#808285] mt-2">أعمدة الملف المتوقعة: الهدف الرئيسي، الهدف الفرعي، مؤشر الأداء، مستهدف العام الحالي، مستهدف نهاية الخطة.</p>
      </div>

      <div className="space-y-4">
        {goals.map((g) => {
          const open = openId === g.id;
          const sf = getSubForm(g.id);
          return (
            <div key={g.id} className="bg-white rounded-2xl border border-black/5 shadow-sm overflow-hidden">
              <button onClick={() => setOpenId(open ? null : g.id)} className="w-full flex items-center justify-between px-5 py-3.5 text-right hover:bg-black/[0.02]">
                <span className="flex items-center gap-2.5">
                  <ChevronRight size={15} className={`transition-transform ${open ? "rotate-90" : ""}`} color={BRAND.gray} />
                  <span className="font-bold text-sm" style={{ color: BRAND.dark }}>{g.name}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-[11px] text-[#808285]">{g.subGoals.length} هدف فرعي</span>
                  <Trash2 size={14} color={BRAND.gray} onClick={(e) => { e.stopPropagation(); removeGoal(g.id); }} />
                </span>
              </button>
              {open && (
                <div className="px-5 pb-5 pt-1 space-y-3">
                  {g.subGoals.map((sg) => (
                    <div key={sg.id} className="rounded-lg border border-black/5 px-3.5 py-2.5" style={{ background: BRAND.bg }}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="flex-1 text-xs font-bold" style={{ color: BRAND.dark }}>{sg.name}</span>
                        <button onClick={() => removeSubGoal(g.id, sg.id)}><Trash2 size={13} color={BRAND.gray} /></button>
                      </div>
                      <div className="grid sm:grid-cols-3 gap-1 text-[11px] text-[#808285]">
                        <span>مؤشر الأداء (KPI): {sg.kpi || "—"}</span>
                        <span>مستهدف العام الحالي: {sg.targetYear || "—"}</span>
                        <span>مستهدف نهاية الخطة: {sg.targetPlan || "—"}</span>
                      </div>
                    </div>
                  ))}
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-2 border-t border-black/5">
                    <input placeholder="اسم الهدف الفرعي" value={sf.name} onChange={(e) => setSubForm(g.id, { name: e.target.value })}
                      className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
                    <input placeholder="مؤشر الأداء (KPI)" value={sf.kpi} onChange={(e) => setSubForm(g.id, { kpi: e.target.value })}
                      className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
                    <input placeholder="مستهدف العام الحالي" value={sf.targetYear} onChange={(e) => setSubForm(g.id, { targetYear: e.target.value })}
                      className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
                    <input placeholder="مستهدف نهاية الخطة" value={sf.targetPlan} onChange={(e) => setSubForm(g.id, { targetPlan: e.target.value })}
                      className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
                  </div>
                  <button onClick={() => addSubGoal(g.id)} className="flex items-center gap-1.5 text-xs font-bold text-white rounded-lg px-4 py-2" style={{ background: BRAND.cyanDark }}>
                    <Plus size={13} /> إضافة هدف فرعي
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================= التبويب: الأعمال الروتينية ============================= */

function RoutineTasksLibraryTab({ tasks, setTasks }) {
  const [form, setForm] = useState({ name: "", kpi: "", family: JOB_FAMILIES[0].name });

  const addTask = () => {
    if (!form.name.trim()) return;
    setTasks((t) => [...t, { id: Date.now(), ...form }]);
    setForm({ name: "", kpi: "", family: JOB_FAMILIES[0].name });
  };
  const removeTask = (id) => setTasks((t) => t.filter((x) => x.id !== id));

  return (
    <div className="space-y-6">
      <p className="text-xs text-[#808285]">
        مكتبة الأعمال والمهام الروتينية اليومية (BAU) بمؤشر أدائها — مبوَّبة افتراضياً حسب الوصف الوظيفي (الفئة الوظيفية)،
        ويختار الرئيس المباشر منها عند إسناد مهام الموظف، مع إمكانية تعديل الوزن لكل موظف.
      </p>
      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
          <input placeholder="اسم المهمة الروتينية" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
          <input placeholder="مؤشر الأداء (KPI)" value={form.kpi} onChange={(e) => setForm({ ...form, kpi: e.target.value })}
            className="rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
          <select value={form.family} onChange={(e) => setForm({ ...form, family: e.target.value })} className="rounded-lg border border-black/10 px-3 py-2 text-xs">
            {JOB_FAMILIES.map((f) => <option key={f.id}>{f.name}</option>)}
          </select>
          <button onClick={addTask} className="flex items-center justify-center gap-1.5 text-xs font-bold text-white rounded-lg px-4 py-2" style={{ background: BRAND.purple }}>
            <Plus size={13} /> إضافة
          </button>
        </div>
        <div className="space-y-4">
          {JOB_FAMILIES.map((fam) => {
            const famTasks = tasks.filter((t) => t.family === fam.name);
            if (famTasks.length === 0) return null;
            return (
              <div key={fam.id}>
                <div className="text-[11px] font-extrabold mb-1.5" style={{ color: BRAND.purple }}>{fam.name}</div>
                <div className="space-y-2">
                  {famTasks.map((t) => (
                    <div key={t.id} className="flex items-center gap-3 rounded-lg border border-black/5 px-3.5 py-2.5">
                      <span className="flex-1 text-xs font-semibold" style={{ color: BRAND.dark }}>{t.name}</span>
                      <span className="text-[11px] text-[#808285]">{t.kpi}</span>
                      <button onClick={() => removeTask(t.id)}><Trash2 size={13} color={BRAND.gray} /></button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================= التبويب: مصادر التقييم (تجميع المكتبات الثلاث) ============================= */

function EvaluationSourcesTab({ goals, setGoals, framework, setFramework, tasks, setTasks }) {
  const [sub, setSub] = useState("goals");
  const SUBS = [
    { id: "goals", label: "مكتبة الأهداف الاستراتيجية" },
    { id: "competencies", label: "إطار الجدارات" },
    { id: "tasks", label: "الأعمال الروتينية" },
  ];
  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="المصادر الموحّدة لشاشة إسناد الأهداف والجدارات" title="مصادر التقييم">
        <div className="flex gap-2 flex-wrap">
          {SUBS.map((s) => (
            <button
              key={s.id} onClick={() => setSub(s.id)}
              className="text-xs font-bold px-4 py-2 rounded-xl"
              style={sub === s.id ? { background: BRAND.purple, color: "#fff" } : { background: "#fff", color: BRAND.gray, border: "1px solid #eee" }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </SectionTitle>
      {sub === "goals" && <GoalsLibraryTab goals={goals} setGoals={setGoals} />}
      {sub === "competencies" && <CompetencyFrameworkTab framework={framework} setFramework={setFramework} />}
      {sub === "tasks" && <RoutineTasksLibraryTab tasks={tasks} setTasks={setTasks} />}
    </div>
  );
}

/* ============================= التبويب: إسناد الأهداف والجدارات ============================= */

function AxisWrap({ title, target, total, children }) {
  return (
    <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-sm" style={{ color: BRAND.dark }}>{title}</h3>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${total === target ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>{total}% / {target}%</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-black/5 mb-4 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, (total / (target || 1)) * 100)}%`, background: total === target ? "#3B9E5C" : BRAND.cyan }} />
      </div>
      {children}
    </div>
  );
}

function AssignmentEditor({ assignment, setAssignment, family, goalsLib, framework, routineTasks }) {
  const flatSubGoals = goalsLib.flatMap((g) => g.subGoals.map((sg) => ({ ...sg, goalId: g.id, goalName: g.name })));
  const flatCompetencies = framework.flatMap((g) => g.items.map((i) => ({ name: i.name, domain: g.domain, type: i.type })));
  const fullCompetencies = framework.flatMap((g) => g.items);

  const [draftGoal, setDraftGoal] = useState({ subGoalId: flatSubGoals[0]?.id, weight: 10 });
  const [draftTask, setDraftTask] = useState({ taskId: routineTasks[0]?.id, weight: 10 });
  const [draftComp, setDraftComp] = useState({ name: flatCompetencies[0]?.name, level: null, weight: 10 });

  const sum = (arr) => arr.reduce((a, b) => a + Number(b.weight || 0), 0);
  const clamp = (v, max) => Math.max(0, Math.min(Number(v) || 0, max));
  const subGoal = (id) => flatSubGoals.find((s) => s.id === Number(id));
  const availableSubGoals = flatSubGoals.filter((s) => !assignment.goals.some((x) => x.subGoalId === s.id));

  const goalsRemaining = family.strategic - sum(assignment.goals);
  const tasksRemaining = family.bau - sum(assignment.tasks);
  const compRemaining = family.competency - sum(assignment.competencies);

  const addGoal = () => {
    if (!draftGoal.subGoalId || assignment.goals.some((g) => g.subGoalId === Number(draftGoal.subGoalId)) || goalsRemaining <= 0) return;
    setAssignment((a) => ({ ...a, goals: [...a.goals, { subGoalId: Number(draftGoal.subGoalId), weight: clamp(draftGoal.weight, goalsRemaining) }] }));
  };
  const removeGoal = (subGoalId) => setAssignment((a) => ({ ...a, goals: a.goals.filter((g) => g.subGoalId !== subGoalId) }));
  const updateGoalWeight = (subGoalId, w) => setAssignment((a) => {
    const others = sum(a.goals.filter((g) => g.subGoalId !== subGoalId));
    return { ...a, goals: a.goals.map((g) => g.subGoalId === subGoalId ? { ...g, weight: clamp(w, family.strategic - others) } : g) };
  });

  const addTask = () => {
    if (!draftTask.taskId || assignment.tasks.some((t) => t.taskId === Number(draftTask.taskId)) || tasksRemaining <= 0) return;
    setAssignment((a) => ({ ...a, tasks: [...a.tasks, { taskId: Number(draftTask.taskId), weight: clamp(draftTask.weight, tasksRemaining) }] }));
  };
  const removeTask = (taskId) => setAssignment((a) => ({ ...a, tasks: a.tasks.filter((t) => t.taskId !== taskId) }));
  const updateTaskWeight = (taskId, w) => setAssignment((a) => {
    const others = sum(a.tasks.filter((t) => t.taskId !== taskId));
    return { ...a, tasks: a.tasks.map((t) => t.taskId === taskId ? { ...t, weight: clamp(w, family.bau - others) } : t) };
  });

  const addComp = () => {
    if (!draftComp.name || draftComp.level === null || assignment.competencies.some((c) => c.name === draftComp.name) || compRemaining <= 0) return;
    setAssignment((a) => ({ ...a, competencies: [...a.competencies, { name: draftComp.name, level: Number(draftComp.level), weight: clamp(draftComp.weight, compRemaining) }] }));
    setDraftComp({ name: flatCompetencies.find((c) => c.name !== draftComp.name)?.name || draftComp.name, level: null, weight: 10 });
  };
  const removeComp = (name) => setAssignment((a) => ({ ...a, competencies: a.competencies.filter((c) => c.name !== name) }));
  const updateComp = (name, field, val) => setAssignment((a) => {
    if (field === "weight") {
      const others = sum(a.competencies.filter((c) => c.name !== name));
      val = clamp(val, family.competency - others);
    }
    return { ...a, competencies: a.competencies.map((c) => c.name === name ? { ...c, [field]: Number(val) } : c) };
  });

  const draftCompFull = fullCompetencies.find((c) => c.name === draftComp.name);

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <AxisWrap title="الأهداف الاستراتيجية (من المكتبة)" target={family.strategic} total={sum(assignment.goals)}>
        <div className="space-y-2 mb-3">
          {assignment.goals.length === 0 && <p className="text-xs text-[#808285]">لا توجد أهداف مُسندة بعد.</p>}
          {assignment.goals.map((g) => {
            const sg = subGoal(g.subGoalId);
            return (
              <div key={g.subGoalId} className="rounded-lg border border-black/5 px-3 py-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-xs font-semibold" style={{ color: BRAND.dark }}>{sg?.name}</span>
                  <input type="number" min={0} max={100} value={g.weight} onChange={(e) => updateGoalWeight(g.subGoalId, e.target.value)} className="w-14 text-center text-xs border border-black/10 rounded-md py-1" />
                  <span className="text-[11px] text-[#808285]">%</span>
                  <button onClick={() => removeGoal(g.subGoalId)}><Trash2 size={13} color={BRAND.gray} /></button>
                </div>
                <div className="text-[10.5px] text-[#808285]">{sg?.goalName} — {sg?.kpi} — العام الحالي: {sg?.targetYear} — نهاية الخطة: {sg?.targetPlan}</div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          <select value={draftGoal.subGoalId} onChange={(e) => setDraftGoal({ ...draftGoal, subGoalId: e.target.value })} className="flex-1 text-xs rounded-lg border border-black/10 px-2 py-2">
            {goalsLib.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {g.subGoals.filter((sg) => availableSubGoals.some((a) => a.id === sg.id)).map((sg) => (
                  <option key={sg.id} value={sg.id}>{sg.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <input type="number" min={0} max={Math.max(0, goalsRemaining)} value={draftGoal.weight} onChange={(e) => setDraftGoal({ ...draftGoal, weight: clamp(e.target.value, goalsRemaining) })} className="w-16 text-center text-xs border border-black/10 rounded-lg" />
          <button onClick={addGoal} disabled={goalsRemaining <= 0} className="shrink-0 flex items-center gap-1 text-xs font-bold text-white rounded-lg px-3 disabled:opacity-40" style={{ background: BRAND.purple }}><Plus size={13} /></button>
        </div>
        {goalsRemaining <= 0 && assignment.goals.length > 0 && <p className="text-[10.5px] text-red-500 mt-1.5">تم استنفاد وزن هذا المحور بالكامل ({family.strategic}%).</p>}
      </AxisWrap>

      <AxisWrap title="المهام اليومية (BAU) — من مكتبة الأعمال الروتينية" target={family.bau} total={sum(assignment.tasks)}>
        <div className="space-y-2 mb-3">
          {assignment.tasks.length === 0 && <p className="text-xs text-[#808285]">لا توجد مهام مُسندة بعد.</p>}
          {assignment.tasks.map((t) => {
            const rt = routineTasks.find((r) => r.id === t.taskId);
            return (
              <div key={t.taskId} className="rounded-lg border border-black/5 px-3 py-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-xs font-semibold" style={{ color: BRAND.dark }}>{rt?.name}</span>
                  <input type="number" min={0} max={100} value={t.weight} onChange={(e) => updateTaskWeight(t.taskId, e.target.value)} className="w-14 text-center text-xs border border-black/10 rounded-md py-1" />
                  <span className="text-[11px] text-[#808285]">%</span>
                  <button onClick={() => removeTask(t.taskId)}><Trash2 size={13} color={BRAND.gray} /></button>
                </div>
                <div className="text-[10.5px] text-[#808285]">مؤشر الأداء: {rt?.kpi || "—"}</div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          <select value={draftTask.taskId} onChange={(e) => setDraftTask({ ...draftTask, taskId: e.target.value })} className="flex-1 text-xs rounded-lg border border-black/10 px-2 py-2">
            {routineTasks.filter((rt) => !assignment.tasks.some((t) => t.taskId === rt.id)).map((rt) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
          </select>
          <input type="number" min={0} max={Math.max(0, tasksRemaining)} value={draftTask.weight} onChange={(e) => setDraftTask({ ...draftTask, weight: clamp(e.target.value, tasksRemaining) })} className="w-16 text-center text-xs border border-black/10 rounded-lg" />
          <button onClick={addTask} disabled={tasksRemaining <= 0} className="shrink-0 flex items-center gap-1 text-xs font-bold text-white rounded-lg px-3 disabled:opacity-40" style={{ background: BRAND.purple }}><Plus size={13} /></button>
        </div>
        {tasksRemaining <= 0 && assignment.tasks.length > 0 && <p className="text-[10.5px] text-red-500 mt-1.5">تم استنفاد وزن هذا المحور بالكامل ({family.bau}%).</p>}
      </AxisWrap>

      <AxisWrap title="الجدارات ومستوى كل منها" target={family.competency} total={sum(assignment.competencies)}>
        <div className="space-y-2 mb-3">
          {assignment.competencies.length === 0 && <p className="text-xs text-[#808285]">لا توجد جدارات مُسندة بعد.</p>}
          {assignment.competencies.map((c) => (
            <div key={c.name} className="rounded-lg border border-black/5 px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-xs font-semibold" style={{ color: BRAND.dark }}>{c.name}</span>
                <input type="number" min={0} max={100} value={c.weight} onChange={(e) => updateComp(c.name, "weight", e.target.value)} className="w-14 text-center text-xs border border-black/10 rounded-md py-1" />
                <span className="text-[11px] text-[#808285]">%</span>
                <button onClick={() => removeComp(c.name)}><Trash2 size={13} color={BRAND.gray} /></button>
              </div>
              <select value={c.level} onChange={(e) => updateComp(c.name, "level", e.target.value)} className="w-full text-[11px] rounded-md border border-black/10 px-2 py-1">
                {COMPETENCY_LEVEL_LABELS.map((l, i) => <option key={i} value={i}>المستوى المطلوب: {l}</option>)}
              </select>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <select
            value={draftComp.name}
            onChange={(e) => setDraftComp({ name: e.target.value, level: null, weight: draftComp.weight })}
            className="w-full text-xs rounded-lg border border-black/10 px-2 py-2"
          >
            {flatCompetencies.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>

          {draftCompFull && (
            <div className="rounded-lg border border-black/5 p-2.5" style={{ background: BRAND.bg }}>
              <p className="text-[10.5px] text-[#808285] mb-2">{draftCompFull.def}</p>
              <div className="grid grid-cols-2 gap-1.5">
                {draftCompFull.levels.map((lvl, li) => (
                  <button
                    key={li} type="button" onClick={() => setDraftComp({ ...draftComp, level: li })}
                    className="text-right rounded-lg border p-1.5"
                    style={{ borderColor: draftComp.level === li ? BRAND.purple : "#eee", background: draftComp.level === li ? "#662D9110" : "#fff" }}
                  >
                    <div className="text-[10px] font-extrabold" style={{ color: draftComp.level === li ? BRAND.purple : BRAND.gray }}>{COMPETENCY_LEVEL_LABELS[li]}</div>
                    <p className="text-[9.5px] leading-4 text-[#231F20] line-clamp-2">{lvl}</p>
                  </button>
                ))}
              </div>
              {draftComp.level === null && <p className="text-[10px] text-red-500 mt-1.5">اختر مستوى الجدارة المطلوب قبل الإضافة.</p>}
            </div>
          )}

          <div className="flex gap-2">
            <input type="number" min={0} max={Math.max(0, compRemaining)} value={draftComp.weight} onChange={(e) => setDraftComp({ ...draftComp, weight: clamp(e.target.value, compRemaining) })} className="w-20 text-center text-xs border border-black/10 rounded-lg" />
            <button onClick={addComp} disabled={draftComp.level === null || compRemaining <= 0} className="flex-1 flex items-center justify-center gap-1 text-xs font-bold text-white rounded-lg px-3 disabled:opacity-40" style={{ background: BRAND.purple }}>
              <Plus size={13} /> إضافة الجدارة
            </button>
          </div>
          {compRemaining <= 0 && assignment.competencies.length > 0 && <p className="text-[10.5px] text-red-500">تم استنفاد وزن هذا المحور بالكامل ({family.competency}%).</p>}
        </div>
      </AxisWrap>
    </div>
  );
}

function AssignmentTab({ templates, setTemplates, individual, setIndividual, goalsLib, framework, routineTasks, currentManager, familyWeights, setFamilyWeights }) {
  const [mode, setMode] = useState("template");
  const [familyId, setFamilyId] = useState(JOB_FAMILIES[0].id);
  const effectiveFamily = (f) => ({ ...f, ...(familyWeights[f.id] || {}) });
  const family = effectiveFamily(JOB_FAMILIES.find((f) => f.id === familyId));
  const setTemplateFor = (updater) => setTemplates((prev) => ({ ...prev, [familyId]: typeof updater === "function" ? updater(prev[familyId]) : updater }));
  const updateFamilyWeight = (key, val) => {
    setFamilyWeights((w) => ({ ...w, [familyId]: { ...family, ...w[familyId], [key]: Math.max(0, Math.min(100, Number(val) || 0)) } }));
  };
  const familyWeightSum = family.strategic + family.bau + family.competency;

  const [indivFamilyId, setIndivFamilyId] = useState(JOB_FAMILIES[0].id);
  const indivFamily = effectiveFamily(JOB_FAMILIES.find((f) => f.id === indivFamilyId));
  const myReportsInFamily = EMPLOYEES.filter((e) => e.manager === currentManager && e.family === indivFamily.name);
  const [employeeName, setEmployeeName] = useState(myReportsInFamily[0]?.name);
  const employee = EMPLOYEES.find((e) => e.name === employeeName && e.manager === currentManager) || myReportsInFamily[0];
  const employeeAssignment = employee ? (individual[employee.name] || templates[indivFamilyId] || emptyAssignment()) : emptyAssignment();
  const isCustom = employee ? !!individual[employee.name] : false;
  const setEmployeeAssignment = (updater) => {
    if (!employee) return;
    setIndividual((prev) => {
      const base = prev[employee.name] || JSON.parse(JSON.stringify(templates[indivFamilyId] || emptyAssignment()));
      return { ...prev, [employee.name]: typeof updater === "function" ? updater(base) : updater };
    });
  };
  const resetToDefault = () => { if (employee) setIndividual((prev) => { const cp = { ...prev }; delete cp[employee.name]; return cp; }); };

  const onIndivFamilyChange = (fid) => {
    setIndivFamilyId(fid);
    const famName = JOB_FAMILIES.find((f) => f.id === fid)?.name;
    const list = EMPLOYEES.filter((e) => e.manager === currentManager && e.family === famName);
    setEmployeeName(list[0]?.name);
  };

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="من يملك صلاحية إعداد على مجال إسناد الأهداف" title="إسناد الأهداف والمهام والجدارات ووزنها">
        <div className="flex gap-2">
          <button onClick={() => setMode("template")} className="text-xs font-bold px-4 py-2 rounded-xl" style={mode === "template" ? { background: BRAND.purple, color: "#fff" } : { background: "#fff", color: BRAND.gray, border: "1px solid #eee" }}>القالب الافتراضي (حسب الفئة)</button>
          <button onClick={() => setMode("individual")} className="text-xs font-bold px-4 py-2 rounded-xl" style={mode === "individual" ? { background: BRAND.purple, color: "#fff" } : { background: "#fff", color: BRAND.gray, border: "1px solid #eee" }}>الإسناد الفردي (حسب الموظف)</button>
        </div>
      </SectionTitle>

      {mode === "template" ? (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3 -mt-3">
            <p className="text-xs text-[#808285]">
              هذا القالب يُطبَّق تلقائياً كافتراضي (Default) على كل موظف جديد ضمن هذه الفئة — وتعديله محكوم بصلاحية "القوالب الافتراضية"
              في صفحة الصلاحيات (تُسند حسب توزيع الأدوار)، وللرئيس المباشر لاحقاً حق تخصيصه فردياً.
            </p>
            <div className="relative">
              <select value={familyId} onChange={(e) => setFamilyId(e.target.value)} className="appearance-none bg-white border border-black/10 rounded-xl pl-9 pr-4 py-2 text-sm font-semibold">
                {JOB_FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <ChevronDown size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#808285]" />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-black/5 p-4 flex flex-wrap items-center gap-4">
            <span className="text-xs font-bold" style={{ color: BRAND.dark }}>أوزان محاور "{family.name}":</span>
            {[["strategic", "استراتيجي", BRAND.purple], ["bau", "BAU", BRAND.cyan], ["competency", "جدارات", "#9AA0A6"]].map(([key, label, color]) => (
              <div key={key} className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold" style={{ color }}>{label}</span>
                <input type="number" min={0} max={100} value={family[key]} onChange={(e) => updateFamilyWeight(key, e.target.value)}
                  className="w-16 text-center text-xs border border-black/10 rounded-lg py-1" />
                <span className="text-[11px] text-[#808285]">%</span>
              </div>
            ))}
            <span className={`mr-auto text-xs font-bold px-2.5 py-1 rounded-full ${familyWeightSum === 100 ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>
              الإجمالي {familyWeightSum}%
            </span>
          </div>
          {familyWeightSum !== 100 && (
            <p className="text-[10.5px] text-red-500 -mt-3">يجب أن يساوي مجموع أوزان المحاور 100% لهذه الفئة.</p>
          )}

          <AssignmentEditor assignment={templates[familyId]} setAssignment={setTemplateFor} family={family} goalsLib={goalsLib} framework={framework} routineTasks={routineTasks} />
        </>
      ) : (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3 -mt-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-[#808285]">مسجّل الدخول: <span className="font-bold" style={{ color: BRAND.purple }}>{currentManager}</span></span>
              <div className="relative">
                <select value={indivFamilyId} onChange={(e) => onIndivFamilyChange(e.target.value)} className="appearance-none bg-white border border-black/10 rounded-xl pl-9 pr-4 py-2 text-sm font-semibold">
                  {JOB_FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <ChevronDown size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#808285]" />
              </div>
              {employee && (
                <div className="relative">
                  <select value={employee.name} onChange={(e) => setEmployeeName(e.target.value)} className="appearance-none bg-white border border-black/10 rounded-xl pl-9 pr-4 py-2 text-sm font-semibold">
                    {myReportsInFamily.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
                  </select>
                  <ChevronDown size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#808285]" />
                </div>
              )}
              {employee && (
                <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${isCustom ? "bg-amber-50 text-amber-600" : "bg-black/5 text-[#808285]"}`}>{isCustom ? "مُخصَّص لهذا الموظف" : "افتراضي حسب الفئة"}</span>
              )}
            </div>
            {isCustom && (
              <button onClick={resetToDefault} className="text-xs font-bold px-3.5 py-2 rounded-xl border border-black/10" style={{ color: BRAND.dark }}>إعادة تعيين للافتراضي</button>
            )}
          </div>
          {!employee ? (
            <p className="text-xs text-[#808285]">لا يوجد موظفون تابعون لك ضمن هذه الفئة الوظيفية في العينة التجريبية.</p>
          ) : (
            <AssignmentEditor assignment={employeeAssignment} setAssignment={setEmployeeAssignment} family={indivFamily} goalsLib={goalsLib} framework={framework} routineTasks={routineTasks} />
          )}
        </>
      )}
    </div>
  );
}

/* ============================= التبويب: نماذج التقويم ============================= */


function Evaluation360Panel() {
  const [raters, setRaters] = useState([
    { key: "self", label: "التقييم الذاتي", weight: 20, score: 88 },
    { key: "manager", label: "المدير المباشر", weight: 40, score: 82 },
    { key: "peers", label: "الزملاء", weight: 20, score: 79 },
    { key: "subordinates", label: "المرؤوسون", weight: 10, score: 90 },
    { key: "beneficiaries", label: "المستفيدون / الطلاب", weight: 10, score: 86 },
  ]);
  const update = (key, field, val) => setRaters((rs) => rs.map((r) => r.key === key ? { ...r, [field]: Number(val) } : r));
  const totalWeight = raters.reduce((a, r) => a + r.weight, 0);
  const weighted = raters.reduce((a, r) => a + (r.weight * r.score) / 100, 0);
  const chartData = raters.map((r) => ({ name: r.label, الدرجة: r.score }));

  return (
    <div className="space-y-5">
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="space-y-2.5">
          {raters.map((r) => (
            <div key={r.key} className="flex items-center gap-2 rounded-lg border border-black/5 px-3 py-2.5">
              <span className="flex-1 text-xs font-semibold" style={{ color: BRAND.dark }}>{r.label}</span>
              <div className="flex items-center gap-1">
                <input type="number" min={0} max={100} value={r.weight} onChange={(e) => update(r.key, "weight", e.target.value)} className="w-14 text-center text-xs border border-black/10 rounded-md py-1" />
                <span className="text-[10px] text-[#808285]">وزن%</span>
              </div>
              <div className="flex items-center gap-1">
                <input type="number" min={0} max={100} value={r.score} onChange={(e) => update(r.key, "score", e.target.value)} className="w-14 text-center text-xs border border-black/10 rounded-md py-1" />
                <span className="text-[10px] text-[#808285]">درجة</span>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between rounded-lg px-3 py-2.5" style={{ background: "#662D9114" }}>
            <span className="text-xs font-bold" style={{ color: BRAND.purple }}>الدرجة المرجحة النهائية</span>
            <span className="text-sm font-extrabold" style={{ color: BRAND.purple }}>{weighted.toFixed(1)} (وزن {totalWeight}%)</span>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-black/5 p-3">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eee" />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: BRAND.gray }} />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 10, fill: BRAND.gray }} />
              <Tooltip contentStyle={{ fontFamily: "Cairo", borderRadius: 12 }} />
              <Bar dataKey="الدرجة" fill={BRAND.cyan} radius={[0, 6, 6, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}


/* ============================= التبويب: المسارات الوظيفية ============================= */

function CareerPathsTab() {
  const employeesWithTrack = EMPLOYEES.filter((e) => e.track);
  const [employeeName, setEmployeeName] = useState(employeesWithTrack[0]?.name);
  const employee = EMPLOYEES.find((e) => e.name === employeeName) || employeesWithTrack[0];
  const track = CAREER_TRACKS.find((t) => t.id === employee?.track);
  const rungs = track ? [...track.rungs].sort((a, b) => b.level - a.level) : [];
  const occupants = (lvl) => EMPLOYEES.filter((e) => e.track === employee?.track && e.level === lvl);

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="أساس ترشيح الموظفين للوظائف الشاغرة" title="المسارات الوظيفية">
        <div className="relative">
          <select value={employeeName} onChange={(e) => setEmployeeName(e.target.value)} className="appearance-none bg-white border border-black/10 rounded-xl pl-9 pr-4 py-2 text-sm font-semibold">
            {employeesWithTrack.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
          <ChevronDown size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#808285]" />
        </div>
      </SectionTitle>
      {track ? (
        <p className="text-xs text-[#808285] -mt-4">
          مسار <span className="font-bold" style={{ color: BRAND.purple }}>{employee.name}</span> الوظيفي — {track.name}
          (نسخة تمثيلية مبسطة من ملف المسارات الوظيفية المعتمد؛ الملف الأصلي يشمل 22 مساراً).
        </p>
      ) : (
        <p className="text-xs text-[#808285] -mt-4">لا يوجد مسار وظيفي محدد لهذا الموظف (المسارات الوظيفية تُطبَّق حالياً على الفئات غير الأكاديمية).</p>
      )}

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <div className="space-y-2">
          {rungs.map((r, i) => {
            const occ = occupants(r.level);
            const isMine = employee?.level === r.level;
            return (
              <div key={r.level} className="flex items-center gap-3">
                <div className="w-10 shrink-0 text-center">
                  <span className="text-[10px] font-extrabold px-2 py-1 rounded-full" style={{ background: "#662D9114", color: BRAND.purple }}>{r.level}</span>
                </div>
                <div className="flex-1 rounded-xl border px-4 py-3 flex items-center justify-between" style={{ background: isMine ? "#662D910D" : BRAND.bg, borderColor: isMine ? BRAND.purple : "rgba(0,0,0,0.05)" }}>
                  <span className="text-xs font-bold" style={{ color: BRAND.dark }}>{r.title}</span>
                  {occ.length > 0 && <span className="text-[11px] text-[#808285]">{occ.map((o) => o.name).join("، ")}</span>}
                </div>
                {i < rungs.length - 1 && <div className="w-10" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================= التبويب: الوظائف الشاغرة ============================= */

function VacanciesTab({ criteria, conditions }) {
  const [vacancies, setVacancies] = useState(VACANCIES);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ title: "", level: 8, dept: ORG_UNITS[0], track: CAREER_TRACKS[0].id });
  const [showTopCandidates, setShowTopCandidates] = useState(null);
  const topCandidates = getPromotionCandidates().map((e) => ({ ...e, composite: compositeScore(e, criteria) })).sort((a, b) => b.composite - a.composite);

  const eligibleFor = (v) => EMPLOYEES
    .filter((e) => e.track === v.track && e.level === v.level - 1 && promotionEligible(e))
    .map((e) => ({ ...e, composite: compositeScore(e, criteria) }))
    .sort((a, b) => b.composite - a.composite);

  const addVacancy = () => {
    if (!form.title.trim()) return;
    setVacancies((v) => [...v, { id: Date.now(), ...form, level: Number(form.level) }]);
    setForm({ title: "", level: 8, dept: ORG_UNITS[0], track: CAREER_TRACKS[0].id });
    setShowAdd(false);
  };
  const removeVacancy = (id) => setVacancies((v) => v.filter((x) => x.id !== id));

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="ترشيح آلي وفق معايير الترقية" title="الوظائف الشاغرة">
        <button onClick={() => setShowAdd((s) => !s)} className="flex items-center gap-1.5 text-xs font-bold text-white rounded-xl px-3.5 py-2" style={{ background: BRAND.purple }}>
          <Plus size={14} /> إضافة وظيفة شاغرة
        </button>
      </SectionTitle>
      <p className="text-xs text-[#808285] -mt-4">
        الترشيح آلي بالكامل: يُطبَّق تلقائياً على كل موظفي الجامعة شروط ومعايير الترقية المعتمدة في تبويب "محرك الترقيات والمكافآت"
        (نفس القواعد المستخدمة هناك) — وإضافة الشواغر متاحة لمن يملك صلاحية "إعداد" أو "اعتماد" على مجال "الوظائف الشاغرة".
      </p>

      {showAdd && (
        <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm grid sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          <input placeholder="المسمى الوظيفي للشاغر" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="lg:col-span-2 rounded-lg border border-black/10 px-3 py-2 text-xs focus:outline-none" />
          <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} className="rounded-lg border border-black/10 px-3 py-2 text-xs">
            {CAREER_LEVELS.map((l) => <option key={l.level} value={l.level}>مستوى {l.level} — {l.title}</option>)}
          </select>
          <select value={form.dept} onChange={(e) => setForm({ ...form, dept: e.target.value })} className="rounded-lg border border-black/10 px-3 py-2 text-xs">
            {ORG_UNITS.map((u) => <option key={u}>{u}</option>)}
          </select>
          <select value={form.track} onChange={(e) => setForm({ ...form, track: e.target.value })} className="rounded-lg border border-black/10 px-3 py-2 text-xs">
            {CAREER_TRACKS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button onClick={addVacancy} className="lg:col-span-5 rounded-lg text-xs font-bold text-white py-2" style={{ background: BRAND.cyanDark }}>حفظ الشاغر</button>
        </div>
      )}

      <div className="space-y-4">
        {vacancies.map((v) => {
          const candidates = eligibleFor(v);
          return (
            <div key={v.id} className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <div>
                  <h3 className="font-bold text-sm" style={{ color: BRAND.dark }}>{v.title}</h3>
                  <p className="text-[11px] text-[#808285]">{v.dept} — المستوى {v.level} — المسار: {CAREER_TRACKS.find((t) => t.id === v.track)?.name}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowTopCandidates(showTopCandidates === v.id ? null : v.id)} className="text-[11px] font-bold px-3 py-1.5 rounded-full border border-black/10" style={{ color: BRAND.purple }}>
                    <Star size={12} className="inline-block ml-1" /> أبرز الموظفين المرشحين
                  </button>
                  <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-600">شاغرة</span>
                  <button onClick={() => removeVacancy(v.id)}><Trash2 size={14} color={BRAND.gray} /></button>
                </div>
              </div>

              {showTopCandidates === v.id && (
                <div className="mb-4 rounded-xl border border-black/5 p-3.5" style={{ background: "#662D9108" }}>
                  <p className="text-[10.5px] text-[#808285] mb-2">من صفحة الترقيات (بغض النظر عن مسار هذا الشاغر بالتحديد) — الأعلى درجة مركبة أولاً:</p>
                  {topCandidates.length === 0 ? (
                    <p className="text-xs text-[#808285]">لا يوجد مرشحون مستوفون لمعايير الترقية حالياً.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {topCandidates.slice(0, 5).map((c, i) => (
                        <div key={c.name} className="flex items-center justify-between text-xs">
                          <span className="font-semibold flex items-center gap-1" style={{ color: BRAND.dark }}>
                            {i === 0 && <Star size={11} color={BRAND.purple} />} {c.name}
                          </span>
                          <span className="text-[#808285]">{levelTitle(c.level)} — الدرجة المركبة {c.composite.toFixed(1)} — أقدمية {c.tenureYears} سنوات</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {candidates.length === 0 ? (
                <p className="text-xs text-[#808285]">لا يوجد مرشحون مستوفون للمعايير حالياً ضمن العينة التجريبية.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-right text-[#808285] border-b border-black/5">
                      <th className="py-2 font-semibold">المرشح</th>
                      <th className="py-2 font-semibold">المسمى الحالي</th>
                      <th className="py-2 font-semibold">الدرجة المركبة</th>
                      <th className="py-2 font-semibold">الأداء</th>
                      <th className="py-2 font-semibold">الإمكانات</th>
                      <th className="py-2 font-semibold">الأقدمية</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c, i) => (
                      <tr key={c.name} className="border-b border-black/5 last:border-0">
                        <td className="py-2 font-semibold flex items-center gap-1.5" style={{ color: BRAND.dark }}>
                          {i === 0 && <Star size={12} color={BRAND.purple} />} {c.name}
                        </td>
                        <td className="py-2 text-[#808285]">{levelTitle(c.level)}</td>
                        <td className="py-2 font-bold" style={{ color: BRAND.purple }}>{c.composite.toFixed(1)}</td>
                        <td className="py-2">{c.performance}%</td>
                        <td className="py-2">{c.potential}%</td>
                        <td className="py-2">{c.tenureYears} سنوات</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================= التبويب: تقييم الأداء (الرئيس المباشر) ============================= */

function PerformanceEvaluationTab({ templates, individual, goalsLib, framework, routineTasks, currentManager }) {
  const [sub, setSub] = useState("goals");
  const familyIdByName = (name) => JOB_FAMILIES.find((f) => f.name === name)?.id;
  const flatSubGoals = goalsLib.flatMap((g) => g.subGoals.map((sg) => ({ ...sg, goalId: g.id, goalName: g.name })));
  const myReports = EMPLOYEES.filter((e) => e.manager === currentManager);
  const [employeeName, setEmployeeName] = useState(myReports[0]?.name);
  const employee = EMPLOYEES.find((e) => e.name === employeeName && e.manager === currentManager) || myReports[0];

  const empFamilyId = employee ? familyIdByName(employee.family) : null;
  const baseAssignment = employee ? (individual[employee.name] || templates[empFamilyId] || emptyAssignment()) : emptyAssignment();

  const [achievements, setAchievements] = useState({});
  const [observedLevels, setObservedLevels] = useState({});

  const goalScore = (g) => {
    const sg = flatSubGoals.find((s) => s.id === g.subGoalId);
    const ach = achievements[`g_${g.subGoalId}`] ?? 0;
    return { sg, ach, score: (g.weight * ach) / 100 };
  };
  const taskScore = (t) => {
    const ach = achievements[`t_${t.taskId}`] ?? 0;
    return { ach, score: (t.weight * ach) / 100 };
  };
  const compScore = (c) => {
    const obs = observedLevels[c.name] ?? c.level;
    return { obs, score: c.weight * ((obs + 1) / 4) };
  };

  const totalGoals = baseAssignment.goals.reduce((a, g) => a + goalScore(g).score, 0);
  const totalTasks = baseAssignment.tasks.reduce((a, t) => a + taskScore(t).score, 0);
  const totalComp = baseAssignment.competencies.reduce((a, c) => a + compScore(c).score, 0);
  const finalScore = totalGoals + totalTasks + totalComp;
  const matchedBand = [...RATING_BANDS].find((b) => {
    if (b.key === "excellent") return finalScore >= 90;
    if (b.key === "veryGood") return finalScore >= 80;
    if (b.key === "good") return finalScore >= 70;
    if (b.key === "fair") return finalScore >= 60;
    return true;
  });

  const SUBS = [
    { id: "goals", label: "الأهداف والمهام اليومية" },
    { id: "competencies", label: "الجدارات (Rubric)" },
    { id: "360", label: "تقييم 360 درجة" },
  ];

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow={`مسجّل الدخول: ${currentManager}`} title="تقييم الأداء">
        {employee && (
          <div className="relative">
            <select value={employee.name} onChange={(e) => setEmployeeName(e.target.value)} className="appearance-none bg-white border border-black/10 rounded-xl pl-9 pr-4 py-2 text-sm font-semibold">
              {myReports.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
            </select>
            <ChevronDown size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#808285]" />
          </div>
        )}
      </SectionTitle>

      {!employee ? (
        <div className="bg-white rounded-2xl border border-black/5 p-8 text-center text-xs text-[#808285]">
          لا يوجد موظفون تابعون لهذا المدير في العينة التجريبية.
        </div>
      ) : (
      <>
      <div className="flex gap-2 flex-wrap">
        {SUBS.map((s) => (
          <button
            key={s.id} onClick={() => setSub(s.id)}
            className="text-xs font-bold px-4 py-2 rounded-xl transition-colors"
            style={sub === s.id ? { background: BRAND.purple, color: "#fff" } : { background: "#fff", color: BRAND.gray, border: "1px solid #eee" }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {sub === "goals" && (
        <>
          <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
            <h3 className="font-bold text-sm mb-3" style={{ color: BRAND.dark }}>الأهداف الاستراتيجية</h3>
            <div className="space-y-2">
              {baseAssignment.goals.length === 0 && <p className="text-xs text-[#808285]">لا توجد أهداف مُسندة لهذا الموظف — راجع شاشة إسناد الأهداف والجدارات.</p>}
              {baseAssignment.goals.map((g) => {
                const { sg, ach } = goalScore(g);
                return (
                  <div key={g.subGoalId} className="rounded-lg border border-black/5 px-3.5 py-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold" style={{ color: BRAND.dark }}>{sg?.name}</span>
                      <span className="text-[11px] text-[#808285]">وزن {g.weight}%</span>
                    </div>
                    <p className="text-[10.5px] text-[#808285] mb-2">{sg?.goalName} — العام الحالي: {sg?.targetYear} — نهاية الخطة: {sg?.targetPlan}</p>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[#808285]">نسبة الإنجاز الفعلي</span>
                      <input type="number" min={0} max={150} value={ach} onChange={(e) => setAchievements((a) => ({ ...a, [`g_${g.subGoalId}`]: Number(e.target.value) }))}
                        className="w-20 text-center text-xs border border-black/10 rounded-md py-1" />
                      <span className="text-[11px] text-[#808285]">%</span>
                      <span className="mr-auto text-xs font-bold" style={{ color: BRAND.purple }}>الدرجة: {goalScore(g).score.toFixed(1)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
            <h3 className="font-bold text-sm mb-3" style={{ color: BRAND.dark }}>المهام اليومية (BAU)</h3>
            <div className="space-y-2">
              {baseAssignment.tasks.length === 0 && <p className="text-xs text-[#808285]">لا توجد مهام مُسندة لهذا الموظف.</p>}
              {baseAssignment.tasks.map((t) => {
                const rt = routineTasks.find((r) => r.id === t.taskId);
                const { ach } = taskScore(t);
                return (
                  <div key={t.taskId} className="rounded-lg border border-black/5 px-3.5 py-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold" style={{ color: BRAND.dark }}>{rt?.name}</span>
                      <span className="text-[11px] text-[#808285]">وزن {t.weight}%</span>
                    </div>
                    <p className="text-[10.5px] text-[#808285] mb-2">مؤشر الأداء: {rt?.kpi || "—"}</p>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[#808285]">نسبة الإنجاز الفعلي</span>
                      <input type="number" min={0} max={150} value={ach} onChange={(e) => setAchievements((a) => ({ ...a, [`t_${t.taskId}`]: Number(e.target.value) }))}
                        className="w-20 text-center text-xs border border-black/10 rounded-md py-1" />
                      <span className="text-[11px] text-[#808285]">%</span>
                      <span className="mr-auto text-xs font-bold" style={{ color: BRAND.purple }}>الدرجة: {taskScore(t).score.toFixed(1)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {sub === "competencies" && (
        <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
          <h3 className="font-bold text-sm mb-4" style={{ color: BRAND.dark }}>تقييم الجدارات وفق مستويات السلوك (Rubric)</h3>
          {baseAssignment.competencies.length === 0 ? (
            <p className="text-xs text-[#808285]">لا توجد جدارات مُسندة لهذا الموظف — راجع شاشة إسناد الأهداف والجدارات.</p>
          ) : (
            <div className="space-y-5">
              {baseAssignment.competencies.map((c) => {
                const full = framework.flatMap((g) => g.items).find((x) => x.name === c.name);
                const obs = observedLevels[c.name] ?? c.level;
                return (
                  <div key={c.name} className="border-b border-black/5 pb-5 last:border-0">
                    <div className="flex items-center justify-between mb-1.5 flex-wrap gap-1">
                      <h4 className="text-sm font-bold" style={{ color: BRAND.dark }}>{c.name}</h4>
                      <span className="text-[11px] text-[#808285]">الوزن {c.weight}% — المطلوب: {COMPETENCY_LEVEL_LABELS[c.level]}</span>
                    </div>
                    {full && <p className="text-xs leading-6 text-[#808285] mb-3">{full.def}</p>}
                    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                      {(full?.levels || []).map((lvl, li) => (
                        <button
                          key={li} onClick={() => setObservedLevels((o) => ({ ...o, [c.name]: li }))}
                          className="text-right rounded-xl border p-3 transition-colors"
                          style={{ borderColor: obs === li ? BRAND.purple : "#eee", background: obs === li ? "#662D9108" : BRAND.bg }}
                        >
                          <div className="text-[11px] font-extrabold mb-1.5" style={{ color: obs === li ? BRAND.purple : BRAND.gray }}>{COMPETENCY_LEVEL_LABELS[li]}</div>
                          <p className="text-[11px] leading-5" style={{ color: BRAND.dark }}>{lvl}</p>
                        </button>
                      ))}
                    </div>
                    <div className="text-xs font-bold text-left" style={{ color: BRAND.purple }}>الدرجة المحتسبة: {compScore(c).score.toFixed(1)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {sub === "360" && (
        <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
          <h3 className="font-bold text-sm mb-1" style={{ color: BRAND.dark }}>تقييم 360 درجة (تكميلي)</h3>
          <p className="text-[11px] text-[#808285] mb-4">آلية تغذية راجعة إضافية من عدة مصادر — لا تدخل في احتساب الدرجة النهائية أدناه، وتُستخدم كمرجع تطويري.</p>
          <Evaluation360Panel />
        </div>
      )}

      <div className="rounded-2xl p-5 flex items-center justify-between flex-wrap gap-3" style={{ background: "#662D9110", border: "1px solid #662D9122" }}>
        <div>
          <div className="text-xs font-bold" style={{ color: BRAND.purple }}>الدرجة النهائية المحتسبة</div>
          <div className="text-[11px] text-[#808285]">استراتيجي {totalGoals.toFixed(1)} + BAU {totalTasks.toFixed(1)} + جدارات {totalComp.toFixed(1)}</div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-extrabold" style={{ color: BRAND.purple }}>{finalScore.toFixed(1)}</span>
          {matchedBand && <span className="text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: `${matchedBand.color}22`, color: matchedBand.color }}>{matchedBand.label}</span>}
        </div>
      </div>
      </>
      )}
    </div>
  );
}

/* ============================= التبويب: ميزانية المكافآت ============================= */

const BAND_WEIGHT = { excellent: 1.5, veryGood: 1.0, good: 0.5, fair: 0, unsatisfactory: 0 };

function computeDeptBonusTable(unit, totalBudget) {
  const deptBudget = totalBudget * (unit.count / TOTAL_STAFF);
  const bandRows = RATING_BANDS.map((b) => {
    const count = Math.round((unit.count * INITIAL_ACTUAL[b.key]) / 100);
    return { ...b, count, weight: BAND_WEIGHT[b.key] };
  });
  const sumWeighted = bandRows.reduce((a, r) => a + r.weight * r.count, 0);
  return { deptBudget, enriched: bandRows.map((r) => {
    const perEmployee = sumWeighted > 0 ? (deptBudget * r.weight) / sumWeighted : 0;
    return { ...r, perEmployee, pool: perEmployee * r.count };
  }) };
}

function computeEmployeeBonus(e, totalBudget) {
  const unit = ORG_UNIT_STAFF.find((u) => u.name === e.dept);
  if (!unit) return { band: bandForScore(e.score), amount: 0 };
  const { enriched } = computeDeptBonusTable(unit, totalBudget);
  const band = bandForScore(e.score);
  const bandRow = enriched.find((r) => r.key === band.key);
  const withinBand = (e.score - band.min) / Math.max(1, band.max - band.min);
  const amount = (bandRow?.perEmployee || 0) * (0.85 + 0.3 * withinBand);
  return { band, amount };
}

function RewardsPanel() {
  const [totalBudget, setTotalBudget] = useState(5000000);
  const [deptName, setDeptName] = useState(ORG_UNIT_STAFF[0].name);

  const unit = ORG_UNIT_STAFF.find((u) => u.name === deptName);
  const { deptBudget, enriched } = computeDeptBonusTable(unit, totalBudget);
  const deptEmployeeList = EMPLOYEES.filter((e) => e.dept === deptName);

  const exportRows = EMPLOYEES.map((e) => {
    const { band, amount } = computeEmployeeBonus(e, totalBudget);
    return { name: e.name, dept: e.dept, score: e.score, band: band.label, amount: Math.round(amount) };
  });

  return (
    <div className="space-y-6">
      <div className="rounded-2xl p-5" style={{ background: "#662D9110", border: "1px solid #662D9122" }}>
        <h3 className="font-bold text-sm mb-2 flex items-center gap-2" style={{ color: BRAND.purple }}>
          <Sparkles size={16} /> كيف تُترجم نتيجة التقييم إلى مكافأة فعلية؟
        </h3>
        <p className="text-xs leading-6" style={{ color: BRAND.dark }}>
          بدلاً من تطبيق نسبة المكافأة الثابتة لكل شريحة على راتب كل موظف بشكل منفصل، يُعتمد <b>نموذج الميزانية المخصصة (Bonus Pool)</b>:
          تُحدد الجامعة ميزانية سنوية للمكافآت كنسبة من إجمالي الرواتب الأساسية لكل جهة، ثم توزَّع هذه الميزانية داخلياً على شرائح التقييم
          بعد التسوية (Bell Curve) — بحيث تعكس نسبة المكافأة الفعلية أداء الموظف <b>نسبياً داخل فئته الوظيفية</b> وليس فقط الشريحة المطلقة،
          مع إمكانية إضافة معامل بسيط للأقدمية أو الأثر الاستراتيجي للهدف المُنجز عند تقارب الدرجات بين موظفين. هذا يمنع تجاوز الميزانية
          المعتمدة عند حدوث تساهل في التقييمات، ويحافظ على العدالة النسبية بين الجهات ذات الأحجام المختلفة.
        </p>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-[#808285] flex-1">أدخل الميزانية المعتمدة، ويحتسب النظام مكافأة كل موظف مستحق آلياً وفق خوارزمية المنصة.</p>
        <ExportButton
          filename="مكافآت_الموظفين" deptField="dept" rows={exportRows}
          columns={[
            { key: "name", label: "الموظف" }, { key: "dept", label: "الجهة" }, { key: "score", label: "الدرجة" },
            { key: "band", label: "الشريحة" }, { key: "amount", label: "المكافأة المحتسبة (ر.س)" },
          ]}
        />
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-bold" style={{ color: BRAND.dark }}>الميزانية السنوية الإجمالية المعتمدة للمكافآت (ر.س)</label>
            <input type="number" value={totalBudget} onChange={(e) => setTotalBudget(Number(e.target.value))}
              className="w-full mt-1.5 rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none" />
            <p className="text-[11px] text-[#808285] mt-1.5">تُوزَّع تلقائياً على الجهات بالتناسب مع عدد المنسوبين ({TOTAL_STAFF} إجمالاً).</p>
          </div>
          <div>
            <label className="text-xs font-bold" style={{ color: BRAND.dark }}>عرض تفاصيل جهة</label>
            <div className="relative mt-1.5">
              <select value={deptName} onChange={(e) => setDeptName(e.target.value)} className="w-full appearance-none rounded-lg border border-black/10 px-3 py-2 text-sm">
                {ORG_UNIT_STAFF.map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}
              </select>
              <ChevronDown size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[#808285]" />
            </div>
          </div>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <KpiCard label="عدد منسوبي الجهة" value={unit.count} icon={Users2} />
        <KpiCard label="ميزانية الجهة المخصصة" value={Math.round(deptBudget).toLocaleString("en-US")} icon={Wallet} />
        <KpiCard label="متوسط المكافأة للفرد" value={Math.round(deptBudget / unit.count).toLocaleString("en-US")} icon={Award} />
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm overflow-x-auto">
        <h3 className="font-bold text-sm mb-4" style={{ color: BRAND.dark }}>توزيع الميزانية على شرائح التقييم — {deptName}</h3>
        <table className="w-full text-xs min-w-[680px]">
          <thead>
            <tr className="text-right text-[#808285] border-b border-black/5">
              <th className="py-2 font-semibold">الشريحة</th>
              <th className="py-2 font-semibold">عدد الموظفين (بعد التسوية)</th>
              <th className="py-2 font-semibold">وزن الشريحة النسبي</th>
              <th className="py-2 font-semibold">حصة الشريحة من الميزانية</th>
              <th className="py-2 font-semibold">متوسط الفرد</th>
            </tr>
          </thead>
          <tbody>
            {enriched.map((r) => (
              <tr key={r.key} className="border-b border-black/5 last:border-0">
                <td className="py-2.5 font-bold" style={{ color: r.color }}>{r.label}</td>
                <td className="py-2.5">{r.count}</td>
                <td className="py-2.5">{r.weight}×</td>
                <td className="py-2.5 font-bold" style={{ color: BRAND.dark }}>{Math.round(r.pool).toLocaleString("en-US")} ر.س</td>
                <td className="py-2.5">{Math.round(r.perEmployee).toLocaleString("en-US")} ر.س</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-[#808285] mt-3">
          يُحسب متوسط الفرد بقسمة حصة الشريحة على عدد موظفيها، بحيث يبقى إجمالي المصروف مطابقاً تماماً لميزانية الجهة المعتمدة
          مهما كان توزيع التقييمات بعد التسوية.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 shadow-sm overflow-x-auto">
        <h3 className="font-bold text-sm mb-1" style={{ color: BRAND.dark }}>مكافآت الموظفين المستحقين — {deptName}</h3>
        <p className="text-[11px] text-[#808285] mb-4">
          محتسبة آلياً بخوارزمية المنصة: شريحة التقييم تحدد متوسط الشريحة، ثم يُعدَّل المبلغ حسب موقع درجة الموظف داخل مدى شريحته.
        </p>
        {deptEmployeeList.length === 0 ? (
          <p className="text-xs text-[#808285]">لا يوجد موظفون في العينة التجريبية لهذه الجهة.</p>
        ) : (
          <table className="w-full text-xs min-w-[620px]">
            <thead>
              <tr className="text-right text-[#808285] border-b border-black/5">
                <th className="py-2 font-semibold">الموظف</th>
                <th className="py-2 font-semibold">الدرجة</th>
                <th className="py-2 font-semibold">الشريحة</th>
                <th className="py-2 font-semibold">المكافأة المحتسبة</th>
              </tr>
            </thead>
            <tbody>
              {deptEmployeeList.map((e) => {
                const { band, amount } = computeEmployeeBonus(e, totalBudget);
                return (
                  <tr key={e.name} className="border-b border-black/5 last:border-0">
                    <td className="py-2.5 font-semibold" style={{ color: BRAND.dark }}>{e.name}</td>
                    <td className="py-2.5">{e.score}</td>
                    <td className="py-2.5"><span className="font-bold" style={{ color: band.color }}>{band.label}</span></td>
                    <td className="py-2.5 font-bold" style={{ color: BRAND.purple }}>{Math.round(amount).toLocaleString("en-US")} ر.س</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ============================= الصفحة الموحّدة: الترقيات والمكافآت ============================= */

const DEFAULT_PROMOTION_CRITERIA = [
  { id: 1, name: "نتيجة تقييم الأداء", weight: 50 },
  { id: 2, name: "الإمكانات المستقبلية (9-Box)", weight: 30 },
  { id: 3, name: "الأقدمية النسبية", weight: 20 },
];
const DEFAULT_PROMOTION_CONDITIONS = [
  { id: 1, name: "ألا تقل مدة الخدمة عن سنتين" },
  { id: 2, name: "وجود شاغر وظيفي مناسب ضمن المسار الوظيفي" },
];

function PromotionsRewardsTab({ criteria, setCriteria, conditions, setConditions }) {
  const [sub, setSub] = useState("engine");
  const SUBS = [
    { id: "engine", label: "محرك الترقيات والمكافآت" },
    { id: "promotions", label: "الترقيات" },
    { id: "rewards", label: "المكافآت" },
  ];
  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="ربط مخرجات التقييم بالترقيات والمكافآت والمسار الوظيفي" title="الترقيات والمكافآت">
        <div className="flex gap-2 flex-wrap">
          {SUBS.map((s) => (
            <button
              key={s.id} onClick={() => setSub(s.id)}
              className="text-xs font-bold px-4 py-2 rounded-xl"
              style={sub === s.id ? { background: BRAND.purple, color: "#fff" } : { background: "#fff", color: BRAND.gray, border: "1px solid #eee" }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </SectionTitle>
      {sub === "engine" && <EnginePanel criteria={criteria} setCriteria={setCriteria} conditions={conditions} setConditions={setConditions} />}
      {sub === "promotions" && <PromotionsPanel criteria={criteria} conditions={conditions} />}
      {sub === "rewards" && <RewardsPanel />}
    </div>
  );
}

/* ============================= التطبيق الرئيسي ============================= */

export default function HRPerformanceDashboard() {
  const [tab, setTab] = useState("overview");
  const [dept, setDept] = useState("كل الجهات");
  const [menuOpen, setMenuOpen] = useState(false);
  const activeNav = useMemo(() => NAV.find((n) => n.id === tab), [tab]);

  const [templates, setTemplates] = useState(() => {
    const init = {};
    JOB_FAMILIES.forEach((f) => { init[f.id] = DEFAULT_ASSIGNMENTS[f.id] ? JSON.parse(JSON.stringify(DEFAULT_ASSIGNMENTS[f.id])) : emptyAssignment(); });
    return init;
  });
  const [individual, setIndividual] = useState({});

  const [goalsLib, setGoalsLib] = useState(STRATEGIC_GOALS);
  const [compFramework, setCompFramework] = useState(COMPETENCY_FRAMEWORK);
  const [routineTasks, setRoutineTasks] = useState(ROUTINE_TASKS);
  const [currentManager, setCurrentManager] = useState(MANAGERS[0]);
  const [familyWeights, setFamilyWeights] = useState(() => Object.fromEntries(JOB_FAMILIES.map((f) => [f.id, { strategic: f.strategic, bau: f.bau, competency: f.competency }])));
  const [promotionCriteria, setPromotionCriteria] = useState(DEFAULT_PROMOTION_CRITERIA);
  const [promotionConditions, setPromotionConditions] = useState(DEFAULT_PROMOTION_CONDITIONS);

  return (
    <div dir="rtl" className="min-h-screen w-full" style={{ background: BRAND.bg, fontFamily: "'Cairo', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&display=swap');
        input[type=number]::-webkit-inner-spin-button { opacity: 1; }
      `}</style>

      <div className="flex">
        {/* ===== الشريط الجانبي (ديسكتوب) ===== */}
        <aside className="hidden md:flex md:w-64 shrink-0 min-h-screen flex-col border-l border-black/5 bg-white">
          <div className="p-5 flex items-center gap-3 border-b border-black/5">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-extrabold text-sm"
              style={{ background: `linear-gradient(135deg, ${BRAND.cyan}, ${BRAND.purple})` }}>
              SRU
            </div>
            <div>
              <div className="text-sm font-extrabold" style={{ color: BRAND.dark }}>جامعة سليمان الراجحي</div>
              <div className="text-[11px] text-[#808285]">نظام تقييم الأداء — الموارد البشرية</div>
            </div>
          </div>
          <nav className="p-3 flex-1 space-y-1">
            {NAV.map((n) => {
              const Icon = n.icon;
              const active = tab === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setTab(n.id)}
                  className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                  style={active ? { background: "#662D9112", color: BRAND.purple } : { color: BRAND.gray }}
                >
                  <Icon size={17} />
                  {n.label}
                </button>
              );
            })}
          </nav>
          <div className="p-4 m-3 rounded-xl flex items-start gap-2" style={{ background: "#29ABE212" }}>
            <ShieldCheck size={16} color={BRAND.cyanDark} className="mt-0.5 shrink-0" />
            <p className="text-[11px] leading-5" style={{ color: BRAND.cyanDark }}>
              دورة التقييم الحالية في مرحلة التسوية النهائية (Calibration) قبل اعتماد اللجنة العليا.
            </p>
          </div>
        </aside>

        {/* ===== قائمة الجوال ===== */}
        {menuOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/30" onClick={() => setMenuOpen(false)} />
            <div className="absolute top-0 right-0 h-full w-72 bg-white p-4 flex flex-col gap-1 shadow-xl">
              <div className="flex items-center justify-between mb-3">
                <span className="font-extrabold text-sm" style={{ color: BRAND.dark }}>القائمة</span>
                <button onClick={() => setMenuOpen(false)}><X size={20} color={BRAND.gray} /></button>
              </div>
              {NAV.map((n) => {
                const Icon = n.icon;
                const active = tab === n.id;
                return (
                  <button
                    key={n.id}
                    onClick={() => { setTab(n.id); setMenuOpen(false); }}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold"
                    style={active ? { background: "#662D9112", color: BRAND.purple } : { color: BRAND.gray }}
                  >
                    <Icon size={17} /> {n.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ===== المحتوى ===== */}
        <main className="flex-1 min-w-0">
          {/* الشريط العلوي */}
          <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-black/5 px-4 md:px-7 py-3 flex items-center gap-3">
            <button className="md:hidden" onClick={() => setMenuOpen(true)}>
              <Menu size={22} color={BRAND.dark} />
            </button>
            <div className="hidden sm:flex items-center gap-2 bg-black/[0.03] rounded-xl px-3 py-2 w-full max-w-xs">
              <Search size={15} color={BRAND.gray} />
              <input placeholder="ابحث عن موظف أو إدارة..." className="bg-transparent text-sm w-full focus:outline-none placeholder:text-[#808285]" />
            </div>
            <div className="mr-auto flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-1.5 bg-black/[0.03] rounded-xl px-3 py-2">
                <span className="text-[11px] text-[#808285]">تسجيل الدخول كـ</span>
                <select value={currentManager} onChange={(e) => setCurrentManager(e.target.value)} className="bg-transparent text-xs font-bold focus:outline-none" style={{ color: BRAND.purple }}>
                  {MANAGERS.map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <button className="relative w-9 h-9 rounded-xl flex items-center justify-center bg-black/[0.03]">
                <Bell size={16} color={BRAND.dark} />
                <span className="absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full bg-red-500 border-2 border-white" />
              </button>
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold" style={{ background: BRAND.purple }}>
                {currentManager[0]}
              </div>
            </div>
          </header>

          <div className="p-4 md:p-7 max-w-[1300px] mx-auto">
            {tab === "overview" && <OverviewTab dept={dept} setDept={setDept} />}
            {tab === "curve" && <CurveTab />}
            {tab === "families" && <FamiliesTab />}
            {tab === "evaluationSources" && <EvaluationSourcesTab goals={goalsLib} setGoals={setGoalsLib} framework={compFramework} setFramework={setCompFramework} tasks={routineTasks} setTasks={setRoutineTasks} />}
            {tab === "assignment" && <AssignmentTab templates={templates} setTemplates={setTemplates} individual={individual} setIndividual={setIndividual} goalsLib={goalsLib} framework={compFramework} routineTasks={routineTasks} currentManager={currentManager} familyWeights={familyWeights} setFamilyWeights={setFamilyWeights} />}
            {tab === "evaluation" && <PerformanceEvaluationTab templates={templates} individual={individual} goalsLib={goalsLib} framework={compFramework} routineTasks={routineTasks} currentManager={currentManager} />}
            {tab === "careerPaths" && <CareerPathsTab />}
            {tab === "vacancies" && <VacanciesTab criteria={promotionCriteria} conditions={promotionConditions} />}
            {tab === "rewards" && <PromotionsRewardsTab criteria={promotionCriteria} setCriteria={setPromotionCriteria} conditions={promotionConditions} setConditions={setPromotionConditions} />}
            {tab === "permissions" && <PermissionsTab />}
          </div>

          {/* شريط تنقل سفلي — جوال */}
          <div className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-black/5 py-2 z-30 overflow-x-auto">
            <div className="flex gap-1 px-2 min-w-max">
              {NAV.map((n) => {
                const Icon = n.icon;
                const active = tab === n.id;
                return (
                  <button key={n.id} onClick={() => setTab(n.id)} className="flex flex-col items-center gap-0.5 px-3 py-1 shrink-0">
                    <Icon size={18} color={active ? BRAND.purple : BRAND.gray} />
                    <span className="text-[9.5px] font-semibold whitespace-nowrap" style={{ color: active ? BRAND.purple : BRAND.gray }}>{n.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="h-16 md:hidden" />
        </main>
      </div>
    </div>
  );
}
