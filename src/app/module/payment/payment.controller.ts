import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { RequestUser } from "../../middleware/checkAuth";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import type { IBkashCallbackQuery } from "./payment.interface";
import { PaymentServices } from "./payment.service";

const initiatePayment = catchAsync(async (req: Request, res: Response) => {
	const result = await PaymentServices.initiatePayment(
		req.body,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		statusCode: httpStatus.CREATED,
		success: true,
		message: "Payment initiated. Open paymentUrl to pay with bKash",
		data: result,
	});
});

const handleBkashCallback = catchAsync(async (req: Request, res: Response) => {
	const { message, payment } = await PaymentServices.handleBkashCallback(
		req.query as IBkashCallbackQuery,
		req.ip,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message,
		data: payment,
	});
});

export const PaymentController = {
	initiatePayment,
	handleBkashCallback,
};
