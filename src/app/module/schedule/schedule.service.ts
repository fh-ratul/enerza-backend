import httpStatus from "http-status";
import type { Prisma } from "../../../generated/prisma/client";
import {
	AuditAction,
	FeederPriority,
	ScheduleType,
} from "../../../generated/prisma/enums";
import type { ScheduleSelect } from "../../../generated/prisma/models";
import type { TErrorSource } from "../../interfaces";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { createAuditLogs } from "../../utils/auditLog";
import { CACHE_KEYS, cacheDel } from "../../utils/cache";
import {
	LOCKING_TRANSACTION_OPTIONS,
	lockFeeders,
} from "../../utils/feederLock";
import {
	dhakaDayRange,
	overlapMinutes,
	toDhakaDateString,
} from "../../utils/time";
import {
	ACTIVE_SCHEDULE_STATUSES,
	DAILY_SHEDDING_CAP_MINUTES,
} from "./schedule.constant";
import type { ICreateSchedulePayload } from "./schedule.interface";
import { formatWindow, withPhase } from "./schedule.utils";

const scheduleSelect = {
	id: true,
	type: true,
	status: true,
	startTime: true,
	endTime: true,
	reason: true,
	batchId: true,
	cancelReason: true,
	createdAt: true,
	updatedAt: true,
	feeder: {
		select: {
			id: true,
			name: true,
			code: true,
			priority: true,
			substation: {
				select: {
					id: true,
					name: true,
					zone: { select: { id: true, name: true, code: true } },
				},
			},
		},
	},
	createdBy: { select: { id: true, name: true } },
} satisfies ScheduleSelect;

type TFeederForSchedule = {
	id: string;
	code: string;
	priority: FeederPriority;
	isActive: boolean;
};

type TConflictCheck = {
	feeders: Pick<TFeederForSchedule, "id" | "code">[];
	type: ScheduleType;
	startTime: Date;
	endTime: Date;
	// when re-checking an existing schedule (publish), ignore the schedule itself
	excludeScheduleId?: string;
	pathFor: (feederId: string) => string;
};

const TYPE_LABEL: Record<ScheduleType, string> = {
	LOAD_SHEDDING: "load-shedding",
	MAINTENANCE: "maintenance",
};

// CRITICAL feeders (hospitals, water pumps) are never load-shed; they can
// only get MAINTENANCE schedules.
const getFeederRuleErrors = (
	type: ScheduleType,
	feeders: TFeederForSchedule[],
	pathFor: (feederId: string) => string,
) => {
	if (type !== ScheduleType.LOAD_SHEDDING) {
		return { critical: [], inactive: [] };
	}

	const critical: TErrorSource[] = [];
	const inactive: TErrorSource[] = [];

	for (const feeder of feeders) {
		if (feeder.priority === FeederPriority.CRITICAL) {
			critical.push({
				path: pathFor(feeder.id),
				message: `Feeder ${feeder.code} is CRITICAL and can never be load-shed`,
			});
		} else if (!feeder.isActive) {
			inactive.push({
				path: pathFor(feeder.id),
				message: `Feeder ${feeder.code} is inactive`,
			});
		}
	}

	return { critical, inactive };
};

// Overlap and daily-cap checks for a window on a set of feeders.
// MUST run inside a transaction that already holds the feeder row locks:
// that is what stops two concurrent requests from both passing these checks.
const findScheduleConflicts = async (
	tx: Prisma.TransactionClient,
	{
		feeders,
		type,
		startTime,
		endTime,
		excludeScheduleId,
		pathFor,
	}: TConflictCheck,
): Promise<TErrorSource[]> => {
	const feederIds = feeders.map((feeder) => feeder.id);
	const excludeSelf = excludeScheduleId
		? { id: { not: excludeScheduleId } }
		: {};
	const errors: TErrorSource[] = [];
	const clashedFeederIds = new Set<string>();

	// 1. Overlap: a.start < b.end AND a.end > b.start, against DRAFT/PUBLISHED rows.
	const clashes = await tx.schedule.findMany({
		where: {
			feederId: { in: feederIds },
			status: { in: [...ACTIVE_SCHEDULE_STATUSES] },
			startTime: { lt: endTime },
			endTime: { gt: startTime },
			...excludeSelf,
		},
		orderBy: { startTime: "asc" },
		select: {
			feederId: true,
			type: true,
			status: true,
			startTime: true,
			endTime: true,
		},
	});

	for (const feeder of feeders) {
		const clash = clashes.find((schedule) => schedule.feederId === feeder.id);

		if (clash) {
			clashedFeederIds.add(feeder.id);
			errors.push({
				path: pathFor(feeder.id),
				message: `Feeder ${feeder.code} already has a ${clash.status} ${TYPE_LABEL[clash.type]} schedule at ${formatWindow(clash.startTime, clash.endTime)}`,
			});
		}
	}

	if (type !== ScheduleType.LOAD_SHEDDING) {
		return errors;
	}

	// 2. Daily cap: load-shedding minutes per Dhaka calendar day. A window that
	//    crosses midnight is split between the two days it touches.
	const days = new Set([
		toDhakaDateString(startTime),
		toDhakaDateString(new Date(endTime.getTime() - 1)),
	]);

	for (const day of days) {
		const range = dhakaDayRange(day);
		const newMinutes = overlapMinutes(
			startTime,
			endTime,
			range.start,
			range.end,
		);

		const sameDay = await tx.schedule.findMany({
			where: {
				feederId: { in: feederIds },
				type: ScheduleType.LOAD_SHEDDING,
				status: { in: [...ACTIVE_SCHEDULE_STATUSES] },
				startTime: { lt: range.end },
				endTime: { gt: range.start },
				...excludeSelf,
			},
			select: { feederId: true, startTime: true, endTime: true },
		});

		for (const feeder of feeders) {
			if (clashedFeederIds.has(feeder.id)) {
				continue;
			}

			const usedMinutes = sameDay
				.filter((schedule) => schedule.feederId === feeder.id)
				.reduce(
					(total, schedule) =>
						total +
						overlapMinutes(
							schedule.startTime,
							schedule.endTime,
							range.start,
							range.end,
						),
					0,
				);

			if (usedMinutes + newMinutes > DAILY_SHEDDING_CAP_MINUTES) {
				errors.push({
					path: pathFor(feeder.id),
					message: `Feeder ${feeder.code} already has ${usedMinutes} of its ${DAILY_SHEDDING_CAP_MINUTES} daily load-shedding minutes on ${day}; ${newMinutes} more would exceed the cap`,
				});
			}
		}
	}

	return errors;
};

