import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { RequestUser } from "../../middleware/checkAuth";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import type { IBillListQuery } from "./bill.interface";
import { BillServices } from "./bill.service";

const createBill = catchAsync(async (req: Request, res: Response) => {
	const result = await BillServices.createBill(
		req.body,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		statusCode: httpStatus.CREATED,
		success: true,
		message: "Bill issued successfully",
		data: result,
	});
});

const getBills = catchAsync(async (req: Request, res: Response) => {
	const { data, meta } = await BillServices.getBills(
		req.query as IBillListQuery,
		req.user as RequestUser,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Bills retrieved successfully",
		data,
		meta,
	});
});

export const BillController = {
	createBill,
	getBills,
};
