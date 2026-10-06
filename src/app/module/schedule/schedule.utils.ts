import { ScheduleStatus, ScheduleType } from "../../../generated/prisma/enums";
import type { ScheduleWhereInput } from "../../../generated/prisma/models";
import { diffMinutes, formatDhaka, toDhakaTimeString } from "../../utils/time";
import {
	MAX_LOAD_SHEDDING_MINUTES,
	MAX_MAINTENANCE_MINUTES,
	MIN_SCHEDULE_MINUTES,
	type SCHEDULE_PHASES,
} from "./schedule.constant";

// Pure schedule rules: no database access, so they can be unit-tested directly.

export type TSchedulePhase =
	| "DRAFT"
	| "CANCELLED"
	| "UPCOMING"
	| "ONGOING"
	| "COMPLETED";

type TPhaseInput = {
	status: ScheduleStatus;
	// strings when the row comes back from the JSON cache
	startTime: Date | string;
	endTime: Date | string;
};

// A published schedule's phase is derived from the clock on every read and
// never stored: there is no cron job that could keep a stored value current.
export const getPhase = (
	schedule: TPhaseInput,
	now: Date = new Date(),
): TSchedulePhase => {
	if (schedule.status !== ScheduleStatus.PUBLISHED) {
		return schedule.status;
	}

	if (now < new Date(schedule.startTime)) {
		return "UPCOMING";
	}

	return now < new Date(schedule.endTime) ? "ONGOING" : "COMPLETED";
};

export const withPhase = <T extends TPhaseInput>(
	schedule: T,
	now: Date = new Date(),
) => ({
	...schedule,
	phase: getPhase(schedule, now),
});

// The same rule as getPhase, expressed as a database filter.
export const phaseWhere = (
	phase: (typeof SCHEDULE_PHASES)[number],
	now: Date = new Date(),
): ScheduleWhereInput => {
	const filters = {
		UPCOMING: { status: ScheduleStatus.PUBLISHED, startTime: { gt: now } },
		ONGOING: {
			status: ScheduleStatus.PUBLISHED,
			startTime: { lte: now },
			endTime: { gt: now },
		},
		COMPLETED: { status: ScheduleStatus.PUBLISHED, endTime: { lte: now } },
	} satisfies Record<string, ScheduleWhereInput>;

	return filters[phase];
};

// Returns why a time window is not allowed for this schedule type, or null.
export const getWindowError = (
	type: ScheduleType,
	startTime: Date,
	endTime: Date,
): string | null => {
	const minutes = diffMinutes(startTime, endTime);

	if (minutes <= 0) {
		return "endTime must be after startTime";
	}

	if (minutes < MIN_SCHEDULE_MINUTES) {
		return `A schedule must last at least ${MIN_SCHEDULE_MINUTES} minutes`;
	}

	if (
		type === ScheduleType.LOAD_SHEDDING &&
		minutes > MAX_LOAD_SHEDDING_MINUTES
	) {
		return "A load-shedding block can last at most 4 hours";
	}

	if (type === ScheduleType.MAINTENANCE && minutes > MAX_MAINTENANCE_MINUTES) {
		return "A maintenance window can last at most 12 hours";
	}

	return null;
};

// "2026-10-06 19:00–20:00" in Dhaka time, for conflict messages.
export const formatWindow = (startTime: Date, endTime: Date): string =>
	`${formatDhaka(startTime)}–${toDhakaTimeString(endTime)}`;
