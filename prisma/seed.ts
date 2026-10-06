// Idempotent demo data: safe to run any number of times (`npx prisma db seed`).
//
//  - Grid, users and profiles are upserted on their natural keys and never
//    overwritten, so edits made through the API survive a re-seed.
//  - History rows (past schedules, outages) use fixed ids and are only created
//    when missing.
//  - The two "live" demo schedules (one ONGOING, one UPCOMING) are moved to
//    stay relative to the current time, so re-seeding gives a fresh ONGOING
//    schedule for the demo.

import bcrypt from "bcryptjs";
import config from "../src/app/config";
import { prisma } from "../src/app/lib/prisma";
import { BILL_DUE_DAYS } from "../src/app/module/bill/bill.constant";
import {
	calculateBill,
	generateBillNumber,
	paisaToTaka,
} from "../src/app/module/bill/bill.utils";
import {
	addDays,
	addMinutes,
	dhakaDateAtHour,
	dhakaMonthRange,
	toDhakaDateString,
	toDhakaMonthString,
} from "../src/app/utils/time";
import {
	BillStatus,
	ConnectionType,
	FeederPriority,
	OutagePriority,
	OutageStatus,
	ReportStatus,
	Role,
	ScheduleStatus,
	ScheduleType,
	UserStatus,
} from "../src/generated/prisma/enums";

// Shared by the demo technician and customer accounts (documented in the README).
const DEMO_PASSWORD = "Enerza@12345";

