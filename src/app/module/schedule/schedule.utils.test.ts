import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeederPriority } from "../../../generated/prisma/enums";
import {
	buildSlots,
	getPhase,
	getWindowError,
	planRotation,
	type TGeneratorFeeder,
	type TGeneratorInput,
} from "./schedule.utils";

const feeder = (
	code: string,
	priority: FeederPriority,
	loadMW: number,
): TGeneratorFeeder => ({
	id: code,
	code,
	name: `${code} feeder`,
	priority,
	loadMW,
});

// 18:00–22:00 Dhaka time on 2026-10-10, in one-hour slots
const slots = buildSlots("2026-10-10", 18, 22, 60);

const plan = (overrides: Partial<TGeneratorInput>) =>
	planRotation({
		feeders: [],
		slots,
		deficitMW: 5,
		shedMinutes: {},
		dayMinutes: {},
		busy: {},
		...overrides,
	});

const codes = (slot: { feeders: { code: string }[] }) =>
	slot.feeders.map((item) => item.code);

describe("buildSlots", () => {
	it("cuts the window into consecutive slots in Dhaka time", () => {
		assert.equal(slots.length, 4);
		// 18:00 +06:00 is 12:00 UTC
		assert.equal(slots[0].startTime.toISOString(), "2026-10-10T12:00:00.000Z");
		assert.equal(slots[3].endTime.toISOString(), "2026-10-10T16:00:00.000Z");

		for (let index = 1; index < slots.length; index++) {
			assert.deepEqual(slots[index].startTime, slots[index - 1].endTime);
		}
	});

	it("supports 90 and 120 minute slots", () => {
		assert.equal(buildSlots("2026-10-10", 18, 21, 90).length, 2);
		assert.equal(buildSlots("2026-10-10", 18, 22, 120).length, 2);
	});
});

