/**
 * Heading ranks on the course page (owner, 2026-11-14): attention follows rank.
 * - PAGE_HEAD heads a block the page is made of: Next up, Exam, Understanding, Reviews due, Skills, Sessions, a draft.
 * - SECTION_HEAD heads what sits inside a block: a group of skills under Skills, a group in the course settings.
 * The page title is above both; a skill's name is below both.
 *
 * Sentence case since 2026-11-16 (owner, tablet hierarchy pass): weight and size carry the rank, not capitals and
 * letter spacing. A count sits on the heading's line in HEAD_COUNT, lighter than the words.
 */
export const PAGE_HEAD = "pb-2 text-base font-semibold text-foreground";
export const SECTION_HEAD = "mb-2 text-[13px] font-medium text-muted-foreground";
/** A heading's count ("Skills 32"): on the same line, lighter and regular weight. */
export const HEAD_COUNT = "ml-2 font-normal tabular-nums text-muted-foreground/60";
