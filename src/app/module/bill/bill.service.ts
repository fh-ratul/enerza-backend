import httpStatus from "http-status";
import { AuditAction, BillStatus, Role } from "../../../generated/prisma/enums";
import type {
	BillSelect,
	BillWhereInput,
} from "../../../generated/prisma/models";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { createAuditLog } from "../../utils/auditLog";
import { CACHE_KEYS, cacheDel } from "../../utils/cache";
import { buildMeta, paginationHelper } from "../../utils/paginationHelper";
import { addDays, toDhakaMonthString } from "../../utils/time";
import { BILL_DUE_DAYS, BILL_SORTABLE_FIELDS } from "./bill.constant";
import type { IBillListQuery, ICreateBillPayload } from "./bill.interface";
import {
	calculateBill,
	generateBillNumber,
	isBillOverdue,
	paisaToTaka,
} from "./bill.utils";

const billSelect = {
	id: true,
	billNumber: true,
	billingMonth: true,
	previousReading: true,
	currentReading: true,
	unitsConsumed: true,
	energyCharge: true,
	demandCharge: true,
	vatAmount: true,
	totalAmount: true,
	dueDate: true,
	status: true,
	paidAt: true,
	createdAt: true,
	updatedAt: true,
	customer: {
		select: {
			id: true,
			meterNumber: true,
			connectionType: true,
			user: { select: { id: true, name: true, email: true } },
		},
	},
} satisfies BillSelect;

type TBillAmounts = Record<
	"energyCharge" | "demandCharge" | "vatAmount" | "totalAmount",
	{ toFixed(decimals: number): string }
> & { status: BillStatus; dueDate: Date };

// Amounts always go out with two decimals ("1845.90", not "1845.9"), next to
// the computed overdue flag.
const presentBill = <T extends TBillAmounts>(bill: T, now: Date) => ({
	...bill,
	energyCharge: bill.energyCharge.toFixed(2),
	demandCharge: bill.demandCharge.toFixed(2),
	vatAmount: bill.vatAmount.toFixed(2),
	totalAmount: bill.totalAmount.toFixed(2),
	isOverdue: isBillOverdue(bill, now),
});