const invalidateCustomerSchedules = (feederIds: string[]) =>
	cacheDel(
		...feederIds.map((feederId) => CACHE_KEYS.customerSchedules(feederId)),
	);

const createSchedules = async (
	payload: ICreateSchedulePayload,
	actor: RequestUser,
	ip?: string,
) => {
	const { type, feederIds, startTime, endTime, reason } = payload;
	const pathFor = (feederId: string) =>
		`feederIds.${feederIds.indexOf(feederId)}`;

	const schedules = await prisma.$transaction(async (tx) => {
		// From here until commit, no other request can add or publish a
		// schedule on these feeders.
		await lockFeeders(tx, feederIds);

		const feeders = await tx.feeder.findMany({
			where: { id: { in: feederIds }, isDeleted: false },
			select: { id: true, code: true, priority: true, isActive: true },
		});
		const foundIds = new Set(feeders.map((feeder) => feeder.id));
		const missingIds = feederIds.filter((feederId) => !foundIds.has(feederId));

		if (missingIds.length) {
			throw new AppError(
				httpStatus.NOT_FOUND,
				"One or more feeders were not found",
				missingIds.map((feederId) => ({
					path: pathFor(feederId),
					message: "Feeder not found",
				})),
			);
		}

		const ruleErrors = getFeederRuleErrors(type, feeders, pathFor);

		if (ruleErrors.critical.length) {
			throw new AppError(
				httpStatus.BAD_REQUEST,
				"CRITICAL feeders can only get MAINTENANCE schedules",
				ruleErrors.critical,
			);
		}

		if (ruleErrors.inactive.length) {
			throw new AppError(
				httpStatus.CONFLICT,
				"Inactive feeders cannot be load-shed",
				ruleErrors.inactive,
			);
		}

		const conflicts = await findScheduleConflicts(tx, {
			feeders,
			type,
			startTime,
			endTime,
			pathFor,
		});

		if (conflicts.length) {
			throw new AppError(
				httpStatus.CONFLICT,
				"The schedule conflicts with existing schedules",
				conflicts,
			);
		}

		const createdIds = await tx.schedule.createManyAndReturn({
			data: feederIds.map((feederId) => ({
				type,
				startTime,
				endTime,
				reason,
				feederId,
				createdById: actor.userId,
			})),
			select: { id: true },
		});

		const created = await tx.schedule.findMany({
			where: { id: { in: createdIds.map((schedule) => schedule.id) } },
			orderBy: { feeder: { code: "asc" } },
			select: scheduleSelect,
		});

		await createAuditLogs(
			tx,
			created.map((schedule) => ({
				actor: { userId: actor.userId, role: actor.role },
				action: AuditAction.CREATE,
				entityType: "Schedule" as const,
				entityId: schedule.id,
				after: {
					type: schedule.type,
					status: schedule.status,
					startTime: schedule.startTime,
					endTime: schedule.endTime,
					feederId: schedule.feeder.id,
					feederCode: schedule.feeder.code,
				},
				ip,
			})),
		);

		return created;
	}, LOCKING_TRANSACTION_OPTIONS);

	await invalidateCustomerSchedules(feederIds);

	return schedules.map((schedule) => withPhase(schedule));
};

export const ScheduleServices = {
	createSchedules,
};
