import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeReliability, toCountMap } from "./admin.utils";

describe("computeReliability", () => {
	const zones = [
		{ id: "z1", name: "North", code: "DZ-NORTH", feederIds: ["f1", "f2"] },
		{ id: "z2", name: "South", code: "DZ-SOUTH", feederIds: ["f3"] },
	];
	// f1 serves 4 customers, f2 serves 2, f3 serves 10
	const customersByFeeder = new Map([
		["f1", 4],
		["f2", 2],
		["f3", 10],
	]);

	it("computes SAIFI and SAIDI per zone and overall", () => {
		const result = computeReliability(zones, customersByFeeder, [
			{ feederId: "f1", durationMinutes: 60 },
			{ feederId: "f2", durationMinutes: 30 },
			{ feederId: "f3", durationMinutes: 120 },
		]);
		const [north, south] = result.byZone;

		// North: (4 + 2) ÷ 6 interruptions, (4×60 + 2×30) ÷ 6 minutes
		assert.deepEqual(
			{ ...north, zone: north.zone.code },
			{
				zone: "DZ-NORTH",
				customers: 6,
				outages: 2,
				saifi: 1,
				saidiMinutes: 50,
			},
		);
		// South: 10 ÷ 10, (10×120) ÷ 10
		assert.deepEqual(
			{ ...south, zone: south.zone.code },
			{
				zone: "DZ-SOUTH",
				customers: 10,
				outages: 1,
				saifi: 1,
				saidiMinutes: 120,
			},
		);
		// Overall: 16 ÷ 16, (240 + 60 + 1200) ÷ 16
		assert.deepEqual(result.overall, {
			customers: 16,
			outages: 3,
			saifi: 1,
			saidiMinutes: 93.8,
		});
	});

	it("counts a feeder twice when it had two outages", () => {
		const { overall } = computeReliability(zones, customersByFeeder, [
			{ feederId: "f1", durationMinutes: 30 },
			{ feederId: "f1", durationMinutes: 30 },
		]);

		// 8 customer interruptions ÷ 16 customers
		assert.equal(overall.saifi, 0.5);
		assert.equal(overall.saidiMinutes, 15);
	});

	it("is zero when there were no outages", () => {
		const result = computeReliability(zones, customersByFeeder, []);

		assert.equal(result.overall.saifi, 0);
		assert.equal(result.overall.saidiMinutes, 0);
		assert.equal(result.byZone[0].outages, 0);
	});

	it("does not divide by zero for a zone with no customers", () => {
		const result = computeReliability(zones, new Map(), [
			{ feederId: "f1", durationMinutes: 60 },
		]);

		assert.deepEqual(result.overall, {
			customers: 0,
			outages: 1,
			saifi: 0,
			saidiMinutes: 0,
		});
	});

	it("treats a missing duration as zero minutes", () => {
		const { overall } = computeReliability(zones, customersByFeeder, [
			{ feederId: "f3", durationMinutes: null },
		]);

		assert.equal(overall.saifi, 0.625);
		assert.equal(overall.saidiMinutes, 0);
	});

	it("ignores outages on feeders outside every zone", () => {
		const { overall } = computeReliability(zones, customersByFeeder, [
			{ feederId: "deleted-feeder", durationMinutes: 600 },
		]);

		assert.equal(overall.outages, 0);
		assert.equal(overall.saidiMinutes, 0);
	});
});

describe("toCountMap", () => {
	it("returns every key, with zero for the ones that have no rows", () => {
		assert.deepEqual(
			toCountMap(["REPORTED", "ASSIGNED", "IN_PROGRESS"] as const, [
				{ key: "ASSIGNED", count: 4 },
			]),
			{ REPORTED: 0, ASSIGNED: 4, IN_PROGRESS: 0 },
		);
	});

	it("adds up several rows for the same key", () => {
		assert.deepEqual(
			toCountMap(["CUSTOMER", "ADMIN"] as const, [
				{ key: "CUSTOMER", count: 18 },
				{ key: "CUSTOMER", count: 1 },
				{ key: "ADMIN", count: 1 },
			]),
			{ CUSTOMER: 19, ADMIN: 1 },
		);
	});
});
