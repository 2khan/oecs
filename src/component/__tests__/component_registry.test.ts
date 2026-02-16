import { describe, expect, it } from "vitest";
import { ComponentRegistry } from "../component_registry";
import { as_component_id } from "../component";
import { create_entity_id } from "../../entity/entity";

// Helper: create entity IDs at known indices
const entity_at = (index: number) => create_entity_id(index, 0);

describe("ComponentRegistry", () => {
  //=========================================================
  // Registration
  //=========================================================
  it("register increments count", () => {
    const reg = new ComponentRegistry();
    expect(reg.count).toBe(0);

    reg.register({ x: "f32", y: "f32" });
    expect(reg.count).toBe(1);

    reg.register({ hp: "i32" });
    expect(reg.count).toBe(2);
  });

  it("register returns sequential IDs", () => {
    const reg = new ComponentRegistry();
    const a = reg.register({ x: "f32" });
    const b = reg.register({ y: "f32" });
    const c = reg.register({ z: "f32" });

    // ComponentDef is a branded number, so we can compare directly
    expect((a as number) + 1).toBe(b as number);
    expect((b as number) + 1).toBe(c as number);
  });

  it("register tag component (empty schema)", () => {
    const reg = new ComponentRegistry();
    const Tag = reg.register({});

    expect(reg.count).toBe(1);
    expect(reg.get_schema(Tag)).toEqual({});
  });

  //=========================================================
  // get_schema
  //=========================================================
  it("get_schema returns the original schema", () => {
    const reg = new ComponentRegistry();
    const schema = { x: "f32", y: "f32", z: "f32" } as const;
    const def = reg.register(schema);

    expect(reg.get_schema(def)).toEqual(schema);
  });

  it("get_schema throws for unregistered ID", () => {
    const reg = new ComponentRegistry();
    expect(() => reg.get_schema(as_component_id(999))).toThrow();
  });

  //=========================================================
  // Bulk set
  //=========================================================
  it("set and get_field roundtrip", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32", z: "f32" });
    const e = entity_at(0);

    reg.set(Pos, e, { x: 10, y: 20, z: 30 });

    expect(reg.get_field(Pos, e, "x")).toBe(10);
    expect(reg.get_field(Pos, e, "y")).toBe(20);
    expect(reg.get_field(Pos, e, "z")).toBe(30);
  });

  it("set overwrites previous values", () => {
    const reg = new ComponentRegistry();
    const Hp = reg.register({ current: "f32", max: "f32" });
    const e = entity_at(0);

    reg.set(Hp, e, { current: 100, max: 100 });
    reg.set(Hp, e, { current: 50, max: 100 });

    expect(reg.get_field(Hp, e, "current")).toBe(50);
    expect(reg.get_field(Hp, e, "max")).toBe(100);
  });

  it("different entities have independent data", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });

    const e0 = entity_at(0);
    const e1 = entity_at(1);

    reg.set(Pos, e0, { x: 1, y: 2 });
    reg.set(Pos, e1, { x: 10, y: 20 });

    expect(reg.get_field(Pos, e0, "x")).toBe(1);
    expect(reg.get_field(Pos, e0, "y")).toBe(2);
    expect(reg.get_field(Pos, e1, "x")).toBe(10);
    expect(reg.get_field(Pos, e1, "y")).toBe(20);
  });

  it("different components on same entity are independent", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });
    const Vel = reg.register({ vx: "f32", vy: "f32" });

    const e = entity_at(0);
    reg.set(Pos, e, { x: 1, y: 2 });
    reg.set(Vel, e, { vx: 5, vy: 10 });

    expect(reg.get_field(Pos, e, "x")).toBe(1);
    expect(reg.get_field(Pos, e, "y")).toBe(2);
    expect(reg.get_field(Vel, e, "vx")).toBe(5);
    expect(reg.get_field(Vel, e, "vy")).toBe(10);
  });

  //=========================================================
  // Single-field access
  //=========================================================
  it("set_field / get_field roundtrip", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32", z: "f32" });
    const e = entity_at(0);

    reg.set_field(Pos, e, "x", 42);
    reg.set_field(Pos, e, "y", 99);
    reg.set_field(Pos, e, "z", -7);

    expect(reg.get_field(Pos, e, "x")).toBe(42);
    expect(reg.get_field(Pos, e, "y")).toBe(99);
    expect(reg.get_field(Pos, e, "z")).toBeCloseTo(-7);
  });

  it("set_field only changes the targeted field", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });
    const e = entity_at(0);

    reg.set(Pos, e, { x: 1, y: 2 });
    reg.set_field(Pos, e, "x", 999);

    expect(reg.get_field(Pos, e, "x")).toBe(999);
    expect(reg.get_field(Pos, e, "y")).toBe(2);
  });

  //=========================================================
  // Raw column access
  //=========================================================
  it("get_column returns the correct typed array type", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "u16" });

    const x_col = reg.get_column(Pos, "x");
    const y_col = reg.get_column(Pos, "y");

    expect(x_col).toBeInstanceOf(Float32Array);
    expect(y_col).toBeInstanceOf(Uint16Array);
  });

  it("get_column reflects set data", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });

    reg.set(Pos, entity_at(0), { x: 5, y: 10 });
    reg.set(Pos, entity_at(3), { x: 15, y: 20 });

    const xs = reg.get_column(Pos, "x");
    expect(xs[0]).toBe(5);
    expect(xs[3]).toBe(15);
  });

  it("writing to raw column is visible through get_field", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });
    const e = entity_at(2);

    // Write via raw column
    const xs = reg.get_column(Pos, "x");
    xs[2] = 77;

    expect(reg.get_field(Pos, e, "x")).toBe(77);
  });

  //=========================================================
  // Typed array backing for different TypeTags
  //=========================================================
  it("i32 columns store negative integers", () => {
    const reg = new ComponentRegistry();
    const C = reg.register({ val: "i32" });
    const e = entity_at(0);

    reg.set(C, e, { val: -42 });
    expect(reg.get_field(C, e, "val")).toBe(-42);
  });

  it("u8 columns clamp to 0-255 range", () => {
    const reg = new ComponentRegistry();
    const C = reg.register({ val: "u8" });
    const e = entity_at(0);

    reg.set(C, e, { val: 300 });
    // Uint8Array wraps: 300 & 0xFF = 44
    expect(reg.get_field(C, e, "val")).toBe(300 & 0xff);
  });

  it("f64 columns preserve high precision", () => {
    const reg = new ComponentRegistry();
    const C = reg.register({ val: "f64" });
    const e = entity_at(0);

    const precise = 1.0000000000000002; // differs from 1.0 only at f64 precision
    reg.set(C, e, { val: precise });
    expect(reg.get_field(C, e, "val")).toBe(precise);
  });

  //=========================================================
  // Capacity / Growth
  //=========================================================
  it("auto-grows when entity index exceeds initial capacity", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });

    // Entity at index 200 is beyond initial capacity (64)
    const far = entity_at(200);
    reg.set(Pos, far, { x: 1, y: 2 });

    expect(reg.get_field(Pos, far, "x")).toBe(1);
    expect(reg.get_field(Pos, far, "y")).toBe(2);
  });

  it("ensure_capacity preserves existing data", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });

    const e0 = entity_at(0);
    const e5 = entity_at(5);
    reg.set(Pos, e0, { x: 10, y: 20 });
    reg.set(Pos, e5, { x: 50, y: 60 });

    reg.ensure_capacity(500);

    expect(reg.get_field(Pos, e0, "x")).toBe(10);
    expect(reg.get_field(Pos, e0, "y")).toBe(20);
    expect(reg.get_field(Pos, e5, "x")).toBe(50);
    expect(reg.get_field(Pos, e5, "y")).toBe(60);
  });

  it("ensure_capacity is no-op when already large enough", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32" });
    const e = entity_at(0);

    reg.set(Pos, e, { x: 42 });
    reg.ensure_capacity(10); // smaller than initial 64

    expect(reg.get_field(Pos, e, "x")).toBe(42);
  });

  it("growth handles multiple components at once", () => {
    const reg = new ComponentRegistry();
    const A = reg.register({ a: "f32" });
    const B = reg.register({ b: "i32" });

    const e = entity_at(0);
    reg.set(A, e, { a: 1 });
    reg.set(B, e, { b: -99 });

    // Force growth
    const far = entity_at(300);
    reg.set(A, far, { a: 2 });
    reg.set(B, far, { b: 42 });

    // Old data preserved
    expect(reg.get_field(A, e, "a")).toBe(1);
    expect(reg.get_field(B, e, "b")).toBe(-99);
    // New data accessible
    expect(reg.get_field(A, far, "a")).toBe(2);
    expect(reg.get_field(B, far, "b")).toBe(42);
  });

  it("get_column returns new buffer after growth", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32" });

    const before = reg.get_column(Pos, "x");
    reg.ensure_capacity(1000);
    const after = reg.get_column(Pos, "x");

    // Buffer is reallocated
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThanOrEqual(1000);
  });

  //=========================================================
  // Many entities
  //=========================================================
  it("handles 1000 entities correctly", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });

    for (let i = 0; i < 1000; i++) {
      reg.set(Pos, entity_at(i), { x: i, y: i * 2 });
    }

    for (let i = 0; i < 1000; i++) {
      expect(reg.get_field(Pos, entity_at(i), "x")).toBe(i);
      expect(reg.get_field(Pos, entity_at(i), "y")).toBe(i * 2);
    }
  });

  //=========================================================
  // clear
  //=========================================================
  it("clear poisons float fields with NaN", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32", z: "f32" });
    const e = entity_at(3);

    reg.set(Pos, e, { x: 10, y: 20, z: 30 });
    reg.clear(Pos, 3);

    expect(reg.get_field(Pos, e, "x")).toBeNaN();
    expect(reg.get_field(Pos, e, "y")).toBeNaN();
    expect(reg.get_field(Pos, e, "z")).toBeNaN();
  });

  it("clear poisons integer fields with all-bits-set", () => {
    const reg = new ComponentRegistry();
    const Stats = reg.register({ hp: "i32", flags: "u8" });
    const e = entity_at(0);

    reg.set(Stats, e, { hp: 100, flags: 3 });
    reg.clear(Stats, 0);

    expect(reg.get_field(Stats, e, "hp")).toBe(-1);
    expect(reg.get_field(Stats, e, "flags")).toBe(0xff);
  });

  it("clear does not affect other entities", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });

    const e0 = entity_at(0);
    const e1 = entity_at(1);
    reg.set(Pos, e0, { x: 1, y: 2 });
    reg.set(Pos, e1, { x: 10, y: 20 });

    reg.clear(Pos, 0);

    expect(reg.get_field(Pos, e0, "x")).toBeNaN();
    expect(reg.get_field(Pos, e0, "y")).toBeNaN();
    expect(reg.get_field(Pos, e1, "x")).toBe(10);
    expect(reg.get_field(Pos, e1, "y")).toBe(20);
  });

  //=========================================================
  // Uninitialized data reads zero
  //=========================================================
  it("uninitialized fields read as zero", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32", y: "f32" });

    // Never called set - typed arrays are zero-initialized
    const e = entity_at(5);
    expect(reg.get_field(Pos, e, "x")).toBe(0);
    expect(reg.get_field(Pos, e, "y")).toBe(0);
  });

  //=========================================================
  // set_field auto-grows
  //=========================================================
  it("set_field triggers growth when needed", () => {
    const reg = new ComponentRegistry();
    const Pos = reg.register({ x: "f32" });

    const far = entity_at(200);
    reg.set_field(Pos, far, "x", 77);

    expect(reg.get_field(Pos, far, "x")).toBe(77);
  });
});
