import httpStatus from "http-status";
import { Prisma } from "../../../generated/prisma/client";
import {
	AuditAction,
	OutageStatus,
	ReportStatus,
	Role,
	type ScheduleType,
	UserStatus,
} from "../../../generated/prisma/enums";
import type {
	OutageReportSelect,
	OutageSelect,
	OutageTimelineSelect,
	OutageWhereInput,
} from "../../../generated/prisma/models";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { createAuditLog } from "../../utils/auditLog";
import { CACHE_KEYS, cacheDel } from "../../utils/cache";
import {
	LOCKING_TRANSACTION_OPTIONS,
	lockFeeders,
} from "../../utils/feederLock";
import { buildMeta, paginationHelper } from "../../utils/paginationHelper";
import { diffMinutes, toDhakaTimeString } from "../../utils/time";
import { phaseWhere } from "../schedule/schedule.utils";
import {
	OPEN_OUTAGE_STATUSES,
	OUTAGE_OUTCOME,
	OUTAGE_SORTABLE_FIELDS,
	OUTAGE_TRANSITIONS,
	TRANSITION_ROLE,
} from "./outage.constant";
import type {
	ICreateOutagePayload,
	IOutageListQuery,
	IUpdateOutageStatusPayload,
} from "./outage.interface";
import { canTransition, computeOutagePriority } from "./outage.utils";

const outageSelect = {
	id: true,
	status: true,
	priority: true,
	description: true,
	reportCount: true,
	startedAt: true,
	assignedAt: true,
	resolvedAt: true,
	durationMinutes: true,
	resolutionNote: true,
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
	technician: {
		select: {
			id: true,
			contactNumber: true,
			user: { select: { id: true, name: true } },
		},
	},
} satisfies OutageSelect;

const reportSelect = {
	id: true,
	status: true,
	description: true,
	createdAt: true,
} satisfies OutageReportSelect;

const timelineSelect = {
	id: true,
	fromStatus: true,
	toStatus: true,
	note: true,
	createdAt: true,
} satisfies OutageTimelineSelect;

const staffTimelineSelect = {
	...timelineSelect,
	changedBy: { select: { id: true, name: true, role: true } },
} satisfies OutageTimelineSelect;

const SCHEDULE_LABEL: Record<ScheduleType, string> = {
	LOAD_SHEDDING: "Scheduled load shedding",
	MAINTENANCE: "Scheduled maintenance",
};

