import type { ThreeSixtyItem } from "@/lib/threeSixty";

/** The subset of `three_sixty_rating_scale_options` a validation needs. */
export interface ScaleOptionRef {
  id: string;
  scaleCode: string;
  numericValue: number;
}

/** What a rater's client is allowed to SEND; what gets STORED is derived below. */
export interface ThreeSixtyResponseWriteInput {
  optionId?: string;
  numericValue?: number;
  textValue?: string;
}

/** Exactly the three value columns of `three_sixty_responses`. */
export interface ThreeSixtyResponsePatch {
  option_id: string | null;
  numeric_value: number | null;
  text_value: string | null;
}

export type ThreeSixtyResponseValidation =
  | { ok: true; patch: ThreeSixtyResponsePatch }
  | { ok: false; reason: "item_not_applicable" | "option_required" | "option_not_in_scale" | "option_not_allowed" };

/**
 * Decides whether one answer may be written for one assignment, and what is
 * actually stored. `item` is the row from the assignment's own applicable
 * item list (the same resolver the survey page renders from) -- `undefined`
 * means the client named an item this rater was never shown. For a rating
 * item the option must belong to the item's own scale and the stored score
 * is the option's value, never the number the request carried; an open-text
 * item stores only its text. Mirrored in Postgres by
 * `validate_three_sixty_response()` (20261006000002).
 */
export function validateThreeSixtyResponseWrite(
  item: ThreeSixtyItem | undefined,
  options: ScaleOptionRef[],
  input: ThreeSixtyResponseWriteInput
): ThreeSixtyResponseValidation {
  if (!item) return { ok: false, reason: "item_not_applicable" };

  if (item.itemType === "open_text") {
    if (input.optionId) return { ok: false, reason: "option_not_allowed" };
    return { ok: true, patch: { option_id: null, numeric_value: null, text_value: input.textValue ?? null } };
  }

  if (!input.optionId) return { ok: false, reason: "option_required" };
  const option = options.find((o) => o.id === input.optionId);
  if (!option || option.scaleCode !== item.scaleCode) return { ok: false, reason: "option_not_in_scale" };
  return { ok: true, patch: { option_id: option.id, numeric_value: option.numericValue, text_value: null } };
}
