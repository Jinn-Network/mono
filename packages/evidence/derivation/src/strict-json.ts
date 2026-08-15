// SPDX-License-Identifier: Apache-2.0

import { EvidenceDerivationError } from "./errors.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class StrictJsonScanner {
  readonly #text: string;
  #offset = 0;

  constructor(text: string) {
    this.#text = text;
  }

  scan(): void {
    this.#space();
    this.#value();
    this.#space();
    if (this.#offset !== this.#text.length) this.#invalid();
  }

  #value(): void {
    this.#space();
    const character = this.#text[this.#offset];
    if (character === "{") {
      this.#object();
      return;
    }
    if (character === "[") {
      this.#array();
      return;
    }
    if (character === '"') {
      this.#string();
      return;
    }
    if (this.#text.startsWith("true", this.#offset)) {
      this.#offset += 4;
      return;
    }
    if (this.#text.startsWith("false", this.#offset)) {
      this.#offset += 5;
      return;
    }
    if (this.#text.startsWith("null", this.#offset)) {
      this.#offset += 4;
      return;
    }
    const number = this.#text
      .slice(this.#offset)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) this.#invalid();
    if (!Number.isFinite(Number(number))) this.#invalid();
    this.#offset += number.length;
  }

  #object(): void {
    this.#offset += 1;
    this.#space();
    const keys = new Set<string>();
    if (this.#text[this.#offset] === "}") {
      this.#offset += 1;
      return;
    }
    while (true) {
      if (this.#text[this.#offset] !== '"') this.#invalid();
      const key = this.#string();
      if (keys.has(key) || FORBIDDEN_KEYS.has(key)) this.#invalid();
      keys.add(key);
      this.#space();
      if (this.#text[this.#offset] !== ":") this.#invalid();
      this.#offset += 1;
      this.#value();
      this.#space();
      if (this.#text[this.#offset] === "}") {
        this.#offset += 1;
        return;
      }
      if (this.#text[this.#offset] !== ",") this.#invalid();
      this.#offset += 1;
      this.#space();
    }
  }

  #array(): void {
    this.#offset += 1;
    this.#space();
    if (this.#text[this.#offset] === "]") {
      this.#offset += 1;
      return;
    }
    while (true) {
      this.#value();
      this.#space();
      if (this.#text[this.#offset] === "]") {
        this.#offset += 1;
        return;
      }
      if (this.#text[this.#offset] !== ",") this.#invalid();
      this.#offset += 1;
      this.#space();
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#offset += 1;
    while (this.#offset < this.#text.length) {
      const character = this.#text[this.#offset];
      if (character === '"') {
        this.#offset += 1;
        try {
          return JSON.parse(this.#text.slice(start, this.#offset)) as string;
        } catch {
          this.#invalid();
        }
      }
      if (character === "\\") {
        this.#offset += 2;
        continue;
      }
      if (!character || character.charCodeAt(0) < 0x20) this.#invalid();
      this.#offset += 1;
    }
    return this.#invalid();
  }

  #space(): void {
    while (/[\t\n\r ]/u.test(this.#text[this.#offset] ?? "")) {
      this.#offset += 1;
    }
  }

  #invalid(): never {
    throw new SyntaxError("ambiguous or invalid JSON");
  }
}

export function parseStrictJson(
  text: string,
  message: string,
  code:
    | "INVALID_DERIVATION_INPUT"
    | "POLICY_INVALID"
    | "SCRUBBER_DESCRIPTOR_INVALID"
    | "STRUCTURED_ARTIFACT_INVALID",
): unknown {
  try {
    new StrictJsonScanner(text).scan();
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new EvidenceDerivationError(code, message, { cause });
  }
}
