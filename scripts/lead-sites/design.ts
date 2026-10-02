/** The dental preview selected by the owner: the daylit room at dental-care-plus.localhost. */
export const DENTAL_PREVIEW_DESIGN = "dental-room-r15";

export function assertPreviewDesign(vertical: string, html: string): void {
  if (vertical !== "dental") return;
  if (!html.includes("FlagshipOpening") || !html.includes("/img/generated/r15/lantern-room-wide.webp"))
    throw new Error("This dental preview doesn't use the selected Dental Care Plus flagship. Rebuild the dental template and regenerate the preview before deploying.");
}
