import { PropertyView } from "@/components/PropertyView";

// One placeholder page is exported; the preview generator writes a copy of it for each listing the business supplied
// (and none for any other property), so no property of the template's is ever published as the business's own.
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ slug: "preview-listing" }];
}

export default function PropertyPage() {
  return <PropertyView />;
}
