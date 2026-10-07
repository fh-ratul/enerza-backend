import {
	BillStatus,
	OutagePriority,
	OutageStatus,
	PaymentStatus,
	Role,
	ScheduleType,
	UserStatus,
} from "../../../generated/prisma/enums";
import { prisma } from "../../lib/prisma";
import { CACHE_KEYS, CACHE_TTL, cacheGet, cacheSet } from "../../utils/cache";
import { addDays, dhakaMonthRange, toDhakaMonthString } from "../../utils/time";
import { OPEN_OUTAGE_STATUSES } from "../outage/outage.constant";
import { phaseWhere } from "../schedule/schedule.utils";
import { STATS_WINDOW_DAYS } from "./admin.constant";
import { computeReliability, toCountMap } from "./admin.utils";

const toMoney = (value: { toFixed(decimals: number): string } | null): string =>
	value?.toFixed(2) ?? "0.00";

const buildStats = async () => {
	const now = new Date();
	const windowStart = addDays(now, -STATS_WINDOW_DAYS);
	const month = toDhakaMonthString(now);
	const monthRange = dhakaMonthRange(month);

	const openOutageWhere = { status: { in: [...OPEN_OUTAGE_STATUSES] } };
	const resolvedInWindowWhere = {
		status: OutageStatus.RESOLVED,
		resolvedAt: { gte: windowStart },
	};

	const [
		usersByRoleAndStatus,
		outagesByStatus,
		outagesByPriority,
		resolvedOutages,
		mttr,
		ongoingLoadShedding,
		zones,
		areas,
		revenue,
		unpaid,
		overdue,
	] = await Promise.all([
		prisma.user.groupBy({
			by: ["role", "status"],
			where: { isDeleted: false },
			_count: { _all: true },
		}),
		prisma.outage.groupBy({
			by: ["status"],
			where: openOutageWhere,
			_count: { _all: true },
		}),
		prisma.outage.groupBy({
			by: ["priority"],
			where: openOutageWhere,
			_count: { _all: true },
		}),
		prisma.outage.findMany({
			where: resolvedInWindowWhere,
			select: { feederId: true, durationMinutes: true },
		}),
		prisma.outage.aggregate({
			where: resolvedInWindowWhere,
			_avg: { durationMinutes: true },
		}),
		prisma.schedule.findMany({
			where: {
				type: ScheduleType.LOAD_SHEDDING,
				...phaseWhere("ONGOING", now),
			},
			orderBy: { endTime: "asc" },
			select: {
				id: true,
				startTime: true,
				endTime: true,
				feeder: {
					select: { id: true, name: true, code: true, loadMW: true },
				},
			},
		}),
		prisma.distributionZone.findMany({
			orderBy: { code: "asc" },
			select: {
				id: true,
				name: true,
				code: true,
				substations: {
					select: {
						feeders: { where: { isDeleted: false }, select: { id: true } },
					},
				},
			},
		}),
		// customers served per area; summed per feeder below
		prisma.area.findMany({
			where: { isDeleted: false, feeder: { isDeleted: false } },
			select: {
				feederId: true,
				_count: {
					select: { customers: { where: { user: { isDeleted: false } } } },
				},
			},
		}),
		// A payment that has to be refunded is not revenue.
		prisma.payment.aggregate({
			where: {
				status: PaymentStatus.PAID,
				requiresRefund: false,
				paidAt: { gte: monthRange.start, lt: monthRange.end },
			},
			_sum: { amount: true },
			_count: { _all: true },
		}),
		prisma.bill.aggregate({
			where: { status: BillStatus.UNPAID },
			_sum: { totalAmount: true },
			_count: { _all: true },
		}),
		prisma.bill.aggregate({
			where: { status: BillStatus.UNPAID, dueDate: { lt: now } },
			_sum: { totalAmount: true },
			_count: { _all: true },
		}),
	]);

	const customersByFeeder = new Map<string, number>();

	for (const area of areas) {
		customersByFeeder.set(
			area.feederId,
			(customersByFeeder.get(area.feederId) ?? 0) + area._count.customers,
		);
	}

	const byStatus = toCountMap(
		OPEN_OUTAGE_STATUSES,
		outagesByStatus.map((row) => ({
			key: row.status as (typeof OPEN_OUTAGE_STATUSES)[number],
			count: row._count._all,
		})),
	);

	// Summed in hundredths of a MW to avoid float drift.
	const shedCentiMW = ongoingLoadShedding.reduce(
		(total, schedule) =>
			total + Math.round(Number(schedule.feeder.loadMW) * 100),
		0,
	);

	return {
		generatedAt: now,
		windowDays: STATS_WINDOW_DAYS,
		users: {
			total: usersByRoleAndStatus.reduce(
				(total, row) => total + row._count._all,
				0,
			),
			byRole: toCountMap(
				Object.values(Role),
				usersByRoleAndStatus.map((row) => ({
					key: row.role,
					count: row._count._all,
				})),
			),
			blocked: usersByRoleAndStatus
				.filter((row) => row.status === UserStatus.BLOCKED)
				.reduce((total, row) => total + row._count._all, 0),
		},
		outages: {
			open: Object.values(byStatus).reduce((total, count) => total + count, 0),
			byStatus,
			byPriority: toCountMap(
				Object.values(OutagePriority),
				outagesByPriority.map((row) => ({
					key: row.priority,
					count: row._count._all,
				})),
			),
			resolvedInWindow: resolvedOutages.length,
			// mean time to restore, in minutes; null when nothing was resolved
			mttrMinutes:
				mttr._avg.durationMinutes === null
					? null
					: Number(mttr._avg.durationMinutes.toFixed(1)),
		},
		loadShedding: {
			feederCount: new Set(
				ongoingLoadShedding.map((schedule) => schedule.feeder.id),
			).size,
			totalLoadMW: (shedCentiMW / 100).toFixed(2),
			feeders: ongoingLoadShedding.map(({ feeder, ...schedule }) => ({
				scheduleId: schedule.id,
				startTime: schedule.startTime,
				endTime: schedule.endTime,
				feeder: { ...feeder, loadMW: feeder.loadMW.toFixed(2) },
			})),
		},
		reliability: computeReliability(
			zones.map(({ substations, ...zone }) => ({
				...zone,
				feederIds: substations.flatMap((substation) =>
					substation.feeders.map((feeder) => feeder.id),
				),
			})),
			customersByFeeder,
			resolvedOutages,
		),
		billing: {
			month,
			revenueThisMonth: toMoney(revenue._sum.amount),
			paymentsThisMonth: revenue._count._all,
			unpaidTotal: toMoney(unpaid._sum.totalAmount),
			unpaidCount: unpaid._count._all,
			overdueTotal: toMoney(overdue._sum.totalAmount),
			overdueCount: overdue._count._all,
		},
	};
};

type TStats = Awaited<ReturnType<typeof buildStats>>;

// The dashboard is a dozen aggregate queries, so it is cached for 5 minutes.
// Writes that change its numbers (outages, bills, payments) delete the key,
// and `generatedAt` tells the reader how fresh a cached copy is.
const getStats = async () => {
	const cached = await cacheGet<TStats>(CACHE_KEYS.adminStats);

	if (cached) {
		return { stats: cached, fromCache: true };
	}

	const stats = await buildStats();

	await cacheSet(CACHE_KEYS.adminStats, stats, CACHE_TTL.adminStats);

	return { stats, fromCache: false };
};

export const AdminServices = {
	getStats,
};
