import type {
	FeederPriority,
	OutagePriority,
	OutageStatus,
} from "../../../generated/prisma/enums";
import {
	ESCALATION_REPORT_COUNT,
	FEEDER_TO_OUTAGE_PRIORITY,
	OUTAGE_PRIORITY_ORDER,
	OUTAGE_TRANSITIONS,
} from "./outage.constant";

// Pure outage rules: no database access, so they can be unit-tested directly.

export const canTransition = (from: OutageStatus, to: OutageStatus): boolean =>
	OUTAGE_TRANSITIONS[from].includes(to);

// The priority is always derived from the feeder and the number of reports,
// never nudged up step by step, so recomputing it is safe at any time.
export const computeOutagePriority = (
	feederPriority: FeederPriority,
	reportCount: number,
): OutagePriority => {
	const basePriority = FEEDER_TO_OUTAGE_PRIORITY[feederPriority];

	if (reportCount < ESCALATION_REPORT_COUNT) {
		return basePriority;
	}

	const nextIndex = Math.min(
		OUTAGE_PRIORITY_ORDER.indexOf(basePriority) + 1,
		OUTAGE_PRIORITY_ORDER.length - 1,
	);

	return OUTAGE_PRIORITY_ORDER[nextIndex];
};
