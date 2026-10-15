import { describe, expect, it } from "vitest";
import { mergeStaff, parseCsv, parseOoxmlSheet } from "./lib.mjs";

describe("parseCsv", () => {
  it("handles BOM, quotes and CRLF", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","q""q"\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'q"q'],
    ]);
  });
});

describe("parseOoxmlSheet", () => {
  it("reads shared strings and inline values from an x:-prefixed sheet with the header on row 2", () => {
    const parts: Record<string, string> = {
      "xl/sharedStrings.xml":
        '<x:sst xmlns:x="u"><x:si><x:t>NO</x:t></x:si><x:si><x:t>الاسم</x:t></x:si><x:si><x:t>أحمد</x:t></x:si></x:sst>',
      "xl/worksheets/sheet1.xml":
        '<x:worksheet xmlns:x="u"><x:sheetData><x:row r="1"><x:c r="A1" s="1" /></x:row><x:row r="2"><x:c r="A2" t="s"><x:v>0</x:v></x:c><x:c r="B2" t="s"><x:v>1</x:v></x:c></x:row><x:row r="3"><x:c r="A3"><x:v>24359</x:v></x:c><x:c r="B3" t="s"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    };
    expect(parseOoxmlSheet((n: string) => parts[n], { headerRow: 2 })).toEqual({ header: ["NO", "الاسم"], rows: [["24359", "أحمد"]] });
  });
});

const dir = (...r: string[][]) => [["الاسم", "البريد", "الإدارة", "المسمّى", "التحويلة", "الفئة", "الرقم الوظيفي", "الحالة"], ...r];
const hr = (...r: string[][]) => ({
  header: ["UNIQUE EMPLOYEE NUMBER", "Worker Category", "Full Name", "الأسم بالعربي", "Line Manager", "اسم الوظيفة", "POSITION NAME", "DEPARTMENT NAME", "إسم القسم", "Sub- Department", "القسم الفرعي", "line manager UNIQUE EMPLOYEE NUMBER"],
  rows: r,
});

describe("mergeStaff", () => {
  it("joins by employee number: directory wins for identity, HR wins for supervisor and title", () => {
    const { rows, report } = mergeStaff({
      directoryRows: dir(
        ["أحمد", "a@sr.edu.sa", "كلية الطب", "طبيب", "7000", "Academic", "1", "أكّد"],
        ["صندوق", "dt@sr.edu.sa", "", "", "", "", "", "لم يؤكّد"]
      ),
      hrRows: hr(
        ["1", "Academic", "Ahmed", "احمد (HR)", "Boss", "أستاذ مساعد", "Asst Prof", "College of Medicine", "الطب", "", "", "2"],
        ["2", "Administrative", "Boss", "الرئيس", "", "رئيس", "President", "Office", "مكتب رئيس الجامعة", "", "", ""]
      ),
      aliases: { "مكتب رئيس الجامعة": "مكتب الرئيس" },
    });
    expect(rows).toEqual([
      { employeeNumber: "1", fullNameAr: "أحمد", fullNameEn: "Ahmed", email: "a@sr.edu.sa", department: "كلية الطب", positionAr: "أستاذ مساعد", category: "Academic", supervisorNumber: "2" },
      { employeeNumber: "2", fullNameAr: "الرئيس", fullNameEn: "Boss", email: null, department: "مكتب الرئيس", positionAr: "رئيس", category: "Administrative", supervisorNumber: null },
    ]);
    expect(report).toMatchObject({ total: 2, excludedNoNumber: 1, withoutEmail: 1, withoutSupervisor: 1, onlyInHr: 1, onlyInDirectory: 0, cycles: [] });
    expect(report.nameConflicts).toEqual(["1: الدليل «أحمد» / الموارد البشرية «احمد (HR)»"]);
  });

  it("lower-cases emails and reports cycles", () => {
    const { rows, report } = mergeStaff({
      directoryRows: dir(["x", "X@SR.EDU.SA", "", "", "", "", "1", ""]),
      hrRows: hr(["1", "", "", "", "", "", "", "", "", "", "", "2"], ["2", "", "", "", "", "", "", "", "", "", "", "1"]),
      aliases: {},
    });
    expect(rows[0].email).toBe("x@sr.edu.sa");
    expect([...report.cycles].sort()).toEqual(["1", "2"]);
  });
});
