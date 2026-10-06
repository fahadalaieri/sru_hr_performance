import { describe, it, expect } from "vitest";
import { validateThreeSixtyResponseWrite, type ScaleOptionRef } from "./threeSixtyResponseValidation";
import type { ThreeSixtyItem } from "./threeSixty";

const ratingItem: ThreeSixtyItem = {
  id: "item-rating",
  itemCode: "C1-01",
  competencyId: "comp-1",
  itemType: "rating",
  raterGroups: ["peer"],
  required: true,
  reverseScored: false,
  scaleCode: "behavior_freq_5",
  displayOrder: 1,
  behavioralLevel: null,
};
const textItem: ThreeSixtyItem = { ...ratingItem, id: "item-text", itemCode: "OPEN-01", itemType: "open_text", scaleCode: null };

const options: ScaleOptionRef[] = [
  { id: "opt-3", scaleCode: "behavior_freq_5", numericValue: 3 },
  { id: "opt-other-scale", scaleCode: "agreement_4", numericValue: 4 },
];

describe("validateThreeSixtyResponseWrite", () => {
  it("rejects an item that does not apply to this assignment", () => {
    const r = validateThreeSixtyResponseWrite(undefined, options, { optionId: "opt-3" });
    expect(r).toEqual({ ok: false, reason: "item_not_applicable" });
  });

  it("derives numeric_value from the option, ignoring the client's number", () => {
    const r = validateThreeSixtyResponseWrite(ratingItem, options, { optionId: "opt-3", numericValue: 99 });
    expect(r).toEqual({ ok: true, patch: { option_id: "opt-3", numeric_value: 3, text_value: null } });
  });

  it("rejects an option that belongs to a different scale than the item", () => {
    const r = validateThreeSixtyResponseWrite(ratingItem, options, { optionId: "opt-other-scale" });
    expect(r).toEqual({ ok: false, reason: "option_not_in_scale" });
  });

  it("rejects an unknown option id", () => {
    const r = validateThreeSixtyResponseWrite(ratingItem, options, { optionId: "opt-missing" });
    expect(r).toEqual({ ok: false, reason: "option_not_in_scale" });
  });

  it("requires an option for a rating item", () => {
    const r = validateThreeSixtyResponseWrite(ratingItem, options, { numericValue: 3 });
    expect(r).toEqual({ ok: false, reason: "option_required" });
  });

  it("stores free text for an open-text item with no option or number", () => {
    const r = validateThreeSixtyResponseWrite(textItem, options, { textValue: "ملاحظة", numericValue: 5 });
    expect(r).toEqual({ ok: true, patch: { option_id: null, numeric_value: null, text_value: "ملاحظة" } });
  });

  it("rejects an option sent for an open-text item", () => {
    const r = validateThreeSixtyResponseWrite(textItem, options, { optionId: "opt-3" });
    expect(r).toEqual({ ok: false, reason: "option_not_allowed" });
  });
});