// Customer intake (Requirements §6.1). A report ends in exactly one of three
// outcomes: explained by a running schedule, linked to the outage that is
// already open on the feeder, or a new outage.
const reportOutage = async (
	payload: ICreateOutagePayload,
	user: RequestUser,
	ip?: string,
) => {
	const { description } = payload;

	if (payload.feederId) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"feederId can only be sent by an admin. Your feeder is taken from your profile",
			[{ path: "feederId", message: "Not allowed for customers" }],
		);
	}

	const customer = await prisma.customer.findUnique({
		where: { userId: user.userId },
		select: {
			id: true,
			area: {
				select: {
					id: true,
					isDeleted: true,
					feeder: { select: { id: true, priority: true, isDeleted: true } },
				},
			},
		},
	});

	if (!customer) {
		throw new AppError(httpStatus.NOT_FOUND, "Customer profile not found");
	}

	if (
		!customer.area ||
		customer.area.isDeleted ||
		customer.area.feeder.isDeleted
	) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"Set your area in your profile (PATCH /users/me) before reporting an outage",
		);
	}

	const { area } = customer;
	const { feeder } = area;
	const actor = { userId: user.userId, role: user.role };

	const result = await prisma.$transaction(async (tx) => {
		// Every report for this feeder queues up behind this lock. That is what
		// guarantees "one open outage per feeder": two neighbours reporting at
		// the same moment cannot both find "no open outage" and both create one.
		await lockFeeders(tx, [feeder.id]);

		const openReport = await tx.outageReport.findFirst({
			where: { customerId: customer.id, status: ReportStatus.OPEN },
			select: { id: true },
		});

		if (openReport) {
			throw new AppError(
				httpStatus.CONFLICT,
				"You already have an open outage report. It will be closed when the outage is resolved",
			);
		}

		// 1. A published schedule is running right now: the cut is expected.
		const ongoingSchedule = await tx.schedule.findFirst({
			where: { feederId: feeder.id, ...phaseWhere("ONGOING") },
			orderBy: { endTime: "desc" },
			select: {
				id: true,
				type: true,
				startTime: true,
				endTime: true,
				reason: true,
			},
		});

		if (ongoingSchedule) {
			// Asking again during the same schedule gets the same answer
			// without piling up identical rows.
			const earlierReport = await tx.outageReport.findFirst({
				where: {
					customerId: customer.id,
					scheduleId: ongoingSchedule.id,
					status: ReportStatus.EXPLAINED,
				},
				select: reportSelect,
			});

			const report =
				earlierReport ??
				(await tx.outageReport.create({
					data: {
						status: ReportStatus.EXPLAINED,
						description,
						customerId: customer.id,
						areaId: area.id,
						scheduleId: ongoingSchedule.id,
					},
					select: reportSelect,
				}));

			return {
				outcome: OUTAGE_OUTCOME.EXPLAINED_BY_SCHEDULE,
				isNew: !earlierReport,
				explanation: `${SCHEDULE_LABEL[ongoingSchedule.type]} until ${toDhakaTimeString(ongoingSchedule.endTime)}. No outage was opened`,
				report,
				schedule: ongoingSchedule,
			};
		}

		const openOutage = await tx.outage.findFirst({
			where: {
				feederId: feeder.id,
				status: { in: [...OPEN_OUTAGE_STATUSES] },
			},
			select: { id: true, priority: true },
		});

		// 2. The feeder already has an open outage: attach this report to it.
		if (openOutage) {
			// Atomic increment, then the priority is recomputed from the new count.
			const counted = await tx.outage.update({
				where: { id: openOutage.id },
				data: { reportCount: { increment: 1 } },
				select: { reportCount: true },
			});
			const priority = computeOutagePriority(
				feeder.priority,
				counted.reportCount,
			);

			if (priority !== openOutage.priority) {
				await tx.outage.update({
					where: { id: openOutage.id },
					data: { priority },
				});

				await createAuditLog(tx, {
					actor,
					action: AuditAction.UPDATE,
					entityType: "Outage",
					entityId: openOutage.id,
					before: { priority: openOutage.priority },
					after: {
						priority,
						reportCount: counted.reportCount,
						reason: "Escalated by the number of customer reports",
					},
					ip,
				});
			}

			const report = await tx.outageReport.create({
				data: {
					description,
					customerId: customer.id,
					areaId: area.id,
					outageId: openOutage.id,
				},
				select: reportSelect,
			});

			const outage = await tx.outage.findUniqueOrThrow({
				where: { id: openOutage.id },
				select: outageSelect,
			});

			return {
				outcome: OUTAGE_OUTCOME.LINKED_TO_EXISTING_OUTAGE,
				isNew: true,
				explanation:
					"This outage has already been reported. Your report was added to it",
				report,
				outage,
			};
		}

		// 3. Nothing explains the cut yet: open a new outage with this report.
		const created = await tx.outage.create({
			data: {
				priority: computeOutagePriority(feeder.priority, 1),
				description,
				reportCount: 1,
				feederId: feeder.id,
				timeline: {
					create: {
						toStatus: OutageStatus.REPORTED,
						note: description,
						changedById: user.userId,
					},
				},
				reports: {
					create: {
						description,
						customerId: customer.id,
						areaId: area.id,
					},
				},
			},
			select: { ...outageSelect, reports: { select: reportSelect } },
		});
		const { reports, ...outage } = created;

		await createAuditLog(tx, {
			actor,
			action: AuditAction.CREATE,
			entityType: "Outage",
			entityId: outage.id,
			after: {
				status: outage.status,
				priority: outage.priority,
				feederId: feeder.id,
				feederCode: outage.feeder.code,
				source: "CUSTOMER_REPORT",
			},
			ip,
		});

		return {
			outcome: OUTAGE_OUTCOME.NEW_OUTAGE_CREATED,
			isNew: true,
			explanation: "Outage reported. A technician will be assigned shortly",
			report: reports[0],
			outage,
		};
	}, LOCKING_TRANSACTION_OPTIONS);

	// Open-outage counts on the dashboard have changed.
	await cacheDel(CACHE_KEYS.adminStats);

	return result;
};