describe("planRotation", () => {
	it("never sheds a CRITICAL feeder, even when the deficit goes unmet", () => {
		const result = plan({
			feeders: [feeder("HOSPITAL", "CRITICAL", 9), feeder("A", "LOW", 2)],
			slots: slots.slice(0, 1),
			deficitMW: 8,
		});

		assert.deepEqual(codes(result[0]), ["A"]);
		assert.equal(result[0].shedMW, 2);
		assert.equal(result[0].unmetMW, 6);
	});

	it("sheds LOW before NORMAL before HIGH", () => {
		const result = plan({
			feeders: [
				feeder("H", "HIGH", 5),
				feeder("N", "NORMAL", 5),
				feeder("L", "LOW", 5),
			],
			slots: slots.slice(0, 1),
			deficitMW: 12,
		});

		assert.deepEqual(codes(result[0]), ["L", "N", "H"]);
	});

	it("within a priority, picks the feeder shed least in the last 7 days", () => {
		const result = plan({
			feeders: [feeder("A", "NORMAL", 5), feeder("B", "NORMAL", 5)],
			slots: slots.slice(0, 1),
			shedMinutes: { A: 240, B: 60 },
		});

		assert.deepEqual(codes(result[0]), ["B"]);
		assert.equal(result[0].feeders[0].shedMinutesBefore, 60);
	});

	it("on a fairness tie, prefers the larger feeder, then the code", () => {
		const bySize = plan({
			feeders: [feeder("A", "NORMAL", 3), feeder("B", "NORMAL", 6)],
			slots: slots.slice(0, 1),
		});
		const byCode = plan({
			feeders: [feeder("B", "NORMAL", 5), feeder("A", "NORMAL", 5)],
			slots: slots.slice(0, 1),
		});

		assert.deepEqual(codes(bySize[0]), ["B"]);
		assert.deepEqual(codes(byCode[0]), ["A"]);
	});

	it("stops adding feeders once the deficit is covered", () => {
		const result = plan({
			feeders: [
				feeder("A", "LOW", 4),
				feeder("B", "LOW", 3),
				feeder("C", "LOW", 2),
			],
			slots: slots.slice(0, 1),
			deficitMW: 6,
		});

		assert.deepEqual(codes(result[0]), ["A", "B"]);
		assert.equal(result[0].shedMW, 7);
		assert.equal(result[0].unmetMW, 0);
	});

	it("does not cut the same feeder in two slots in a row", () => {
		const result = plan({
			feeders: [feeder("A", "LOW", 5), feeder("B", "LOW", 5)],
		});

		assert.deepEqual(result.map(codes), [["A"], ["B"], ["A"], ["B"]]);
	});

	it("rotates so that equal feeders end the window with equal minutes", () => {
		const result = plan({
			feeders: [
				feeder("A", "NORMAL", 5),
				feeder("B", "NORMAL", 5),
				feeder("C", "NORMAL", 5),
				feeder("D", "NORMAL", 5),
			],
		});
		const minutes: Record<string, number> = {};

		for (const slot of result) {
			for (const item of slot.feeders) {
				minutes[item.code] = (minutes[item.code] ?? 0) + 60;
			}
		}

		assert.deepEqual(minutes, { A: 60, B: 60, C: 60, D: 60 });
	});

	it("leaves a slot uncovered rather than breaking the back-to-back rule", () => {
		const result = plan({ feeders: [feeder("A", "LOW", 5)] });

		assert.deepEqual(result.map(codes), [["A"], [], ["A"], []]);
		assert.deepEqual(
			result.map((slot) => slot.unmetMW),
			[0, 5, 0, 5],
		);
	});

	it("skips a feeder with a schedule that overlaps the slot", () => {
		const result = plan({
			feeders: [feeder("A", "LOW", 5), feeder("B", "HIGH", 5)],
			slots: slots.slice(0, 1),
			busy: {
				A: [
					{
						startTime: new Date("2026-10-10T12:30:00Z"),
						endTime: new Date("2026-10-10T13:30:00Z"),
					},
				],
			},
		});

		assert.deepEqual(codes(result[0]), ["B"]);
	});

	it("skips a feeder whose existing schedule only touches the slot", () => {
		const result = plan({
			feeders: [feeder("A", "LOW", 5), feeder("B", "HIGH", 5)],
			slots: slots.slice(0, 1),
			// ends at 18:00, exactly when the slot starts
			busy: {
				A: [
					{
						startTime: new Date("2026-10-10T11:00:00Z"),
						endTime: new Date("2026-10-10T12:00:00Z"),
					},
				],
			},
		});

		assert.deepEqual(codes(result[0]), ["B"]);
	});

	it("respects the daily cap of 240 minutes per feeder", () => {
		const result = plan({
			feeders: [feeder("A", "LOW", 5), feeder("B", "HIGH", 5)],
			slots: slots.slice(0, 1),
			dayMinutes: { A: 200 },
		});
		const atTheLimit = plan({
			feeders: [feeder("A", "LOW", 5), feeder("B", "HIGH", 5)],
			slots: slots.slice(0, 1),
			dayMinutes: { A: 180 },
		});

		assert.deepEqual(codes(result[0]), ["B"]);
		assert.deepEqual(codes(atTheLimit[0]), ["A"]);
	});

	it("reports the whole deficit as unmet when nobody can be shed", () => {
		const result = plan({
			feeders: [feeder("HOSPITAL", "CRITICAL", 9)],
			deficitMW: 7.5,
		});

		for (const slot of result) {
			assert.deepEqual(slot.feeders, []);
			assert.equal(slot.shedMW, 0);
			assert.equal(slot.unmetMW, 7.5);
		}
	});

	it("adds up loads without float drift", () => {
		const result = plan({
			feeders: [
				feeder("A", "LOW", 0.1),
				feeder("B", "LOW", 0.2),
				feeder("C", "LOW", 0.7),
			],
			slots: slots.slice(0, 1),
			deficitMW: 1,
		});

		assert.equal(result[0].shedMW, 1);
		assert.equal(result[0].unmetMW, 0);
	});

	it("does not change the totals it was given", () => {
		const shedMinutes = { A: 30 };
		const dayMinutes = { A: 0 };
		const busy = { A: [] };

		plan({
			feeders: [feeder("A", "LOW", 5)],
			shedMinutes,
			dayMinutes,
			busy,
		});

		assert.deepEqual(shedMinutes, { A: 30 });
		assert.deepEqual(dayMinutes, { A: 0 });
		assert.deepEqual(busy, { A: [] });
	});

	it("gives the same plan for the same input in any feeder order", () => {
		const feeders = [
			feeder("A", "LOW", 4),
			feeder("B", "NORMAL", 6),
			feeder("C", "LOW", 4),
			feeder("D", "HIGH", 8),
		];
		const forwards = plan({ feeders, deficitMW: 9 });
		const backwards = plan({ feeders: [...feeders].reverse(), deficitMW: 9 });

		assert.deepEqual(forwards.map(codes), backwards.map(codes));
	});
});

