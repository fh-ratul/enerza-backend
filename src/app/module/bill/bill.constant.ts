// ILLUSTRATIVE tariff (roughly the 2024 BERC residential slabs).
// Verify against the current BERC order before citing these as real rates.
// All rates are in integer paisa (1 taka = 100 paisa) to avoid float errors.

// Each slice of consumption is billed at the rate of the slab it falls in.
export const RESIDENTIAL_SLABS = [
	{ upTo: 75, paisa: 526 },
	{ upTo: 200, paisa: 720 },
	{ upTo: 300, paisa: 759 },
	{ upTo: 400, paisa: 802 },
	{ upTo: 600, paisa: 1267 },
	{ upTo: Number.POSITIVE_INFINITY, paisa: 1461 },
] as const;

export const COMMERCIAL_FLAT_PAISA = 1200; // per unit (kWh)
export const DEMAND_CHARGE_PAISA_PER_KW = 4200; // per kW of sanctioned load
export const VAT_PERCENT = 5;
export const BILL_DUE_DAYS = 14;