// An admin (control room) logs an incident directly on a feeder.
const createIncident = async (
	payload: ICreateOutagePayload,
	user: RequestUser,
	ip?: string,
) => {
	const { description, feederId } = payload;

	if (!feederId) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"feederId is required to create an outage as an admin",
			[{ path: "feederId", message: "feederId is required" }],
		);
	}

	const outage = await prisma.$transaction(async (tx) => {
		await lockFeeders(tx, [feederId]);

		const feeder = await tx.feeder.findFirst({
			where: { id: feederId, isDeleted: false },
			select: { id: true, code: true, priority: true },
		});

		if (!feeder) {
			throw new AppError(httpStatus.NOT_FOUND, "Feeder not found", [
				{ path: "feederId", message: "Feeder not found" },
			]);
		}

		const openOutage = await tx.outage.findFirst({
			where: { feederId, status: { in: [...OPEN_OUTAGE_STATUSES] } },
			select: { id: true, status: true },
		});

		if (openOutage) {
			throw new AppError(
				httpStatus.CONFLICT,
				`Feeder ${feeder.code} already has an open outage (${openOutage.status})`,
				[{ path: "feederId", message: `Open outage id: ${openOutage.id}` }],
			);
		}

		const created = await tx.outage.create({
			data: {
				priority: computeOutagePriority(feeder.priority, 0),
				description,
				feederId,
				timeline: {
					create: {
						toStatus: OutageStatus.REPORTED,
						note: description,
						changedById: user.userId,
					},
				},
			},
			select: outageSelect,
		});

		await createAuditLog(tx, {
			actor: { userId: user.userId, role: user.role },
			action: AuditAction.CREATE,
			entityType: "Outage",
			entityId: created.id,
			after: {
				status: created.status,
				priority: created.priority,
				feederId,
				feederCode: feeder.code,
				source: "ADMIN_INCIDENT",
			},
			ip,
		});

		return created;
	}, LOCKING_TRANSACTION_OPTIONS);

	await cacheDel(CACHE_KEYS.adminStats);

	return {
		outcome: OUTAGE_OUTCOME.NEW_OUTAGE_CREATED,
		isNew: true,
		explanation: "Outage created successfully",
		outage,
	};
};

const createOutage = async (
	payload: ICreateOutagePayload,
	user: RequestUser,
	ip?: string,
) => {
	if (user.role === Role.CUSTOMER) {
		return reportOutage(payload, user, ip);
	}

	return createIncident(payload, user, ip);
};

