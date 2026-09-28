import { describe, it, expect } from "vitest";
import {
  isVisionNotSupportedError,
  stripDataUrlPrefix,
} from "./assistantAi.js";

describe("stripDataUrlPrefix", () => {
  it("strips the dataURL prefix", () => {
    expect(stripDataUrlPrefix("data:image/jpeg;base64,abcd")).toBe("abcd");
  });

  it("leaves raw base64 untouched", () => {
    expect(stripDataUrlPrefix("abcd")).toBe("abcd");
  });
});

describe("isVisionNotSupportedError", () => {
  it("detects vision-related provider errors", () => {
    expect(
      isVisionNotSupportedError(
        new Error("Model does not support image inputs"),
      ),
    ).toBe(true);
    expect(isVisionNotSupportedError("unsupported content type")).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isVisionNotSupportedError(new Error("timeout"))).toBe(false);
    expect(isVisionNotSupportedError(null)).toBe(false);
  });
});
