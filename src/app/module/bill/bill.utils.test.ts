import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	calculateBill,
	calculateEnergyChargePaisa,
	generateBillNumber,
	isBillOverdue,
	paisaToTaka,
	takaToPaisa,
} from "./bill.utils";

describe("calculateEnergyChargePaisa", () => {
	it("charges nothing for zero units", () => {
		assert.equal(calculateEnergyChargePaisa(0, "RESIDENTIAL"), 0);
		assert.equal(calculateEnergyChargePaisa(0, "COMMERCIAL"), 0);
	});

	it("bills the whole first slab at its own rate", () => {
		// 75 × 5.26
		assert.equal(calculateEnergyChargePaisa(75, "RESIDENTIAL"), 39_450);
	});

	it("bills only the units above a slab limit at the next rate", () => {
		// 75 × 5.26 + 1 × 7.20
		assert.equal(calculateEnergyChargePaisa(76, "RESIDENTIAL"), 39_450 + 720);
	});

	it("adds up the slices of a bill that spans three slabs", () => {
		// 75 × 5.26 + 125 × 7.20 + 50 × 7.59
		assert.equal(calculateEnergyChargePaisa(250, "RESIDENTIAL"), 167_400);
	});

	it("uses every slab, including the open-ended last one", () => {
		// 75×5.26 + 125×7.20 + 100×7.59 + 100×8.02 + 200×12.67 + 50×14.61
		assert.equal(calculateEnergyChargePaisa(650, "RESIDENTIAL"), 612_000);
	});

	it("never bills a later slab cheaper than staying in the earlier one", () => {
		for (let units = 1; units <= 700; units++) {
			assert.ok(
				calculateEnergyChargePaisa(units, "RESIDENTIAL") >
					calculateEnergyChargePaisa(units - 1, "RESIDENTIAL"),
				`charge must grow at ${units} units`,
			);
		}
	});

	it("uses one flat rate for commercial connections", () => {
		assert.equal(calculateEnergyChargePaisa(100, "COMMERCIAL"), 120_000);
		assert.equal(calculateEnergyChargePaisa(650, "COMMERCIAL"), 780_000);
	});
});

describe("calculateBill", () => {
	it("adds the demand charge and 5% VAT on energy + demand", () => {
		assert.deepEqual(
			calculateBill({
				unitsConsumed: 250,
				connectionType: "RESIDENTIAL",
				sanctionedLoadKW: 2,
			}),
			{
				energyPaisa: 167_400,
				demandPaisa: 8_400,
				vatPaisa: 8_790,
				totalPaisa: 184_590,
			},
		);
	});

	it("rounds VAT to the nearest paisa", () => {
		// (118650 + 8400) × 5% = 6352.5 → 6353
		const bill = calculateBill({
			unitsConsumed: 185,
			connectionType: "RESIDENTIAL",
			sanctionedLoadKW: 2,
		});

		assert.equal(bill.vatPaisa, 6_353);
		assert.equal(bill.totalPaisa, 133_403);
	});

	it("still charges for the connection when nothing was used", () => {
		const bill = calculateBill({
			unitsConsumed: 0,
			connectionType: "RESIDENTIAL",
			sanctionedLoadKW: 2,
		});

		assert.equal(bill.energyPaisa, 0);
		assert.equal(bill.totalPaisa, 8_820);
	});

	it("bills a commercial connection at the flat rate", () => {
		const bill = calculateBill({
			unitsConsumed: 100,
			connectionType: "COMMERCIAL",
			sanctionedLoadKW: 5,
		});

		assert.equal(bill.totalPaisa, 148_050);
	});

	it("only ever produces whole paisa", () => {
		const bill = calculateBill({
			unitsConsumed: 333,
			connectionType: "RESIDENTIAL",
			sanctionedLoadKW: 2.75,
		});

		for (const amount of Object.values(bill)) {
			assert.ok(Number.isInteger(amount));
		}
	});
});

describe("paisa and taka", () => {
	it("formats paisa as taka with two decimals", () => {
		assert.equal(paisaToTaka(133_403), "1334.03");
		assert.equal(paisaToTaka(8_820), "88.20");
		assert.equal(paisaToTaka(5), "0.05");
		assert.equal(paisaToTaka(0), "0.00");
	});

	it("reads taka back as the same paisa", () => {
		assert.equal(takaToPaisa("1334.03"), 133_403);
		assert.equal(takaToPaisa("0.29"), 29);
		assert.equal(takaToPaisa(88.2), 8_820);

		for (const paisa of [1, 99, 100, 101, 184_590, 677_250]) {
			assert.equal(takaToPaisa(paisaToTaka(paisa)), paisa);
		}
	});
});

describe("isBillOverdue", () => {
	const now = new Date("2026-10-08T06:00:00Z");
	const yesterday = new Date("2026-10-07T06:00:00Z");
	const tomorrow = new Date("2026-10-09T06:00:00Z");

	it("is true only for an unpaid bill past its due date", () => {
		assert.equal(
			isBillOverdue({ status: "UNPAID", dueDate: yesterday }, now),
			true,
		);
		assert.equal(
			isBillOverdue({ status: "UNPAID", dueDate: tomorrow }, now),
			false,
		);
	});

	it("is never true for a paid or cancelled bill", () => {
		assert.equal(
			isBillOverdue({ status: "PAID", dueDate: yesterday }, now),
			false,
		);
		assert.equal(
			isBillOverdue({ status: "CANCELLED", dueDate: yesterday }, now),
			false,
		);
	});
});

describe("generateBillNumber", () => {
	it("carries the billing month and a random suffix", () => {
		assert.match(
			generateBillNumber("2026-10"),
			/^ENZ-BILL-202610-[0-9A-F]{8}$/,
		);
		assert.notEqual(
			generateBillNumber("2026-10"),
			generateBillNumber("2026-10"),
		);
	});
});