// Admin: every outage. Technician: the ones assigned to them. Customer: the
// ones they reported. The filters then narrow that set further.
const getOutages = async (query: IOutageListQuery, user: RequestUser) => {
	const { page, limit, skip, sortBy, sortOrder } = paginationHelper(
		query,
		OUTAGE_SORTABLE_FIELDS,
	);

	const andConditions: OutageWhereInput[] = [];
	const isCustomer = user.role === Role.CUSTOMER;

	if (user.role === Role.TECHNICIAN) {
		andConditions.push({ technician: { userId: user.userId } });
	}

	if (isCustomer) {
		andConditions.push({
			reports: { some: { customer: { userId: user.userId } } },
		});
	}

	if (query.status) {
		andConditions.push({ status: query.status });
	}

	if (query.priority) {
		andConditions.push({ priority: query.priority });
	}

	if (query.feederId) {
		andConditions.push({ feederId: query.feederId });
	}

	if (query.zoneId) {
		andConditions.push({ feeder: { substation: { zoneId: query.zoneId } } });
	}

	if (query.from) {
		andConditions.push({ startedAt: { gte: query.from } });
	}

	if (query.to) {
		andConditions.push({ startedAt: { lt: query.to } });
	}

	const where: OutageWhereInput = { AND: andConditions };

	const [outages, total] = await prisma.$transaction([
		prisma.outage.findMany({
			where,
			skip,
			take: limit,
			orderBy: [{ [sortBy]: sortOrder }, { id: "asc" }],
			select: {
				...outageSelect,
				timeline: {
					orderBy: { createdAt: "asc" },
					// who made each change is staff information
					select: isCustomer ? timelineSelect : staffTimelineSelect,
				},
				// a customer also gets their own report on each outage
				reports: isCustomer
					? {
							where: { customer: { userId: user.userId } },
							orderBy: { createdAt: "desc" },
							select: reportSelect,
						}
					: false,
			},
		}),
		prisma.outage.count({ where }),
	]);

	return {
		data: outages,
		meta: buildMeta(page, limit, total),
	};
};

// Row locks on the technicians a transition may touch, taken in id order so
// two reassignments that swap the same pair of technicians cannot deadlock.
const lockTechnicians = async (
	tx: Prisma.TransactionClient,
	technicianIds: string[],
): Promise<void> => {
	const sortedIds = [...new Set(technicianIds)].sort();

	if (sortedIds.length === 0) {
		return;
	}

	await tx.$queryRaw`
		SELECT id FROM "technicians"
		WHERE id IN (${Prisma.join(sortedIds)})
		ORDER BY id
		FOR UPDATE`;
};

// Capacity claim (Requirements §6.4): one conditional UPDATE. The check and
// the increment happen in the same statement, so a technician can never be
// pushed past maxActiveJobs, whoever else is assigning at the same moment.
// `now` is passed in rather than using SQL now(), which follows the session
// time zone while every other timestamp in the database is UTC.
const claimTechnician = async (
	tx: Prisma.TransactionClient,
	technicianId: string,
	now: Date,
): Promise<boolean> => {
	const claimed = await tx.$executeRaw`
		UPDATE "technicians"
		SET "activeJobCount" = "activeJobCount" + 1,
			"lastAssignedAt" = ${now},
			"updatedAt" = ${now}
		WHERE id = ${technicianId}
			AND "isAvailable" = true
			AND "activeJobCount" < "maxActiveJobs"`;

	return claimed === 1;
};

const releaseTechnician = async (
	tx: Prisma.TransactionClient,
	technicianId: string,
	now: Date,
): Promise<void> => {
	await tx.$executeRaw`
		UPDATE "technicians"
		SET "activeJobCount" = GREATEST("activeJobCount" - 1, 0),
			"updatedAt" = ${now}
		WHERE id = ${technicianId}`;
};

// A technician the admin named: must exist, be active and work in the zone.
const claimNamedTechnician = async (
	tx: Prisma.TransactionClient,
	technicianId: string,
	zone: { id: string; name: string },
	now: Date,
) => {
	const technician = await tx.technician.findFirst({
		where: { id: technicianId, user: { isDeleted: false } },
		select: {
			id: true,
			zoneId: true,
			user: { select: { name: true, status: true } },
		},
	});

	if (!technician) {
		throw new AppError(httpStatus.NOT_FOUND, "Technician not found", [
			{ path: "technicianId", message: "Technician not found" },
		]);
	}

	if (technician.user.status !== UserStatus.ACTIVE) {
		throw new AppError(
			httpStatus.CONFLICT,
			`${technician.user.name}'s account is blocked`,
			[{ path: "technicianId", message: "Technician is not active" }],
		);
	}

	if (technician.zoneId !== zone.id) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			`${technician.user.name} does not work in the ${zone.name} zone, where this outage is`,
			[{ path: "technicianId", message: "Technician is in another zone" }],
		);
	}

	if (!(await claimTechnician(tx, technician.id, now))) {
		throw new AppError(
			httpStatus.CONFLICT,
			"Technician is off duty or at capacity",
			[{ path: "technicianId", message: "Off duty or at capacity" }],
		);
	}

	return { id: technician.id, name: technician.user.name };
};

