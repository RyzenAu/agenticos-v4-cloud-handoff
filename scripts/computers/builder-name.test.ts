import { describe, expect, test } from "bun:test";
import { componentName } from "./workflows/builder";

describe("a builder component is named from the request, not the base site's card", () => {
  test("a model that answers pricing-card for something else gets the title's name, else the request's", () => {
    expect(componentName("pricing-card", "Opening Hours", "Build an opening hours component")).toBe("opening-hours");
    expect(componentName("pricing-card", "", "Build an opening hours component")).toBe("opening-hours");
    expect(componentName("pricing-card", "", "please add a testimonials strip")).toBe("testimonials-strip");
  });
  test("a pricing request keeps pricing-card (an update of the base site's card); other names are the model's own", () => {
    expect(componentName("pricing-card", "Pricing card", "Update the pricing card with a badge")).toBe("pricing-card");
    expect(componentName("faq-list", "FAQ", "Build a faq list")).toBe("faq-list");
    expect(componentName("pricing-card", "Pricing card", "Change our packages layout")).toBe("pricing-card");
  });
});