// Admin issues the bill for one customer and one month. Consumption is the
// new meter reading minus the reading the previous bill ended on.
const createBill = async (
	payload: ICreateBillPayload,
	user: RequestUser,
	ip?: string,
) => {
	const { customerId, billingMonth, currentReading } = payload;
	const now = new Date();

	if (billingMonth > toDhakaMonthString(now)) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"A bill cannot be issued for a month that has not started yet",
			[{ path: "billingMonth", message: "Must not be in the future" }],
		);
	}

	const bill = await prisma.$transaction(async (tx) => {
		// Two bills for one customer are worked out one after the other, so
		// both cannot start from the same lastReading.
		await tx.$queryRaw`
			SELECT id FROM "customers" WHERE id = ${customerId} FOR UPDATE`;

		const customer = await tx.customer.findFirst({
			where: { id: customerId, user: { isDeleted: false } },
			select: {
				id: true,
				meterNumber: true,
				connectionType: true,
				sanctionedLoadKW: true,
				lastReading: true,
			},
		});

		if (!customer) {
			throw new AppError(httpStatus.NOT_FOUND, "Customer not found", [
				{ path: "customerId", message: "Customer not found" },
			]);
		}

		if (!customer.meterNumber) {
			throw new AppError(
				httpStatus.BAD_REQUEST,
				"This customer has no meter number yet, so there is nothing to bill",
				[{ path: "customerId", message: "Customer profile is incomplete" }],
			);
		}

		const latestBill = await tx.bill.findFirst({
			where: { customerId },
			orderBy: { billingMonth: "desc" },
			select: { billingMonth: true, billNumber: true },
		});

		if (latestBill?.billingMonth === billingMonth) {
			throw new AppError(
				httpStatus.CONFLICT,
				`A bill for ${billingMonth} has already been issued to this customer (${latestBill.billNumber})`,
				[{ path: "billingMonth", message: "Already billed" }],
			);
		}

		// Readings only go forward, so months are billed in order.
		if (latestBill && latestBill.billingMonth > billingMonth) {
			throw new AppError(
				httpStatus.BAD_REQUEST,
				`This customer is already billed up to ${latestBill.billingMonth}. An earlier month cannot be billed now`,
				[{ path: "billingMonth", message: "Earlier than the latest bill" }],
			);
		}

		if (currentReading < customer.lastReading) {
			throw new AppError(
				httpStatus.BAD_REQUEST,
				`currentReading cannot be lower than the last reading (${customer.lastReading})`,
				[
					{
						path: "currentReading",
						message: `Must be at least ${customer.lastReading}`,
					},
				],
			);
		}

		const unitsConsumed = currentReading - customer.lastReading;
		const amounts = calculateBill({
			unitsConsumed,
			connectionType: customer.connectionType,
			sanctionedLoadKW: Number(customer.sanctionedLoadKW),
		});

		const created = await tx.bill.create({
			data: {
				billNumber: generateBillNumber(billingMonth),
				billingMonth,
				previousReading: customer.lastReading,
				currentReading,
				unitsConsumed,
				energyCharge: paisaToTaka(amounts.energyPaisa),
				demandCharge: paisaToTaka(amounts.demandPaisa),
				vatAmount: paisaToTaka(amounts.vatPaisa),
				totalAmount: paisaToTaka(amounts.totalPaisa),
				dueDate: addDays(now, BILL_DUE_DAYS),
				customerId,
				issuedById: user.userId,
			},
			select: billSelect,
		});

		await tx.customer.update({
			where: { id: customerId },
			data: { lastReading: currentReading },
		});

		await createAuditLog(tx, {
			actor: { userId: user.userId, role: user.role },
			action: AuditAction.CREATE,
			entityType: "Bill",
			entityId: created.id,
			after: {
				billNumber: created.billNumber,
				customerId,
				billingMonth,
				previousReading: customer.lastReading,
				currentReading,
				unitsConsumed,
				totalAmount: paisaToTaka(amounts.totalPaisa),
			},
			ip,
		});

		return created;
	});

	// Billed and outstanding totals on the dashboard have changed.
	await cacheDel(CACHE_KEYS.adminStats);

	return presentBill(bill, now);
};

// Admin: every bill. Customer: their own. Each bill carries its payment
// attempts, which is how a customer follows the status of a payment.
const getBills = async (query: IBillListQuery, user: RequestUser) => {
	const { page, limit, skip, sortBy, sortOrder } = paginationHelper(
		query,
		BILL_SORTABLE_FIELDS,
	);

	const now = new Date();
	const andConditions: BillWhereInput[] = [];
	const overdueWhere: BillWhereInput = {
		status: BillStatus.UNPAID,
		dueDate: { lt: now },
	};

	if (user.role === Role.CUSTOMER) {
		andConditions.push({ customer: { userId: user.userId } });
	} else if (query.customerId) {
		andConditions.push({ customerId: query.customerId });
	}

	if (query.status) {
		andConditions.push({ status: query.status });
	}

	if (query.billingMonth) {
		andConditions.push({ billingMonth: query.billingMonth });
	}

	if (query.overdue !== undefined) {
		andConditions.push(query.overdue ? overdueWhere : { NOT: overdueWhere });
	}

	const where: BillWhereInput = { AND: andConditions };

	const [bills, total] = await prisma.$transaction([
		prisma.bill.findMany({
			where,
			skip,
			take: limit,
			orderBy: [{ [sortBy]: sortOrder }, { id: "asc" }],
			select: {
				...billSelect,
				payments: {
					orderBy: { createdAt: "desc" },
					select: {
						id: true,
						status: true,
						amount: true,
						currency: true,
						invoiceNumber: true,
						bkashTrxId: true,
						paidAt: true,
						createdAt: true,
					},
				},
			},
		}),
		prisma.bill.count({ where }),
	]);

	return {
		data: bills.map(({ payments, ...bill }) => ({
			...presentBill(bill, now),
			payments: payments.map((payment) => ({
				...payment,
				amount: payment.amount.toFixed(2),
			})),
		})),
		meta: buildMeta(page, limit, total),
	};
};

export const BillServices = {
	createBill,
	getBills,
};