// Auto-assign: the eligible technician in the zone with the fewest active
// jobs, and among those the one who has waited longest since their last job.
const claimBestTechnician = async (
	tx: Prisma.TransactionClient,
	zone: { id: string; name: string },
	excludeTechnicianId: string | null,
	now: Date,
) => {
	const candidates = await tx.technician.findMany({
		where: {
			zoneId: zone.id,
			isAvailable: true,
			user: { status: UserStatus.ACTIVE, isDeleted: false },
			...(excludeTechnicianId && { id: { not: excludeTechnicianId } }),
		},
		orderBy: [
			{ activeJobCount: "asc" },
			{ lastAssignedAt: { sort: "asc", nulls: "first" } },
			{ id: "asc" },
		],
		select: { id: true, user: { select: { name: true } } },
	});

	// The claim itself decides who still has capacity.
	for (const candidate of candidates) {
		if (await claimTechnician(tx, candidate.id, now)) {
			return { id: candidate.id, name: candidate.user.name };
		}
	}

	throw new AppError(
		httpStatus.CONFLICT,
		`No technician available in the ${zone.name} zone`,
	);
};

// The outage state machine (Requirements §6.3). Every move writes a timeline
// row and an audit row in the same transaction as its side effects.
const updateOutageStatus = async (
	id: string,
	payload: IUpdateOutageStatusPayload,
	user: RequestUser,
	ip?: string,
) => {
	const { status: toStatus, technicianId, note } = payload;

	if (TRANSITION_ROLE[toStatus] !== user.role) {
		throw new AppError(
			httpStatus.FORBIDDEN,
			`Only ${TRANSITION_ROLE[toStatus] === Role.ADMIN ? "an admin" : "the assigned technician"} can move an outage to ${toStatus}`,
		);
	}

	const existing = await prisma.outage.findUnique({
		where: { id },
		select: { feederId: true },
	});

	if (!existing) {
		throw new AppError(httpStatus.NOT_FOUND, "Outage not found");
	}

	const now = new Date();

	const result = await prisma.$transaction(async (tx) => {
		// The same lock customer intake takes. Two moves on one outage run one
		// after the other, and a report cannot attach itself to an outage that
		// is being resolved or cancelled at that moment.
		await lockFeeders(tx, [existing.feederId]);

		// Read again under the lock: this is the status the move starts from.
		const outage = await tx.outage.findUniqueOrThrow({
			where: { id },
			select: {
				status: true,
				startedAt: true,
				technicianId: true,
				technician: {
					select: { userId: true, user: { select: { name: true } } },
				},
				feeder: {
					select: {
						substation: {
							select: { zone: { select: { id: true, name: true } } },
						},
					},
				},
			},
		});

		if (
			user.role === Role.TECHNICIAN &&
			outage.technician?.userId !== user.userId
		) {
			throw new AppError(
				httpStatus.FORBIDDEN,
				"This outage is not assigned to you",
			);
		}

		if (!canTransition(outage.status, toStatus)) {
			throw new AppError(
				httpStatus.BAD_REQUEST,
				`An outage that is ${outage.status} cannot be moved to ${toStatus}`,
				[
					{
						path: "status",
						message:
							OUTAGE_TRANSITIONS[outage.status].length > 0
								? `Allowed: ${OUTAGE_TRANSITIONS[outage.status].join(", ")}`
								: `${outage.status} is final`,
					},
				],
			);
		}

		const { zone } = outage.feeder.substation;
		const previousTechnicianId = outage.technicianId;
		const previousTechnicianName = outage.technician?.user.name;

		let assigned: { id: string; name: string } | undefined;
		let message: string;
		let timelineNote = note;

		if (toStatus === OutageStatus.ASSIGNED) {
			if (technicianId && technicianId === previousTechnicianId) {
				throw new AppError(
					httpStatus.CONFLICT,
					`This outage is already assigned to ${previousTechnicianName}`,
					[{ path: "technicianId", message: "Already assigned" }],
				);
			}

			const zoneTechnicians = technicianId
				? [{ id: technicianId }]
				: await tx.technician.findMany({
						where: { zoneId: zone.id },
						select: { id: true },
					});

			await lockTechnicians(tx, [
				...zoneTechnicians.map((technician) => technician.id),
				...(previousTechnicianId ? [previousTechnicianId] : []),
			]);

			assigned = technicianId
				? await claimNamedTechnician(tx, technicianId, zone, now)
				: await claimBestTechnician(tx, zone, previousTechnicianId, now);

			// Reassignment: the previous technician gets the slot back.
			if (previousTechnicianId) {
				await releaseTechnician(tx, previousTechnicianId, now);
			}

			const auto = technicianId ? "" : "auto-";
			message = previousTechnicianId
				? `Outage ${auto}reassigned from ${previousTechnicianName} to ${assigned.name}`
				: `Outage ${auto}assigned to ${assigned.name}`;
			timelineNote = note ? `${message}. ${note}` : message;

			await tx.outage.update({
				where: { id },
				data: {
					status: OutageStatus.ASSIGNED,
					technicianId: assigned.id,
					assignedAt: now,
				},
			});
		} else if (toStatus === OutageStatus.IN_PROGRESS) {
			message = "Work on the outage has started";

			await tx.outage.update({
				where: { id },
				data: { status: OutageStatus.IN_PROGRESS },
			});
		} else {
			const isResolved = toStatus === OutageStatus.RESOLVED;
			message = `Outage ${isResolved ? "resolved" : "cancelled"} successfully`;

			await tx.outage.update({
				where: { id },
				data: isResolved
					? {
							status: OutageStatus.RESOLVED,
							resolvedAt: now,
							durationMinutes: Math.max(diffMinutes(outage.startedAt, now), 0),
							resolutionNote: note,
						}
					: { status: OutageStatus.CANCELLED },
			});

			// The technician stays on the outage as its history, but the job no
			// longer counts against their capacity.
			if (previousTechnicianId) {
				await releaseTechnician(tx, previousTechnicianId, now);
			}

			// Closing the reports lets those customers report again later.
			await tx.outageReport.updateMany({
				where: { outageId: id, status: ReportStatus.OPEN },
				data: {
					status: isResolved ? ReportStatus.RESOLVED : ReportStatus.REJECTED,
				},
			});
		}

		await tx.outageTimeline.create({
			data: {
				outageId: id,
				fromStatus: outage.status,
				toStatus,
				note: timelineNote,
				changedById: user.userId,
			},
		});

		await createAuditLog(tx, {
			actor: { userId: user.userId, role: user.role },
			action: AuditAction.STATUS_CHANGE,
			entityType: "Outage",
			entityId: id,
			before: {
				status: outage.status,
				technicianId: previousTechnicianId,
			},
			after: {
				status: toStatus,
				technicianId: assigned?.id ?? previousTechnicianId,
				...(assigned && {
					technicianName: assigned.name,
					autoAssigned: !technicianId,
				}),
				...(note && { note }),
			},
			ip,
		});

		const updated = await tx.outage.findUniqueOrThrow({
			where: { id },
			select: {
				...outageSelect,
				timeline: {
					orderBy: { createdAt: "asc" },
					select: staffTimelineSelect,
				},
			},
		});

		return { message, outage: updated };
	}, LOCKING_TRANSACTION_OPTIONS);

	// Open counts, MTTR and technician workload on the dashboard have changed.
	await cacheDel(CACHE_KEYS.adminStats);

	return result;
};

export const OutageServices = {
	createOutage,
	getOutages,
	updateOutageStatus,
};
