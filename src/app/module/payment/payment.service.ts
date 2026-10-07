import httpStatus from "http-status";
import {
	AuditAction,
	BillStatus,
	PaymentStatus,
} from "../../../generated/prisma/enums";
import {
	BKASH_SUCCESS_CODE,
	createBkashPayment,
	type TBkashCreateResponse,
} from "../../lib/bkash";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { createAuditLog } from "../../utils/auditLog";
import type { IInitiatePaymentPayload } from "./payment.interface";
import { generateInvoiceNumber } from "./payment.utils";

// Customer starts a bKash checkout for one of their own unpaid bills.
//   1. transaction: expire older attempts, create a PENDING payment
//   2. no transaction: ask bKash for a checkout session
//   3. save the bKash payment id, or mark the attempt FAILED
const initiatePayment = async (
	payload: IInitiatePaymentPayload,
	user: RequestUser,
	ip?: string,
) => {
	const { billId } = payload;
	const actor = { userId: user.userId, role: user.role };

	const customer = await prisma.customer.findUnique({
		where: { userId: user.userId },
		select: { id: true, meterNumber: true },
	});

	if (!customer) {
		throw new AppError(httpStatus.NOT_FOUND, "Customer profile not found");
	}

	const payment = await prisma.$transaction(async (tx) => {
		// Two "pay" clicks on the same bill run one after the other, so only
		// the later attempt is left PENDING.
		await tx.$queryRaw`
			SELECT id FROM "bills" WHERE id = ${billId} FOR UPDATE`;

		// Someone else's bill looks exactly like a bill that does not exist.
		const bill = await tx.bill.findFirst({
			where: { id: billId, customerId: customer.id },
			select: {
				id: true,
				billNumber: true,
				billingMonth: true,
				totalAmount: true,
				status: true,
			},
		});

		if (!bill) {
			throw new AppError(httpStatus.NOT_FOUND, "Bill not found", [
				{ path: "billId", message: "Bill not found" },
			]);
		}

		if (bill.status !== BillStatus.UNPAID) {
			throw new AppError(
				httpStatus.CONFLICT,
				`Bill ${bill.billNumber} is already ${bill.status === BillStatus.PAID ? "paid" : "cancelled"}`,
				[{ path: "billId", message: `Bill is ${bill.status}` }],
			);
		}

		await tx.payment.updateMany({
			where: { billId, status: PaymentStatus.PENDING },
			data: { status: PaymentStatus.EXPIRED },
		});

		const created = await tx.payment.create({
			data: {
				amount: bill.totalAmount,
				invoiceNumber: generateInvoiceNumber(),
				billId,
				customerId: customer.id,
			},
			select: { id: true, invoiceNumber: true, currency: true },
		});

		return {
			...created,
			amount: bill.totalAmount.toFixed(2),
			bill: {
				id: bill.id,
				billNumber: bill.billNumber,
				billingMonth: bill.billingMonth,
			},
		};
	});

	let gateway: TBkashCreateResponse | undefined;
	let gatewayError: AppError | undefined;

	try {
		gateway = await createBkashPayment({
			amount: payment.amount,
			invoiceNumber: payment.invoiceNumber,
			payerReference: customer.meterNumber ?? customer.id,
		});
	} catch (error) {
		gatewayError =
			error instanceof AppError
				? error
				: new AppError(httpStatus.BAD_GATEWAY, "Could not reach bKash");
	}

	const { paymentID, bkashURL } = gateway ?? {};

	if (
		!gateway ||
		gateway.statusCode !== BKASH_SUCCESS_CODE ||
		!paymentID ||
		!bkashURL
	) {
		const reason =
			gateway?.statusMessage ??
			gateway?.errorMessage ??
			gatewayError?.message ??
			"No payment session was returned";

		await prisma.$transaction(async (tx) => {
			const failed = await tx.payment.updateMany({
				where: { id: payment.id, status: PaymentStatus.PENDING },
				data: { status: PaymentStatus.FAILED, gatewayResponse: gateway },
			});

			if (failed.count === 1) {
				await createAuditLog(tx, {
					actor,
					action: AuditAction.PAYMENT_FAILED,
					entityType: "Payment",
					entityId: payment.id,
					before: { status: PaymentStatus.PENDING },
					after: {
						status: PaymentStatus.FAILED,
						stage: "INITIATE",
						reason,
						invoiceNumber: payment.invoiceNumber,
						billId,
					},
					ip,
				});
			}
		});

		throw new AppError(
			httpStatus.BAD_GATEWAY,
			`bKash could not start the payment: ${reason}`,
		);
	}

	await prisma.payment.update({
		where: { id: payment.id },
		data: { bkashPaymentId: paymentID, gatewayResponse: gateway },
	});

	return {
		paymentId: payment.id,
		paymentUrl: bkashURL,
		bkashPaymentId: paymentID,
		invoiceNumber: payment.invoiceNumber,
		amount: payment.amount,
		currency: payment.currency,
		status: PaymentStatus.PENDING,
		bill: payment.bill,
	};
};

export const PaymentServices = {
	initiatePayment,
};
