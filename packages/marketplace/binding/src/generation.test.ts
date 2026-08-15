import { describe, expect, test } from "vitest";
import { selectGeneration, type ContractGeneration } from "./generation.js";
import { BASE_SEPOLIA_TODAY } from "./addresses.js";

describe("ContractGeneration seam", () => {
  test("has exactly the two literals", () => {
    const today: ContractGeneration = "today";
    const revised: ContractGeneration = "revised";
    expect(today).toBe("today");
    expect(revised).toBe("revised");
  });

  test("selectGeneration is a total function reading the single config field (§5.4)", () => {
    expect(selectGeneration(BASE_SEPOLIA_TODAY)).toBe("today");
    expect(selectGeneration({ ...BASE_SEPOLIA_TODAY, generation: "revised" })).toBe("revised");
  });
});
