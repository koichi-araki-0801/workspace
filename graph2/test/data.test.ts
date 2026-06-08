import { describe, expect, it } from "vitest";
import {
  normalizeInputItems,
  resolveInputData,
  resolveInputDataAsync,
  samples,
} from "../src/data.js";

const sampleKey = Object.keys(samples)[0];

describe("normalizeInputItems", () => {
  it("[name, value] タプルを正規化する", () => {
    expect(normalizeInputItems([["A", 1], ["B", 2.5]])).toEqual([
      { name: "A", value: 1 },
      { name: "B", value: 2.5 },
    ]);
  });
  it("{name, value} オブジェクトを正規化する", () => {
    expect(normalizeInputItems([{ name: "A", value: 1 }])).toEqual([{ name: "A", value: 1 }]);
  });
  it("name は文字列・value は数値へ強制変換する", () => {
    expect(normalizeInputItems([[10, "3"]])).toEqual([{ name: "10", value: 3 }]);
  });
  it("配列でなければ投げる", () => {
    expect(() => normalizeInputItems("x" as unknown)).toThrow(/must be an array/);
  });
  it("要素が想定形でなければ投げる", () => {
    expect(() => normalizeInputItems([42])).toThrow(/Each item/);
    expect(() => normalizeInputItems([{ foo: 1 }])).toThrow(/Each item/);
  });
});

describe("resolveInputData", () => {
  it("data から解決する", () => {
    expect(resolveInputData({ data: [["A", 1]] })).toEqual([{ name: "A", value: 1 }]);
  });
  it("dataJson から解決する", () => {
    expect(resolveInputData({ dataJson: '[["A", 1], ["B", 2]]' })).toEqual([
      { name: "A", value: 1 },
      { name: "B", value: 2 },
    ]);
  });
  it("既知の sample から解決する", () => {
    const items = resolveInputData({ sample: sampleKey });
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(typeof items[0].name).toBe("string");
    expect(typeof items[0].value).toBe("number");
  });
  it("未知の sample は投げる", () => {
    expect(() => resolveInputData({ sample: "__no_such_sample__" })).toThrow(/Unknown sample/);
  });
  it("入力が無ければ投げる", () => {
    expect(() => resolveInputData({})).toThrow(/Provide one of/);
  });
});

describe("resolveInputDataAsync", () => {
  it("sample / data / dataJson を委譲する", async () => {
    await expect(resolveInputDataAsync({ kind: "data", data: [["A", 1]] })).resolves.toEqual([
      { name: "A", value: 1 },
    ]);
    await expect(
      resolveInputDataAsync({ kind: "dataJson", dataJson: '[["B", 2]]' }),
    ).resolves.toEqual([{ name: "B", value: 2 }]);
    const fromSample = await resolveInputDataAsync({ kind: "sample", sample: sampleKey });
    expect(fromSample.length).toBeGreaterThan(0);
  });
});
