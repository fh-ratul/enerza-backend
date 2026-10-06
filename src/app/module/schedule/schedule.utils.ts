import {
	FeederPriority,
	ScheduleStatus,
	ScheduleType,
} from "../../../generated/prisma/enums";
import type { ScheduleWhereInput } from "../../../generated/prisma/models";
import {
	addMinutes,
	dhakaDateAtHour,
	diffMinutes,
	formatDhaka,
	toDhakaTimeString,
} from "../../utils/time";
import {
	DAILY_SHEDDING_CAP_MINUTES,
	MAX_LOAD_SHEDDING_MINUTES,
	MAX_MAINTENANCE_MINUTES,
	MIN_SCHEDULE_MINUTES,
	type SCHEDULE_PHASES,
	SHED_PRIORITY_RANK,
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

// ── Automated generator ─────────────────────────────────────────────────────

export type TInterval = {
	startTime: Date;
	endTime: Date;
};

export type TGeneratorFeeder = {
	id: string;
	code: string;
	name: string;
	priority: FeederPriority;
	loadMW: number;
};

export type TGeneratorInput = {
	// active, non-deleted feeders in scope
	feeders: TGeneratorFeeder[];
	// consecutive slots of the window, in order
	slots: TInterval[];
	// MW that has to be shed in every slot
	deficitMW: number;
	// feederId → load-shedding minutes in the fairness window (last 7 days)
	shedMinutes: Record<string, number>;
	// feederId → load-shedding minutes already on the target day
	dayMinutes: Record<string, number>;
	// feederId → schedules of any type already on or next to the target day
	busy: Record<string, TInterval[]>;
};

export type TPlannedSlot = TInterval & {
	feeders: (TGeneratorFeeder & { shedMinutesBefore: number })[];
	shedMW: number;
	unmetMW: number;
};

// "2026-10-07", 18, 22, 60 → four one-hour slots starting 18:00 Dhaka time.
export const buildSlots = (
	date: string,
	startHour: number,
	endHour: number,
	slotMinutes: number,
): TInterval[] => {
	const windowStart = dhakaDateAtHour(date, startHour);
	const slotCount = Math.floor(((endHour - startHour) * 60) / slotMinutes);

	return Array.from({ length: slotCount }, (_, index) => ({
		startTime: addMinutes(windowStart, index * slotMinutes),
		endTime: addMinutes(windowStart, (index + 1) * slotMinutes),
	}));
};

// Feeder loads have two decimals: summing them as integers avoids float drift.
const toCentiMW = (megawatts: number) => Math.round(megawatts * 100);

// Greedy rotation with hard constraints and a fairness key. O(S · F log F)
// for S slots and F feeders.
//
// For every slot, in order:
//   1. Hard constraints remove feeders that may not be shed in this slot:
//        - CRITICAL feeders (never shed);
//        - feeders with a schedule that overlaps OR touches the slot. Touching
//          counts so that nobody is cut back-to-back; because each pick is
//          recorded as a schedule, it also keeps a feeder out of the slot
//          right after the one it was just shed in;
//        - feeders that would exceed the daily cap.
//   2. The rest are ordered by priority (LOW → NORMAL → HIGH), then by who
//      has been shed least recently (fairness), then by load (bigger first,
//      so fewer feeders are needed), then by code so the result is stable.
//   3. Feeders are taken from the front until their combined load covers the
//      deficit. Whatever cannot be covered is reported as unmet MW.
//   4. The picks update the running totals, so later slots see them.
export const planRotation = ({
	feeders,
	slots,
	deficitMW,
	shedMinutes,
	dayMinutes,
	busy,
}: TGeneratorInput): TPlannedSlot[] => {
	const candidates = feeders.filter(
		(feeder) => feeder.priority !== FeederPriority.CRITICAL,
	);

	// Working copies: the plan changes these as it goes, the inputs stay intact.
	const shed = new Map(
		candidates.map((feeder) => [feeder.id, shedMinutes[feeder.id] ?? 0]),
	);
	const day = new Map(
		candidates.map((feeder) => [feeder.id, dayMinutes[feeder.id] ?? 0]),
	);
	const occupied = new Map(
		candidates.map((feeder) => [feeder.id, [...(busy[feeder.id] ?? [])]]),
	);

	const rank = (feeder: TGeneratorFeeder) =>
		SHED_PRIORITY_RANK[feeder.priority as keyof typeof SHED_PRIORITY_RANK];
	const deficit = toCentiMW(deficitMW);

	return slots.map((slot) => {
		const slotMinutes = diffMinutes(slot.startTime, slot.endTime);

		const pool = candidates
			.filter((feeder) => {
				const isBusy = (occupied.get(feeder.id) ?? []).some(
					(interval) =>
						interval.startTime <= slot.endTime &&
						interval.endTime >= slot.startTime,
				);
				const minutesToday = day.get(feeder.id) ?? 0;

				return (
					!isBusy && minutesToday + slotMinutes <= DAILY_SHEDDING_CAP_MINUTES
				);
			})
			.sort(
				(a, b) =>
					rank(a) - rank(b) ||
					(shed.get(a.id) ?? 0) - (shed.get(b.id) ?? 0) ||
					b.loadMW - a.loadMW ||
					a.code.localeCompare(b.code),
			);

		const picked: TPlannedSlot["feeders"] = [];
		let shedCentiMW = 0;

		for (const feeder of pool) {
			if (shedCentiMW >= deficit) {
				break;
			}

			picked.push({ ...feeder, shedMinutesBefore: shed.get(feeder.id) ?? 0 });
			shedCentiMW += toCentiMW(feeder.loadMW);
		}

		for (const feeder of picked) {
			shed.set(feeder.id, (shed.get(feeder.id) ?? 0) + slotMinutes);
			day.set(feeder.id, (day.get(feeder.id) ?? 0) + slotMinutes);
			occupied.get(feeder.id)?.push(slot);
		}

		return {
			startTime: slot.startTime,
			endTime: slot.endTime,
			feeders: picked,
			shedMW: shedCentiMW / 100,
			unmetMW: Math.max(0, deficit - shedCentiMW) / 100,
		};
	});
};