describe("getPhase", () => {
	const schedule = {
		status: "PUBLISHED" as const,
		startTime: new Date("2026-10-10T12:00:00Z"),
		endTime: new Date("2026-10-10T13:00:00Z"),
	};

	it("derives the phase of a published schedule from the clock", () => {
		assert.equal(
			getPhase(schedule, new Date("2026-10-10T11:59:59Z")),
			"UPCOMING",
		);
		assert.equal(
			getPhase(schedule, new Date("2026-10-10T12:00:00Z")),
			"ONGOING",
		);
		assert.equal(
			getPhase(schedule, new Date("2026-10-10T12:59:59Z")),
			"ONGOING",
		);
		assert.equal(
			getPhase(schedule, new Date("2026-10-10T13:00:00Z")),
			"COMPLETED",
		);
	});

	it("reports a draft or cancelled schedule as exactly that", () => {
		const during = new Date("2026-10-10T12:30:00Z");

		assert.equal(getPhase({ ...schedule, status: "DRAFT" }, during), "DRAFT");
		assert.equal(
			getPhase({ ...schedule, status: "CANCELLED" }, during),
			"CANCELLED",
		);
	});

	it("accepts the ISO strings a cached row comes back with", () => {
		assert.equal(
			getPhase(
				{
					status: "PUBLISHED",
					startTime: "2026-10-10T12:00:00.000Z",
					endTime: "2026-10-10T13:00:00.000Z",
				},
				new Date("2026-10-10T12:30:00Z"),
			),
			"ONGOING",
		);
	});
});

describe("getWindowError", () => {
	const start = new Date("2026-10-10T12:00:00Z");
	const after = (minutes: number) =>
		new Date(start.getTime() + minutes * 60_000);

	it("accepts a normal window", () => {
		assert.equal(getWindowError("LOAD_SHEDDING", start, after(60)), null);
		assert.equal(getWindowError("LOAD_SHEDDING", start, after(240)), null);
		assert.equal(getWindowError("MAINTENANCE", start, after(720)), null);
	});

	it("rejects a window that ends before it starts, or is too short", () => {
		assert.ok(getWindowError("LOAD_SHEDDING", start, after(-30)));
		assert.ok(getWindowError("LOAD_SHEDDING", start, after(0)));
		assert.ok(getWindowError("LOAD_SHEDDING", start, after(29)));
		assert.equal(getWindowError("LOAD_SHEDDING", start, after(30)), null);
	});

	it("caps load shedding at 4 hours and maintenance at 12", () => {
		assert.ok(getWindowError("LOAD_SHEDDING", start, after(241)));
		assert.equal(getWindowError("MAINTENANCE", start, after(241)), null);
		assert.ok(getWindowError("MAINTENANCE", start, after(721)));
	});
});
