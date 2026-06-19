import { describe, it, expect } from "vitest";
import {
  runDecode,
  normalizeGtin14,
  gtinMatches,
  type Decoder,
  type DecodeInput,
  type RawDecode,
} from "../src/engines/decode.js";
import type { Symbology } from "../src/domain/types.js";

// A trivial injected decoder that replays a scripted RawDecode (or null).
function fixedDecoder(out: RawDecode | null): Decoder {
  return { decode: () => out };
}

function input(declaredSymbology: Symbology): DecodeInput {
  return { declaredSymbology, handle: {} };
}

describe("normalizeGtin14 / gtinMatches", () => {
  it("strips non-digits and left-pads to 14", () => {
    expect(normalizeGtin14("0 0123456 78901-2")).toBe("00123456789012");
  });
  it("zero-pads a 13-digit GTIN to compare equal to its 14-digit form", () => {
    expect(gtinMatches("4012345678901", "04012345678901")).toBe(true);
  });
  it("treats AI-wrapped and bare forms as equal after normalization", () => {
    expect(gtinMatches("(01)04012345678901", "04012345678901")).toBe(true);
  });
  it("returns digit-only string unchanged when longer than 14", () => {
    expect(normalizeGtin14("123456789012345")).toBe("123456789012345");
  });
  it("reports a real mismatch", () => {
    expect(gtinMatches("04012345678901", "04012345678999")).toBe(false);
  });
});

describe("runDecode — success path", () => {
  it("maps a RawDecode to decoded:true with symbology, data, dimension", () => {
    const dec = fixedDecoder({
      symbology: "DATAMATRIX",
      data: "ABC123",
      dimension: "16x16",
    });
    const res = runDecode(dec, input("DATAMATRIX"));
    expect(res.decoded).toBe(true);
    expect(res.symbology).toBe("DATAMATRIX");
    expect(res.data).toBe("ABC123");
    expect(res.dimension).toBe("16x16");
    expect(res.expectedDataMatch).toBeUndefined();
  });

  it("uses the adapter's auto-detected symbology, not the declared one", () => {
    const dec = fixedDecoder({ symbology: "QR", data: "hello", dimension: "M4" });
    const res = runDecode(dec, input("ITF14"));
    expect(res.symbology).toBe("QR");
  });

  it("omits dimension when the adapter reports none (1D)", () => {
    const dec = fixedDecoder({ symbology: "CODE128", data: "X" });
    const res = runDecode(dec, input("CODE128"));
    expect("dimension" in res).toBe(false);
  });
});

describe("runDecode — expected GTIN match", () => {
  it("sets expectedDataMatch=true for an ITF14 GTIN that matches after normalization", () => {
    const dec = fixedDecoder({ symbology: "ITF14", data: "4012345678901" });
    const res = runDecode(dec, input("ITF14"), { expectedGtin: "04012345678901" });
    expect(res.expectedDataMatch).toBe(true);
  });

  it("sets expectedDataMatch=false for an ITF14 GTIN that does not match", () => {
    const dec = fixedDecoder({ symbology: "ITF14", data: "04012345678901" });
    const res = runDecode(dec, input("ITF14"), { expectedGtin: "04012345678999" });
    expect(res.expectedDataMatch).toBe(false);
  });

  it("uses exact equality (no GTIN normalization) for non-ITF14 symbologies", () => {
    const dec = fixedDecoder({ symbology: "GS1_128", data: "(01)04012345678901" });
    expect(
      runDecode(dec, input("GS1_128"), { expectedGtin: "(01)04012345678901" }).expectedDataMatch,
    ).toBe(true);
    expect(
      runDecode(dec, input("GS1_128"), { expectedGtin: "04012345678901" }).expectedDataMatch,
    ).toBe(false);
  });
});

describe("runDecode — no-decode path", () => {
  it("returns decoded:false keeping the declared symbology and omitting data", () => {
    const res = runDecode(fixedDecoder(null), input("ITF14"), { expectedGtin: "04012345678901" });
    expect(res.decoded).toBe(false);
    expect(res.symbology).toBe("ITF14");
    expect(res.data).toBeUndefined();
    expect(res.dimension).toBeUndefined();
    expect(res.expectedDataMatch).toBeUndefined();
  });
});
