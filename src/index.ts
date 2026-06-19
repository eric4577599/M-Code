// Public entry point for the corrugated barcode QC core library.
// Re-exports the domain model and every engine so a frontend (Flutter/native
// via FFI, or any JS host) imports a single module.

// Domain model + shared helpers
export * from "./domain/types.js";
export * from "./domain/scale.js";
export * from "./domain/flags.js";

// Engines (spec Part C)
export * from "./engines/gate.js"; // C4 capture quality gate
export * from "./engines/decode.js"; // C5 decode boundary
export * from "./engines/measurement.js"; // C6 measurement
export * from "./engines/grade.js"; // C7 relative grading
export * from "./engines/diagnosis.js"; // C8 diagnosis rule engine
export * from "./engines/acceptance.js"; // acceptance evaluation

// ERP / export (C9)
export * from "./erp/client.js";
export * from "./export/csv.js";

// Seed reference data (C8 rules, C3.2 profiles/policies, D3 flutes)
export * from "./data/rules.js";
export * from "./data/profiles.js";
export * from "./data/policies.js";
export * from "./data/flutes.js";
