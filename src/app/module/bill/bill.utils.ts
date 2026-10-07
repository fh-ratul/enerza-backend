import crypto from "node:crypto";
import type {
	BillStatus,
	ConnectionType,
} from "../../../generated/prisma/enums";
import {
	COMMERCIAL_FLAT_PAISA,
	DEMAND_CHARGE_PAISA_PER_KW,
	RESIDENTIAL_SLABS,
	VAT_PERCENT,
} from "./bill.constant";

// Pure tariff maths: no database access, so it can be unit-tested directly.

export const calculateEnergyChargePaisa = (
	unitsConsumed: number,
	connectionType: ConnectionType,
): number => {
	if (connectionType === "COMMERCIAL") {
		return unitsConsumed * COMMERCIAL_FLAT_PAISA;
	}

	// Incremental slabs: 250 units = 75 @ slab 1 + 125 @ slab 2 + 50 @ slab 3.
	let remaining = unitsConsumed;
	let previousCap = 0;
	let total = 0;

	for (const slab of RESIDENTIAL_SLABS) {
		if (remaining <= 0) {
			break;
		}

		const unitsInSlab = Math.min(remaining, slab.upTo - previousCap);

		total += unitsInSlab * slab.paisa;
		remaining -= unitsInSlab;
		previousCap = slab.upTo;
	}

	return total;
};

type TBillInput = {
	unitsConsumed: number;
	connectionType: ConnectionType;
	sanctionedLoadKW: number;
};

export const calculateBill = ({
	unitsConsumed,
	connectionType,
	sanctionedLoadKW,
}: TBillInput) => {
	const energyPaisa = calculateEnergyChargePaisa(unitsConsumed, connectionType);
	const demandPaisa = Math.round(sanctionedLoadKW * DEMAND_CHARGE_PAISA_PER_KW);
	const vatPaisa = Math.round(
		((energyPaisa + demandPaisa) * VAT_PERCENT) / 100,
	);

	return {
		energyPaisa,
		demandPaisa,
		vatPaisa,
		totalPaisa: energyPaisa + demandPaisa + vatPaisa,
	};
};

// 123456 paisa → "1234.56", ready for a Decimal(10,2) column.
export const paisaToTaka = (paisa: number): string =>
	`${Math.trunc(paisa / 100)}.${String(paisa % 100).padStart(2, "0")}`;

// "1234.56" (or a Prisma Decimal) → 123456 paisa
export const takaToPaisa = (taka: { toString(): string } | number): number =>
	Math.round(Number(taka.toString()) * 100);

// "Overdue" is never stored: it is an unpaid bill looked at after its due date.
export const isBillOverdue = (
	bill: { status: BillStatus; dueDate: Date },
	now: Date = new Date(),
): boolean => bill.status === "UNPAID" && bill.dueDate < now;

// ENZ-BILL-202610-9F3A1C2B
export const generateBillNumber = (billingMonth: string): string =>
	`ENZ-BILL-${billingMonth.replace("-", "")}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
