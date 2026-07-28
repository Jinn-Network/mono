import { describe, expect, test } from "vitest";
import { fitBradleyTerry } from "./bradley-terry.js";

describe("fitBradleyTerry", () => {
  test("two items: the closed-form fixed point is winCount/totalGames per item", () => {
    const wins = [
      ...Array.from({ length: 8 }, () => ({ winner: "A", loser: "B" })),
      ...Array.from({ length: 2 }, () => ({ winner: "B", loser: "A" })),
    ];
    const result = fitBradleyTerry(wins);
    expect(result.converged).toBe(true);
    expect(result.strengths["A"]).toBeCloseTo(0.8, 8);
    expect(result.strengths["B"]).toBeCloseTo(0.2, 8);
  });

  test("a single item (no comparisons) has strength 1", () => {
    expect(fitBradleyTerry([{ winner: "A", loser: "A" }].slice(0, 0))).toEqual({
      strengths: {},
      iterations: 0,
      converged: true,
    });
  });

  test("strengths always sum to 1", () => {
    const wins = [
      { winner: "A", loser: "B" },
      { winner: "B", loser: "C" },
      { winner: "C", loser: "A" },
      { winner: "A", loser: "C" },
    ];
    const result = fitBradleyTerry(wins);
    const total = Object.values(result.strengths).reduce((sum, v) => sum + v, 0);
    expect(total).toBeCloseTo(1, 8);
    expect(result.converged).toBe(true);
  });

  test("an item that always wins gets a strictly higher strength than one that always loses", () => {
    const wins = [
      { winner: "A", loser: "B" },
      { winner: "A", loser: "C" },
      { winner: "B", loser: "C" },
    ];
    const result = fitBradleyTerry(wins);
    expect(result.strengths["A"]!).toBeGreaterThan(result.strengths["B"]!);
    expect(result.strengths["B"]!).toBeGreaterThan(result.strengths["C"]!);
  });
});