// Deterministic, valid UUIDv7-shaped ids so that history rows can be upserted.
const seedId = (n: number) =>
	`0199f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const ZONES = [
	{ code: "DZ-NORTH", name: "Dhaka North" },
	{ code: "DZ-SOUTH", name: "Dhaka South" },
];

const SUBSTATIONS = [
	{
		code: "SS-MIRPUR",
		name: "Mirpur Substation",
		capacityMW: 60,
		zone: "DZ-NORTH",
	},
	{
		code: "SS-UTTARA",
		name: "Uttara Substation",
		capacityMW: 50,
		zone: "DZ-NORTH",
	},
	{
		code: "SS-DHANMONDI",
		name: "Dhanmondi Substation",
		capacityMW: 55,
		zone: "DZ-SOUTH",
	},
	{
		code: "SS-MOTIJHEEL",
		name: "Motijheel Substation",
		capacityMW: 70,
		zone: "DZ-SOUTH",
	},
];

const FEEDERS = [
	{
		code: "FD-MIR-01",
		name: "Mirpur-10 Feeder",
		loadMW: 8.5,
		priority: FeederPriority.NORMAL,
		substation: "SS-MIRPUR",
		areas: [
			{ code: "AR-MIR-10", name: "Mirpur-10" },
			{ code: "AR-MIR-11", name: "Mirpur-11" },
		],
	},
	{
		code: "FD-MIR-02",
		name: "Pallabi Feeder",
		loadMW: 6,
		priority: FeederPriority.LOW,
		substation: "SS-MIRPUR",
		areas: [
			{ code: "AR-PALLABI", name: "Pallabi" },
			{ code: "AR-RUPNAGAR", name: "Rupnagar" },
		],
	},
	{
		code: "FD-MIR-03",
		name: "Shyamoli Hospital Feeder",
		loadMW: 5,
		priority: FeederPriority.CRITICAL,
		substation: "SS-MIRPUR",
		areas: [{ code: "AR-SHYAMOLI", name: "Shyamoli" }],
	},
	{
		code: "FD-UTT-01",
		name: "Uttara Sector 7 Feeder",
		loadMW: 9,
		priority: FeederPriority.NORMAL,
		substation: "SS-UTTARA",
		areas: [
			{ code: "AR-UTT-S7", name: "Uttara Sector 7" },
			{ code: "AR-UTT-S9", name: "Uttara Sector 9" },
		],
	},
	{
		code: "FD-UTT-02",
		name: "Uttara Airport Road Feeder",
		loadMW: 11.5,
		priority: FeederPriority.HIGH,
		substation: "SS-UTTARA",
		areas: [{ code: "AR-UTT-S1", name: "Uttara Sector 1" }],
	},
	{
		code: "FD-DHN-01",
		name: "Dhanmondi 27 Feeder",
		loadMW: 7.5,
		priority: FeederPriority.NORMAL,
		substation: "SS-DHANMONDI",
		areas: [
			{ code: "AR-DHN-27", name: "Dhanmondi 27" },
			{ code: "AR-LALMATIA", name: "Lalmatia" },
		],
	},
	{
		code: "FD-DHN-02",
		name: "Mohammadpur Feeder",
		loadMW: 4.5,
		priority: FeederPriority.LOW,
		substation: "SS-DHANMONDI",
		areas: [
			{ code: "AR-MOHAMMADPUR", name: "Mohammadpur" },
			{ code: "AR-ADABOR", name: "Adabor" },
		],
	},
	{
		code: "FD-MOT-01",
		name: "Motijheel C/A Feeder",
		loadMW: 12,
		priority: FeederPriority.HIGH,
		substation: "SS-MOTIJHEEL",
		areas: [
			{ code: "AR-MOTIJHEEL", name: "Motijheel C/A" },
			{ code: "AR-DILKUSHA", name: "Dilkusha" },
		],
	},
];

// Published load shedding over the last week: [feeder, days ago, start hour
// (Dhaka), minutes]. Deliberately uneven so the generator's fairness shows:
// in Dhaka North, FD-MIR-01 (120 min) and FD-UTT-01 (0 min) are both NORMAL,
// so the generator must pick FD-UTT-01 first.
const SHEDDING_HISTORY: [string, number, number, number][] = [
	["FD-MIR-02", 6, 19, 60],
	["FD-MIR-02", 5, 19, 60],
	["FD-MIR-02", 4, 20, 60],
	["FD-MIR-02", 2, 19, 60],
	["FD-MIR-02", 1, 18, 60],
	["FD-MIR-01", 5, 20, 60],
	["FD-MIR-01", 2, 20, 60],
	["FD-UTT-02", 3, 19, 60],
	["FD-DHN-02", 4, 19, 90],
	["FD-DHN-01", 6, 20, 60],
	["FD-DHN-01", 3, 20, 60],
	["FD-DHN-01", 1, 19, 60],
];

const RESOLVED_OUTAGES = [
	{
		n: 1,
		feeder: "FD-MIR-01",
		technician: "tech.north@enerza.com",
		reporter: "customer1@enerza.com",
		daysAgo: 12,
		durationMinutes: 95,
		priority: OutagePriority.MEDIUM,
		description: "Blown fuse on the 11 kV line near Mirpur-10 circle",
		resolutionNote: "Replaced the blown fuse and re-energised the line",
	},
	{
		n: 2,
		feeder: "FD-UTT-01",
		technician: "tech.north@enerza.com",
		reporter: null,
		daysAgo: 5,
		durationMinutes: 140,
		priority: OutagePriority.MEDIUM,
		description: "Tree branch fell on the overhead conductor in Sector 7",
		resolutionNote: "Cleared the branch and repaired the conductor",
	},
	{
		n: 3,
		feeder: "FD-DHN-01",
		technician: "tech.south@enerza.com",
		reporter: "customer2@enerza.com",
		daysAgo: 9,
		durationMinutes: 60,
		priority: OutagePriority.MEDIUM,
		description: "Distribution transformer tripped on overload",
		resolutionNote: "Reset the transformer and balanced the load",
	},
	{
		n: 4,
		feeder: "FD-MOT-01",
		technician: "tech.south@enerza.com",
		reporter: null,
		daysAgo: 2,
		durationMinutes: 210,
		priority: OutagePriority.HIGH,
		description: "Underground cable fault near Dilkusha",
		resolutionNote: "Located and jointed the faulty cable section",
	},
];

const main = async () => {
	const now = new Date();
	const today = toDhakaDateString(now);

	// ── Grid ────────────────────────────────────────────────────────────────
	const zoneIds: Record<string, string> = {};

	for (const zone of ZONES) {
		const row = await prisma.distributionZone.upsert({
			where: { code: zone.code },
			update: {},
			create: zone,
		});

		zoneIds[zone.code] = row.id;
	}

	const substationIds: Record<string, string> = {};

	for (const { zone, ...substation } of SUBSTATIONS) {
		const row = await prisma.substation.upsert({
			where: { code: substation.code },
			update: {},
			create: { ...substation, zoneId: zoneIds[zone] },
		});

		substationIds[substation.code] = row.id;
	}

	const feederIds: Record<string, string> = {};
	const areaIds: Record<string, string> = {};

	for (const { substation, areas, ...feeder } of FEEDERS) {
		const row = await prisma.feeder.upsert({
			where: { code: feeder.code },
			update: {},
			create: { ...feeder, substationId: substationIds[substation] },
		});

		feederIds[feeder.code] = row.id;

		for (const area of areas) {
			const areaRow = await prisma.area.upsert({
				where: { code: area.code },
				update: {},
				create: { ...area, feederId: row.id },
			});

			areaIds[area.code] = areaRow.id;
		}
	}

	// ── Users ───────────────────────────────────────────────────────────────
	const adminPassword = await bcrypt.hash(
		config.admin_password,
		config.bcrypt_salt_rounds,
	);
	const demoPassword = await bcrypt.hash(
		DEMO_PASSWORD,
		config.bcrypt_salt_rounds,
	);

	// The env file is the source of truth for the demo admin, so a re-seed
	// also restores its name, password and status.
	const admin = await prisma.user.upsert({
		where: { email: config.admin_email },
		update: {
			name: config.admin_name,
			password: adminPassword,
			role: Role.ADMIN,
			status: UserStatus.ACTIVE,
			isDeleted: false,
			deletedAt: null,
		},
		create: {
			name: config.admin_name,
			email: config.admin_email,
			password: adminPassword,
			role: Role.ADMIN,
		},
	});

	const technicians = [
		{
			email: "tech.north@enerza.com",
			name: "Rafiq Ahmed",
			contactNumber: "01711000001",
			zone: "DZ-NORTH",
		},
		{
			email: "tech.south@enerza.com",
			name: "Salma Khatun",
			contactNumber: "01711000002",
			zone: "DZ-SOUTH",
		},
	];
	const technicianIds: Record<string, string> = {};

	for (const { zone, contactNumber, ...user } of technicians) {
		const row = await prisma.user.upsert({
			where: { email: user.email },
			update: {},
			create: {
				...user,
				password: demoPassword,
				role: Role.TECHNICIAN,
				technician: { create: { contactNumber, zoneId: zoneIds[zone] } },
			},
			select: { technician: { select: { id: true } } },
		});

		if (row.technician) {
			technicianIds[user.email] = row.technician.id;
		}
	}

	const customers = [
		{
			email: "customer1@enerza.com",
			name: "Nusrat Jahan",
			contactNumber: "01811000001",
			address: "House 12, Road 3, Mirpur-10, Dhaka",
			meterNumber: "MTR-100001",
			connectionType: ConnectionType.RESIDENTIAL,
			sanctionedLoadKW: 2,
			area: "AR-MIR-10",
			// Demo bill: readings and how long ago it was issued.
			bill: { previousReading: 1200, currentReading: 1385, issuedDaysAgo: 3 },
		},
		{
			email: "customer2@enerza.com",
			name: "Karim Traders",
			contactNumber: "01811000002",
			address: "Shop 5, Road 27, Dhanmondi, Dhaka",
			meterNumber: "MTR-100002",
			connectionType: ConnectionType.COMMERCIAL,
			sanctionedLoadKW: 5,
			area: "AR-DHN-27",
			// Issued 20 days ago, so it is past its 14-day due date (overdue).
			bill: { previousReading: 5400, currentReading: 5920, issuedDaysAgo: 20 },
		},
	];
	const customerIds: Record<string, string> = {};

	for (const { area, bill, email, name, ...profile } of customers) {
		const row = await prisma.user.upsert({
			where: { email },
			update: {},
			create: {
				name,
				email,
				password: demoPassword,
				role: Role.CUSTOMER,
				customer: {
					create: {
						...profile,
						areaId: areaIds[area],
						lastReading: bill.currentReading,
					},
				},
			},
			select: { customer: { select: { id: true } } },
		});

		if (row.customer) {
			customerIds[email] = row.customer.id;
		}
	}

	// ── Schedule history (completed load shedding) ──────────────────────────
	for (const [index, entry] of SHEDDING_HISTORY.entries()) {
		const [feeder, daysAgo, startHour, minutes] = entry;
		const startTime = dhakaDateAtHour(
			toDhakaDateString(addDays(now, -daysAgo)),
			startHour,
		);

		await prisma.schedule.upsert({
			where: { id: seedId(index + 1) },
			update: {},
			create: {
				id: seedId(index + 1),
				type: ScheduleType.LOAD_SHEDDING,
				status: ScheduleStatus.PUBLISHED,
				startTime,
				endTime: addMinutes(startTime, minutes),
				reason: "Evening peak generation shortfall",
				feederId: feederIds[feeder],
				createdById: admin.id,
			},
		});
	}

	// ── Live demo schedules (re-timed on every run) ─────────────────────────
	const ongoing = {
		type: ScheduleType.LOAD_SHEDDING,
		status: ScheduleStatus.PUBLISHED,
		startTime: addMinutes(now, -30),
		endTime: addMinutes(now, 90),
		reason: "Generation shortfall at the Mirpur grid substation",
		cancelReason: null,
	};

	await prisma.schedule.upsert({
		where: { id: seedId(100) },
		update: ongoing,
		create: {
			...ongoing,
			id: seedId(100),
			feederId: feederIds["FD-MIR-01"],
			createdById: admin.id,
		},
	});

	const tomorrow = toDhakaDateString(addDays(now, 1));
	const upcoming = {
		type: ScheduleType.LOAD_SHEDDING,
		status: ScheduleStatus.PUBLISHED,
		startTime: dhakaDateAtHour(tomorrow, 19),
		endTime: dhakaDateAtHour(tomorrow, 20),
		reason: "Planned evening peak load shedding",
		cancelReason: null,
	};

	await prisma.schedule.upsert({
		where: { id: seedId(101) },
		update: upcoming,
		create: {
			...upcoming,
			id: seedId(101),
			feederId: feederIds["FD-DHN-01"],
			createdById: admin.id,
		},
	});

	// ── Outage history (resolved, feeds MTTR / SAIFI / SAIDI) ───────────────
	for (const outage of RESOLVED_OUTAGES) {
		const startedAt = dhakaDateAtHour(
			toDhakaDateString(addDays(now, -outage.daysAgo)),
			14,
		);
		const assignedAt = addMinutes(startedAt, 10);
		const inProgressAt = addMinutes(startedAt, 25);
		const resolvedAt = addMinutes(startedAt, outage.durationMinutes);
		const reporterId = outage.reporter ? customerIds[outage.reporter] : null;
		const reporter = customers.find(({ email }) => email === outage.reporter);

		await prisma.outage.upsert({
			where: { id: seedId(200 + outage.n) },
			update: {},
			create: {
				id: seedId(200 + outage.n),
				status: OutageStatus.RESOLVED,
				priority: outage.priority,
				description: outage.description,
				reportCount: reporterId ? 1 : 0,
				startedAt,
				assignedAt,
				resolvedAt,
				durationMinutes: outage.durationMinutes,
				resolutionNote: outage.resolutionNote,
				createdAt: startedAt,
				feederId: feederIds[outage.feeder],
				technicianId: technicianIds[outage.technician],
				timeline: {
					create: [
						{
							toStatus: OutageStatus.REPORTED,
							note: outage.description,
							createdAt: startedAt,
							changedById: admin.id,
						},
						{
							fromStatus: OutageStatus.REPORTED,
							toStatus: OutageStatus.ASSIGNED,
							note: "Technician assigned",
							createdAt: assignedAt,
							changedById: admin.id,
						},
						{
							fromStatus: OutageStatus.ASSIGNED,
							toStatus: OutageStatus.IN_PROGRESS,
							note: "Crew on site",
							createdAt: inProgressAt,
						},
						{
							fromStatus: OutageStatus.IN_PROGRESS,
							toStatus: OutageStatus.RESOLVED,
							note: outage.resolutionNote,
							createdAt: resolvedAt,
						},
					],
				},
				reports:
					reporterId && reporter
						? {
								create: {
									status: ReportStatus.RESOLVED,
									description: "No electricity in our building",
									createdAt: startedAt,
									customerId: reporterId,
									areaId: areaIds[reporter.area],
								},
							}
						: undefined,
			},
		});
	}

	// ── One open outage, waiting for the admin to assign a technician ───────
	const reportedAt = addMinutes(now, -40);

	await prisma.outage.upsert({
		where: { id: seedId(205) },
		update: {},
		create: {
			id: seedId(205),
			status: OutageStatus.REPORTED,
			priority: OutagePriority.HIGH,
			description: "Sparking at the pole-mounted transformer in Sector 1",
			startedAt: reportedAt,
			createdAt: reportedAt,
			feederId: feederIds["FD-UTT-02"],
			timeline: {
				create: {
					toStatus: OutageStatus.REPORTED,
					note: "Incident logged by the control room",
					createdAt: reportedAt,
					changedById: admin.id,
				},
			},
		},
	});

	// ── One unpaid bill per demo customer (only if they have none yet) ──────
	const currentMonth = toDhakaMonthString(now);
	const billingMonth = toDhakaMonthString(
		addDays(dhakaMonthRange(currentMonth).start, -1),
	);

	for (const customer of customers) {
		const customerId = customerIds[customer.email];

		if (!customerId) {
			continue;
		}

		const existingBill = await prisma.bill.findFirst({
			where: { customerId },
			select: { id: true },
		});

		if (existingBill) {
			continue;
		}

		const { previousReading, currentReading, issuedDaysAgo } = customer.bill;
		const unitsConsumed = currentReading - previousReading;
		const amounts = calculateBill({
			unitsConsumed,
			connectionType: customer.connectionType,
			sanctionedLoadKW: customer.sanctionedLoadKW,
		});
		const issuedAt = addDays(now, -issuedDaysAgo);

		await prisma.bill.create({
			data: {
				billNumber: generateBillNumber(billingMonth),
				billingMonth,
				previousReading,
				currentReading,
				unitsConsumed,
				energyCharge: paisaToTaka(amounts.energyPaisa),
				demandCharge: paisaToTaka(amounts.demandPaisa),
				vatAmount: paisaToTaka(amounts.vatPaisa),
				totalAmount: paisaToTaka(amounts.totalPaisa),
				dueDate: addDays(issuedAt, BILL_DUE_DAYS),
				status: BillStatus.UNPAID,
				createdAt: issuedAt,
				customerId,
				issuedById: admin.id,
			},
		});
	}

	const [users, feeders, areas, schedules, outages, bills] = await Promise.all([
		prisma.user.count(),
		prisma.feeder.count(),
		prisma.area.count(),
		prisma.schedule.count(),
		prisma.outage.count(),
		prisma.bill.count(),
	]);

	console.log("Seed complete:");
	console.log(
		`  ${ZONES.length} zones, ${SUBSTATIONS.length} substations, ${feeders} feeders, ${areas} areas`,
	);
	console.log(
		`  ${users} users, ${schedules} schedules, ${outages} outages, ${bills} bills`,
	);
	console.log(`  Dhaka date: ${today}`);
	console.log("Demo accounts:");
	console.log(`  admin       ${config.admin_email} (password: ADMIN_PASSWORD)`);
	console.log(
		`  technician  tech.north@enerza.com / tech.south@enerza.com (password: ${DEMO_PASSWORD})`,
	);
	console.log(
		`  customer    customer1@enerza.com / customer2@enerza.com (password: ${DEMO_PASSWORD})`,
	);
};

main()
	.catch((error) => {
		console.error("Seed failed:", error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
